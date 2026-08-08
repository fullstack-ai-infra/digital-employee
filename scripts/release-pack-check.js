#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DISTRIBUTION_MANIFEST_PATH,
  DISTRIBUTION_SCHEMA_VERSION,
  computeDistributionFileSetDigest,
  validateCandidateFileSet
} from "./distribution-policy.js";

const execFileAsync = promisify(execFile);

const PACKAGE_SPECS = [
  {
    label: "root",
    manifestPath: "package.json",
    requiredFiles: [
      "package.json",
      "dist/apps/cli/bin.js",
      "dist/packages/core/index.js",
      "dist/packages/core/index.d.ts",
      DISTRIBUTION_MANIFEST_PATH,
      "dist/examples/recipes/minimal-answer.v1/minimal-answer/employee.json",
      "dist/examples/recipes/minimal-answer.v1/minimal-answer/SKILL.md",
      "dist/examples/recipes/minimal-answer.v1/minimal-answer/evals/cases.json",
      "dist/examples/recipes/minimal-answer.v1/minimal-answer/knowledge/README.md",
      "dist/examples/recipes/minimal-answer.v1/minimal-answer/schemas/input.schema.json",
      "dist/examples/recipes/minimal-answer.v1/minimal-answer/schemas/output.schema.json",
      "dist/examples/recipes/structured-action.v1/structured-action/employee.json",
      "dist/examples/recipes/structured-action.v1/structured-action/SKILL.md",
      "dist/examples/recipes/structured-action.v1/structured-action/evals/cases.json",
      "dist/examples/recipes/structured-action.v1/structured-action/knowledge/README.md",
      "dist/examples/recipes/structured-action.v1/structured-action/schemas/input.schema.json",
      "dist/examples/recipes/structured-action.v1/structured-action/schemas/output.schema.json",
      "dist/locales/en.json",
      "dist/locales/ja.json",
      "dist/locales/zh-CN.json"
    ],
    allowedFiles: ["package.json", "LICENSE", "NOTICE"],
    allowedPrefixes: ["dist/"],
    allowedPatterns: [/^README[^/]*\.md$/]
  },
  {
    label: "core",
    manifestPath: "packages/core/package.json",
    requiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"],
    allowedFiles: ["package.json"],
    allowedPrefixes: ["dist/"],
    allowedPatterns: []
  }
];

function expectedFilename(manifest) {
  const packageSlug = String(manifest.name || "")
    .replace(/^@/, "")
    .replaceAll("/", "-");
  return `${packageSlug}-${manifest.version}.tgz`;
}

export function validateDistributionManifest(manifest, packageManifest) {
  const violations = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [{ code: "DISTRIBUTION_MANIFEST_INVALID" }];
  }
  if (manifest.schemaVersion !== DISTRIBUTION_SCHEMA_VERSION) {
    violations.push({ code: "DISTRIBUTION_MANIFEST_INVALID", field: "schemaVersion" });
  }
  if (
    manifest.package?.name !== packageManifest.name ||
    manifest.package?.version !== packageManifest.version
  ) {
    violations.push({ code: "DISTRIBUTION_MANIFEST_IDENTITY_MISMATCH" });
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.source?.gitCommit ?? "") || manifest.source?.dirty !== false) {
    violations.push({ code: "DISTRIBUTION_MANIFEST_SOURCE_INVALID" });
  }
  if (
    typeof manifest.toolchain?.node !== "string" ||
    typeof manifest.toolchain?.npm !== "string" ||
    typeof manifest.toolchain?.typescript !== "string"
  ) {
    violations.push({ code: "DISTRIBUTION_MANIFEST_TOOLCHAIN_INVALID" });
  }
  if (
    manifest.digestAlgorithm !== "sha256" ||
    manifest.manifestPath !== DISTRIBUTION_MANIFEST_PATH ||
    manifest.manifestDigestExcluded !== true ||
    !Array.isArray(manifest.files)
  ) {
    violations.push({ code: "DISTRIBUTION_MANIFEST_INVALID" });
    return violations;
  }
  const seen = new Set();
  let previous = "";
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[0-9a-f]{64}$/.test(file.sha256 ?? "") ||
      file.path === DISTRIBUTION_MANIFEST_PATH ||
      (previous && previous.localeCompare(file.path, "en") >= 0) ||
      seen.has(file.path)
    ) {
      violations.push({ code: "DISTRIBUTION_MANIFEST_FILE_INVALID", path: file?.path });
    }
    seen.add(file?.path);
    previous = file?.path ?? previous;
  }
  if (computeDistributionFileSetDigest(manifest.files) !== manifest.fileSetDigest) {
    violations.push({ code: "DISTRIBUTION_MANIFEST_DIGEST_INVALID" });
  }
  return violations;
}

async function archiveManifest(archivePath) {
  const { stdout } = await execFileAsync("tar", [
    "-xOzf",
    archivePath,
    `package/${DISTRIBUTION_MANIFEST_PATH}`
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export function validateArchiveIntegrity(bytes, pack) {
  const violations = [];
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (pack?.shasum !== sha1) {
    violations.push({ code: "DISTRIBUTION_ARCHIVE_SHASUM_MISMATCH" });
  }
  if (pack?.integrity !== integrity) {
    violations.push({ code: "DISTRIBUTION_ARCHIVE_INTEGRITY_MISMATCH" });
  }
  return violations;
}

async function walkExtractedFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkExtractedFiles(absolute, relative));
    else files.push(relative);
  }
  return files;
}

export async function validateRootArchive({ archivePath, pack, packageManifest }) {
  const archiveBytes = await readFile(archivePath);
  const integrityViolations = validateArchiveIntegrity(archiveBytes, pack);
  if (integrityViolations.length) return { violations: integrityViolations };

  let artifactManifest;
  try {
    artifactManifest = await archiveManifest(archivePath);
  } catch {
    return {
      violations: [{ code: "DISTRIBUTION_MANIFEST_MISSING", path: DISTRIBUTION_MANIFEST_PATH }]
    };
  }
  const violations = validateDistributionManifest(artifactManifest, packageManifest);
  if (violations.length) return { violations };

  const expectedFiles = [
    ...artifactManifest.files.map((file) => file.path),
    DISTRIBUTION_MANIFEST_PATH
  ];
  violations.push(...validateCandidateFileSet(
    expectedFiles,
    pack.files.map((file) => file.path)
  ));
  if (violations.length) return { violations };

  const temporary = await mkdtemp(path.join(os.tmpdir(), "digital-employee-pack-"));
  try {
    const { stdout: archiveListing } = await execFileAsync("tar", ["-tzf", archivePath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    const unsafeArchivePath = archiveListing.split("\n").filter(Boolean).find((entry) => {
      const segments = entry.split("/");
      return !entry.startsWith("package/") ||
        entry.includes("\\") ||
        segments.includes("..") ||
        path.posix.isAbsolute(entry);
    });
    if (unsafeArchivePath) {
      return {
        violations: [{ code: "DISTRIBUTION_ARCHIVE_PATH_INVALID", path: unsafeArchivePath }]
      };
    }
    await execFileAsync("tar", ["-xzf", archivePath, "-C", temporary]);
    const packageRoot = path.join(temporary, "package");
    const extractedFiles = await walkExtractedFiles(packageRoot);
    violations.push(...validateCandidateFileSet(expectedFiles, extractedFiles));
    if (violations.length) return { violations };
    const expectedByPath = new Map(artifactManifest.files.map((file) => [file.path, file]));
    for (const [filePath, expected] of expectedByPath) {
      const bytes = await readFile(path.join(packageRoot, filePath));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== expected.size || digest !== expected.sha256) {
        violations.push({ code: "DISTRIBUTION_FILE_DIGEST_MISMATCH", path: filePath });
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    violations,
    summary: {
      sourceSha: artifactManifest.source.gitCommit,
      fileCount: artifactManifest.files.length,
      fileSetDigest: artifactManifest.fileSetDigest,
      toolchain: artifactManifest.toolchain
    }
  };
}

export function validatePackOutput({
  label,
  manifest,
  output,
  requiredFiles,
  allowedFiles,
  allowedPrefixes,
  allowedPatterns
}) {
  if (!Array.isArray(output) || output.length !== 1) {
    return [`${label} npm pack output must contain exactly one package`];
  }

  const errors = [];
  const [pack] = output;
  if (pack?.name !== manifest.name) {
    errors.push(`${label} npm pack name must match package.json`);
  }
  if (pack?.version !== manifest.version) {
    errors.push(`${label} npm pack version must match package.json`);
  }
  if (pack?.filename !== expectedFilename(manifest)) {
    errors.push(`${label} npm pack filename is unexpected`);
  }

  if (!Array.isArray(pack?.files) || pack.files.some((file) =>
    typeof file?.path !== "string"
  )) {
    errors.push(`${label} npm pack files must contain path entries`);
    return errors;
  }

  const packedFiles = new Set(pack.files.map((file) => file.path));
  for (const requiredFile of requiredFiles) {
    if (!packedFiles.has(requiredFile)) {
      errors.push(`${label} npm pack is missing ${requiredFile}`);
    }
  }
  for (const packedFile of packedFiles) {
    const allowed = allowedFiles.includes(packedFile) ||
      allowedPrefixes.some((prefix) => packedFile.startsWith(prefix)) ||
      allowedPatterns.some((pattern) => pattern.test(packedFile));
    if (!allowed) {
      errors.push(`${label} npm pack includes unexpected ${packedFile}`);
    }
  }
  return errors;
}

async function validateArchive({ label, manifest, packDestination }) {
  try {
    const archive = await stat(
      path.join(packDestination, expectedFilename(manifest))
    );
    if (archive.isFile() && archive.size > 0) return [];
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return [`${label} npm pack archive is missing or empty`];
}

async function main() {
  const [packDestination, ...outputPaths] = process.argv.slice(2);
  if (!packDestination || outputPaths.length !== PACKAGE_SPECS.length) {
    throw new TypeError(
      "usage: release-pack-check.js <pack-directory> <root-pack.json> <core-pack.json>"
    );
  }

  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const errors = [];
  let rootVerification;
  for (const [index, spec] of PACKAGE_SPECS.entries()) {
    const [manifestText, outputText] = await Promise.all([
      readFile(path.join(repositoryRoot, spec.manifestPath), "utf8"),
      readFile(outputPaths[index], "utf8")
    ]);
    const manifest = JSON.parse(manifestText);
    const output = JSON.parse(outputText);
    errors.push(...validatePackOutput({
      label: spec.label,
      manifest,
      output,
      requiredFiles: spec.requiredFiles,
      allowedFiles: spec.allowedFiles,
      allowedPrefixes: spec.allowedPrefixes,
      allowedPatterns: spec.allowedPatterns
    }));
    const archiveErrors = await validateArchive({
      label: spec.label,
      manifest,
      packDestination
    });
    errors.push(...archiveErrors);
    if (index === 0 && archiveErrors.length === 0 && Array.isArray(output) && output.length === 1) {
      rootVerification = await validateRootArchive({
        archivePath: path.join(packDestination, expectedFilename(manifest)),
        pack: output[0],
        packageManifest: manifest
      });
    }
  }
  if (rootVerification) errors.push(...rootVerification.violations);

  if (errors.length) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: "distribution-verification-result.v1",
      status: "failed",
      violations: errors.map((error) => typeof error === "string"
        ? { code: "PACKAGE_ARCHIVE_INVALID", message: error }
        : error)
    })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "distribution-verification-result.v1",
    status: "passed",
    packages: ["root", "core"],
    artifact: rootVerification?.summary
  })}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `release-pack-check: ${error?.message || "unexpected_error"}\n`
    );
    process.exitCode = 2;
  });
}
