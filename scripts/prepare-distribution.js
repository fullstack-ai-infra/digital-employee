#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISTRIBUTION_MANIFEST_PATH,
  DISTRIBUTION_SCHEMA_VERSION,
  computeDistributionFileSetDigest,
  expectedDistributionFiles,
  validateCandidateFileSet
} from "./distribution-policy.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function walkFiles(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const absolute = path.join(directory, entry.name);
    const portable = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      files.push(portable);
    } else if (entry.isDirectory()) {
      files.push(...await walkFiles(absolute, portable));
    } else {
      files.push(portable);
    }
  }
  return files;
}

function npmVersion() {
  const userAgent = process.env.npm_config_user_agent ?? "";
  const match = /(?:^|\s)npm\/([^\s]+)/.exec(userAgent);
  if (match?.[1]) return match[1];
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], {
    encoding: "utf8"
  }).trim();
}

function fail(violations) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: "distribution-verification-result.v1",
    status: "failed",
    violations
  })}\n`);
  process.exitCode = 1;
}

async function main() {
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty) {
    fail([{ code: "DISTRIBUTION_SOURCE_DIRTY" }]);
    return;
  }

  const sourceSha = git(["rev-parse", "HEAD"]);
  const sourceFiles = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const expectedFiles = expectedDistributionFiles(sourceFiles);
  const actualFiles = [
    ...expectedFiles.filter((file) => !file.startsWith("dist/")),
    ...await walkFiles(path.join(repositoryRoot, "dist"), "dist")
  ];
  const violations = validateCandidateFileSet(expectedFiles, actualFiles);
  if (violations.length) {
    fail(violations);
    return;
  }

  const files = [];
  for (const file of expectedFiles) {
    const absolute = path.join(repositoryRoot, file);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      violations.push({ code: "DISTRIBUTION_FILE_NOT_REGULAR", path: file });
      continue;
    }
    const bytes = await readFile(absolute);
    files.push({
      path: file,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  if (violations.length) {
    fail(violations);
    return;
  }

  const packageManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const typescriptManifest = JSON.parse(await readFile(
    path.join(repositoryRoot, "node_modules", "typescript", "package.json"),
    "utf8"
  ));
  const manifest = {
    schemaVersion: DISTRIBUTION_SCHEMA_VERSION,
    package: {
      name: packageManifest.name,
      version: packageManifest.version
    },
    source: {
      gitCommit: sourceSha,
      dirty: false
    },
    toolchain: {
      node: process.version,
      npm: npmVersion(),
      typescript: typescriptManifest.version
    },
    digestAlgorithm: "sha256",
    manifestPath: DISTRIBUTION_MANIFEST_PATH,
    manifestDigestExcluded: true,
    fileSetDigest: computeDistributionFileSetDigest(files),
    files
  };
  const destination = path.join(repositoryRoot, DISTRIBUTION_MANIFEST_PATH);
  const temporary = `${destination}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
    flag: "wx"
  });
  await rename(temporary, destination);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "distribution-prepare-result.v1",
    status: "passed",
    sourceSha,
    fileCount: files.length,
    fileSetDigest: manifest.fileSetDigest
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: "distribution-verification-result.v1",
    status: "failed",
    violations: [{ code: "DISTRIBUTION_PREPARE_FAILED" }]
  })}\n`);
  if (process.env.DEBUG_DISTRIBUTION === "1") {
    process.stderr.write(`${String(error?.stack || error)}\n`);
  }
  process.exitCode = 2;
});
