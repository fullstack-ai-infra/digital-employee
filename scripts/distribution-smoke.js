#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    timeout: 120_000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `distribution_smoke_command_failed:${path.basename(command)}:${result.status}\n` +
      `${result.stdout || ""}${result.stderr || ""}`
    );
  }
  return result.stdout;
}

function parseJsonOutput(command, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError(`distribution_smoke_invalid_json:${command}`);
  }
}

async function main() {
  const archiveArgument = process.argv[2];
  if (!archiveArgument) {
    throw new TypeError("usage: distribution-smoke.js <package.tgz>");
  }
  const archive = path.resolve(archiveArgument);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "digital-employee-consumer-"));
  try {
    const consumer = path.join(temporaryRoot, "consumer");
    const npmCache = path.join(temporaryRoot, "npm-cache");
    await mkdir(consumer);
    await writeFile(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      { mode: 0o600 }
    );
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    run(npmCommand, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      npmCache,
      archive
    ], { cwd: consumer });

    const installedManifest = JSON.parse(await readFile(
      path.join(
        consumer,
        "node_modules",
        "@fullstack-ai-infra",
        "digital-employee",
        "package.json"
      ),
      "utf8"
    ));
    const cli = path.join(
      consumer,
      "node_modules",
      "@fullstack-ai-infra",
      "digital-employee",
      "dist",
      "apps",
      "cli",
      "bin.js"
    );
    run(process.execPath, [cli, "--help"], { cwd: consumer });

    const recipes = [];
    for (const recipe of ["minimal-answer.v1", "structured-action.v1"]) {
      const target = path.join(consumer, recipe.replace(".v1", ""));
      run(process.execPath, [
        cli,
        "init",
        target,
        "--recipe",
        recipe,
        "--json"
      ], { cwd: consumer });
      run(process.execPath, [cli, "validate", target, "--json"], { cwd: consumer });
      const evaluation = parseJsonOutput(
        "eval",
        run(process.execPath, [cli, "eval", target, "--json"], { cwd: consumer })
      );
      if (evaluation.status !== "passed" || !Array.isArray(evaluation.cases)) {
        throw new TypeError(`distribution_smoke_eval_failed:${recipe}`);
      }
      recipes.push({ recipe, caseCount: evaluation.cases.length });
    }

    process.stdout.write(`${JSON.stringify({
      schemaVersion: "distribution-consumer-smoke-result.v1",
      package: `${installedManifest.name}@${installedManifest.version}`,
      node: process.version,
      status: "passed",
      recipes
    }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: "distribution-consumer-smoke-result.v1",
    status: "failed",
    code: String(error?.message || "distribution_smoke_failed").split("\n", 1)[0]
  })}\n`);
  process.exitCode = 1;
});
