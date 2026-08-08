import { createHash } from "node:crypto";
import path from "node:path";

export const DISTRIBUTION_MANIFEST_PATH = "dist/distribution-manifest.json";
export const DISTRIBUTION_SCHEMA_VERSION = "digital-employee-distribution.v1";

export const DISTRIBUTION_ROOT_FILES = Object.freeze([
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "package.json"
]);

export const DISTRIBUTION_ASSET_MAPPINGS = Object.freeze([
  ["configs/demo.json", "dist/configs/demo.json"],
  ["configs/dingtalk-dws.example.json", "dist/configs/dingtalk-dws.example.json"],
  ["configs/employee-mcp.schema.json", "dist/configs/employee-mcp.schema.json"],
  ["configs/employee-package.schema.json", "dist/configs/employee-package.schema.json"],
  ["configs/profile.schema.json", "dist/configs/profile.schema.json"],
  ["configs/schema.json", "dist/configs/schema.json"],
  ["locales/README.md", "dist/locales/README.md"],
  ["locales/en.json", "dist/locales/en.json"],
  ["locales/ja.json", "dist/locales/ja.json"],
  ["locales/zh-CN.json", "dist/locales/zh-CN.json"],
  ["profiles/answer-agent/profile.json", "dist/profiles/answer-agent/profile.json"],
  ["tests/fixtures/knowledge/handbook.md", "dist/tests/fixtures/knowledge/handbook.md"],
  ["tests/fixtures/knowledge/release-notes.md", "dist/tests/fixtures/knowledge/release-notes.md"],
  [
    "examples/recipes/minimal-answer.v1/minimal-answer/SKILL.md",
    "dist/examples/recipes/minimal-answer.v1/minimal-answer/SKILL.md"
  ],
  [
    "examples/recipes/minimal-answer.v1/minimal-answer/employee.json",
    "dist/examples/recipes/minimal-answer.v1/minimal-answer/employee.json"
  ],
  [
    "examples/recipes/minimal-answer.v1/minimal-answer/evals/cases.json",
    "dist/examples/recipes/minimal-answer.v1/minimal-answer/evals/cases.json"
  ],
  [
    "examples/recipes/minimal-answer.v1/minimal-answer/knowledge/README.md",
    "dist/examples/recipes/minimal-answer.v1/minimal-answer/knowledge/README.md"
  ],
  [
    "examples/recipes/minimal-answer.v1/minimal-answer/schemas/input.schema.json",
    "dist/examples/recipes/minimal-answer.v1/minimal-answer/schemas/input.schema.json"
  ],
  [
    "examples/recipes/minimal-answer.v1/minimal-answer/schemas/output.schema.json",
    "dist/examples/recipes/minimal-answer.v1/minimal-answer/schemas/output.schema.json"
  ],
  [
    "examples/recipes/structured-action.v1/structured-action/SKILL.md",
    "dist/examples/recipes/structured-action.v1/structured-action/SKILL.md"
  ],
  [
    "examples/recipes/structured-action.v1/structured-action/employee.json",
    "dist/examples/recipes/structured-action.v1/structured-action/employee.json"
  ],
  [
    "examples/recipes/structured-action.v1/structured-action/evals/cases.json",
    "dist/examples/recipes/structured-action.v1/structured-action/evals/cases.json"
  ],
  [
    "examples/recipes/structured-action.v1/structured-action/knowledge/README.md",
    "dist/examples/recipes/structured-action.v1/structured-action/knowledge/README.md"
  ],
  [
    "examples/recipes/structured-action.v1/structured-action/schemas/input.schema.json",
    "dist/examples/recipes/structured-action.v1/structured-action/schemas/input.schema.json"
  ],
  [
    "examples/recipes/structured-action.v1/structured-action/schemas/output.schema.json",
    "dist/examples/recipes/structured-action.v1/structured-action/schemas/output.schema.json"
  ]
]);

const COMPILED_SOURCE_ROOTS = Object.freeze([
  "apps/",
  "connectors/",
  "packages/",
  "profiles/"
]);

const CREDENTIAL_PATH = /(?:^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|[^/]*(?:private[-_]?key|api[-_]?key|access[-_]?token|auth[-_]?token)[^/]*)/i;

export function portablePath(value) {
  return value.split(path.sep).join("/");
}

export function compiledDistributionFiles(sourceFiles) {
  const output = [];
  for (const source of sourceFiles) {
    const portable = portablePath(source);
    if (
      !COMPILED_SOURCE_ROOTS.some((root) => portable.startsWith(root)) ||
      !portable.endsWith(".ts") ||
      portable.endsWith(".d.ts")
    ) {
      continue;
    }
    const stem = `dist/${portable.slice(0, -3)}`;
    output.push(`${stem}.d.ts`, `${stem}.d.ts.map`, `${stem}.js`, `${stem}.js.map`);
  }
  return output.sort((left, right) => left.localeCompare(right, "en"));
}

export function expectedDistributionFiles(sourceFiles) {
  return [
    ...DISTRIBUTION_ROOT_FILES,
    ...compiledDistributionFiles(sourceFiles),
    ...DISTRIBUTION_ASSET_MAPPINGS.map(([, destination]) => destination)
  ].sort((left, right) => left.localeCompare(right, "en"));
}

export function credentialShapedPath(filePath) {
  return CREDENTIAL_PATH.test(portablePath(filePath));
}

export function computeDistributionFileSetDigest(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update("\0", "ascii");
    hash.update(String(file.size), "ascii");
    hash.update("\0", "ascii");
    hash.update(file.sha256, "ascii");
    hash.update("\n", "ascii");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function validateCandidateFileSet(expectedFiles, actualFiles) {
  const expected = new Set(expectedFiles);
  const actual = new Set(actualFiles);
  const violations = [];
  for (const file of [...expected].sort()) {
    if (!actual.has(file)) {
      violations.push({
        code: "DISTRIBUTION_REQUIRED_FILE_MISSING",
        path: file
      });
    }
  }
  for (const file of [...actual].sort()) {
    if (credentialShapedPath(file)) {
      violations.push({
        code: "DISTRIBUTION_CREDENTIAL_PATH_FORBIDDEN",
        path: file
      });
    } else if (!expected.has(file)) {
      violations.push({
        code: "DISTRIBUTION_UNDECLARED_FILE",
        path: file
      });
    }
  }
  return violations;
}
