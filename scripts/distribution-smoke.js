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

function runResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    timeout: 120_000
  });
  if (result.error) throw result.error;
  return result;
}

function parseJsonOutput(command, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError(`distribution_smoke_invalid_json:${command}`);
  }
}

function assertExactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(code);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(code);
  }
}

function assertEvalResult(result, expectedStatus) {
  assertExactKeys(result, [
    "schemaVersion",
    "status",
    "code",
    "employee",
    "summary",
    "cases"
  ], "distribution_smoke_eval_shape_invalid");
  assertExactKeys(result.employee, [
    "name",
    "version",
    "schemaVersion"
  ], "distribution_smoke_eval_employee_invalid");
  assertExactKeys(result.summary, [
    "total",
    "passed",
    "failed"
  ], "distribution_smoke_eval_summary_invalid");
  if (
    result.schemaVersion !== "employee-eval-result.v1alpha1" ||
    result.status !== expectedStatus ||
    !Array.isArray(result.cases) ||
    result.cases.length !== 1 ||
    result.summary.total !== 1 ||
    result.summary.passed + result.summary.failed !== 1
  ) {
    throw new TypeError("distribution_smoke_eval_contract_invalid");
  }
  for (const evalCase of result.cases) {
    assertExactKeys(evalCase, ["id", "status", "code"], "distribution_smoke_eval_case_invalid");
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
    const help = run(process.execPath, [cli, "--help"], { cwd: consumer });
    for (const requiredHelp of [
      "Agent-native usage:",
      "digital-employee init",
      "digital-employee validate",
      "digital-employee eval"
    ]) {
      if (!help.includes(requiredHelp)) {
        throw new TypeError("distribution_smoke_help_contract_invalid");
      }
    }

    const recipes = [];
    let negativeEvalCode;
    for (const recipe of ["minimal-answer.v1", "structured-action.v1"]) {
      const target = path.join(consumer, recipe.replace(".v1", ""));
      const initialized = parseJsonOutput("init", run(process.execPath, [
        cli,
        "init",
        target,
        "--recipe",
        recipe,
        "--json"
      ], { cwd: consumer }));
      assertExactKeys(initialized, [
        "directory",
        "manifest",
        "files",
        "recipe"
      ], "distribution_smoke_init_shape_invalid");
      if (
        initialized.recipe !== recipe ||
        initialized.directory !== target ||
        !Array.isArray(initialized.files) ||
        initialized.files.length === 0 ||
        typeof initialized.manifest?.name !== "string" ||
        typeof initialized.manifest?.version !== "string" ||
        initialized.manifest?.schemaVersion !== "employee-package.v1alpha1"
      ) {
        throw new TypeError(`distribution_smoke_init_contract_invalid:${recipe}`);
      }

      const validation = parseJsonOutput(
        "validate",
        run(process.execPath, [cli, "validate", target, "--json"], { cwd: consumer })
      );
      assertExactKeys(validation, ["status", "employee", "files"], "distribution_smoke_validate_shape_invalid");
      assertExactKeys(validation.employee, [
        "name",
        "version",
        "schemaVersion"
      ], "distribution_smoke_validate_employee_invalid");
      if (
        validation.status !== "valid" ||
        validation.employee.name !== initialized.manifest.name ||
        validation.employee.version !== initialized.manifest.version ||
        validation.employee.schemaVersion !== "employee-package.v1alpha1" ||
        !Array.isArray(validation.files) ||
        initialized.files[0] !== "./employee.json" ||
        JSON.stringify(validation.files) !== JSON.stringify(initialized.files.slice(1))
      ) {
        throw new TypeError(`distribution_smoke_validate_contract_invalid:${recipe}`);
      }

      const evaluation = parseJsonOutput(
        "eval",
        run(process.execPath, [cli, "eval", target, "--json"], { cwd: consumer })
      );
      assertEvalResult(evaluation, "passed");
      if (
        evaluation.code !== "EVAL_PASSED" ||
        evaluation.summary.passed !== 1 ||
        evaluation.summary.failed !== 0 ||
        evaluation.cases[0].status !== "passed" ||
        evaluation.cases[0].code !== "EVAL_CASE_PASSED"
      ) {
        throw new TypeError(`distribution_smoke_eval_failed:${recipe}`);
      }
      recipes.push({ recipe, caseCount: evaluation.cases.length });

      if (recipe === "minimal-answer.v1") {
        const casesPath = path.join(target, "evals", "cases.json");
        const contract = JSON.parse(await readFile(casesPath, "utf8"));
        contract.cases[0].input = {};
        await writeFile(casesPath, `${JSON.stringify(contract, null, 2)}\n`);
        const failedProcess = runResult(
          process.execPath,
          [cli, "eval", target, "--json"],
          { cwd: consumer }
        );
        if (failedProcess.status !== 1 || failedProcess.stderr !== "") {
          throw new TypeError("distribution_smoke_negative_exit_invalid");
        }
        const failedEvaluation = parseJsonOutput("eval-negative", failedProcess.stdout);
        assertEvalResult(failedEvaluation, "failed");
        if (
          failedEvaluation.code !== "EVAL_CASE_INPUT_SCHEMA_INVALID" ||
          failedEvaluation.summary.passed !== 0 ||
          failedEvaluation.summary.failed !== 1 ||
          failedEvaluation.cases[0].status !== "failed" ||
          failedEvaluation.cases[0].code !== "EVAL_CASE_INPUT_SCHEMA_INVALID"
        ) {
          throw new TypeError("distribution_smoke_negative_contract_invalid");
        }
        negativeEvalCode = failedEvaluation.code;
      }
    }

    process.stdout.write(`${JSON.stringify({
      schemaVersion: "distribution-consumer-smoke-result.v1",
      package: `${installedManifest.name}@${installedManifest.version}`,
      node: process.version,
      status: "passed",
      recipes,
      machineContracts: {
        init: "exact",
        validate: "exact",
        evalSchemaVersion: "employee-eval-result.v1alpha1",
        negativeEvalCode
      }
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
