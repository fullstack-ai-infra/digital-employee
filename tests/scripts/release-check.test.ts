import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  compiledDistributionFiles,
  computeDistributionFileSetDigest,
  validateCandidateFileSet
} from "../../scripts/distribution-policy.js";
import {
  validateDistributionManifest,
  validateArchiveIntegrity,
  validatePackOutput,
  validateRootArchive
} from "../../scripts/release-pack-check.js";
import { validateRelease } from "../../scripts/release-check.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const manifest = {
  name: "@fullstack-ai-infra/digital-employee",
  version: "0.1.0",
  repository: {
    type: "git",
    url: "git+https://github.com/fullstack-ai-infra/digital-employee.git"
  },
  publishConfig: { access: "public" },
  bin: { "digital-employee": "./dist/apps/cli/bin.js" },
  types: "./dist/packages/core/index.d.ts",
  exports: {
    ".": { import: "./dist/packages/core/index.js" }
  },
  files: ["dist", "README.md", "LICENSE"]
};
const coreManifest = {
  name: "@fullstack-ai-infra/digital-employee-core",
  version: "0.1.0",
  repository: manifest.repository,
  publishConfig: { access: "public" },
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { import: "./dist/index.js" } },
  files: ["dist"]
};
const lockfile = {
  version: "0.1.0",
  packages: {
    "": { version: "0.1.0" },
    "packages/core": { version: "0.1.0" }
  }
};
const changelog = "# Changelog\n\n## [0.1.0] - 2026-08-01\n";

test("release check accepts aligned public release metadata", () => {
  assert.deepEqual(
    validateRelease({
      manifest,
      coreManifest,
      lockfile,
      changelog,
      tag: "v0.1.0"
    }),
    []
  );
});

test("release check rejects a mismatched tag and package versions", () => {
  const errors = validateRelease({
    manifest,
    coreManifest: { ...coreManifest, version: "0.0.9" },
    lockfile,
    changelog,
    tag: "v0.2.0"
  });
  assert.deepEqual(errors, [
    "release tag v0.2.0 does not match package version v0.1.0",
    "core and root package versions must match"
  ]);
});

test("release check rejects core repository drift", () => {
  const errors = validateRelease({
    manifest,
    coreManifest: {
      ...coreManifest,
      repository: {
        type: "git",
        url: "git+https://github.com/example/fork.git"
      }
    },
    lockfile,
    changelog,
    tag: "v0.1.0"
  });
  assert.deepEqual(errors, ["core repository must match root repository"]);
});

test("release check rejects private or incomplete packages", () => {
  const errors = validateRelease({
    manifest: {
      ...manifest,
      private: true,
      publishConfig: {},
      bin: {},
      files: ["packages"]
    },
    coreManifest: {
      ...coreManifest,
      private: true,
      publishConfig: {}
    },
    lockfile,
    changelog: "# Changelog\n",
    tag: "v0.1.0"
  });
  assert.deepEqual(errors, [
    "root package must be publishable",
    "publishConfig.access must be public",
    "digital-employee CLI entry point is missing",
    "published files must include compiled distribution artifacts",
    "published files must not include duplicate TypeScript source trees",
    "core package must be publishable",
    "core publishConfig.access must be public",
    "CHANGELOG.md must contain a dated 0.1.0 release heading"
  ]);
});

test("release check rejects package-lock version drift", () => {
  const errors = validateRelease({
    manifest,
    coreManifest,
    lockfile: {
      version: "0.0.9",
      packages: {
        "": { version: "0.0.9" },
        "packages/core": { version: "0.0.9" }
      }
    },
    changelog,
    tag: "v0.1.0"
  });
  assert.deepEqual(errors, [
    "package-lock version must match package version",
    "package-lock workspace root version must match package version",
    "package-lock core version must match package version"
  ]);
});

test("pack check accepts root and core package metadata", () => {
  assert.deepEqual(validatePackOutput({
    label: "root",
    manifest,
    output: [{
      name: manifest.name,
      version: manifest.version,
      filename: "fullstack-ai-infra-digital-employee-0.1.0.tgz",
      files: [
        { path: "package.json" },
        { path: "dist/apps/cli/bin.js" },
        { path: "dist/packages/core/index.js" },
        { path: "dist/packages/core/index.d.ts" }
      ]
    }],
    requiredFiles: [
      "package.json",
      "dist/apps/cli/bin.js",
      "dist/packages/core/index.js",
      "dist/packages/core/index.d.ts"
    ],
    allowedFiles: ["package.json", "LICENSE", "NOTICE"],
    allowedPrefixes: ["dist/"],
    allowedPatterns: [/^README[^/]*\.md$/]
  }), []);

  assert.deepEqual(validatePackOutput({
    label: "core",
    manifest: coreManifest,
    output: [{
      name: coreManifest.name,
      version: coreManifest.version,
      filename: "fullstack-ai-infra-digital-employee-core-0.1.0.tgz",
      files: [
        { path: "package.json" },
        { path: "dist/index.js" },
        { path: "dist/index.d.ts" }
      ]
    }],
    requiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"],
    allowedFiles: ["package.json"],
    allowedPrefixes: ["dist/"],
    allowedPatterns: []
  }), []);
});

test("pack check rejects mismatched identity and missing files", () => {
  assert.deepEqual(validatePackOutput({
    label: "core",
    manifest: coreManifest,
    output: [{
      name: manifest.name,
      version: "0.0.9",
      filename: "wrong.tgz",
      files: [{ path: "package.json" }]
    }],
    requiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"],
    allowedFiles: ["package.json"],
    allowedPrefixes: ["dist/"],
    allowedPatterns: []
  }), [
    "core npm pack name must match package.json",
    "core npm pack version must match package.json",
    "core npm pack filename is unexpected",
    "core npm pack is missing dist/index.js",
    "core npm pack is missing dist/index.d.ts"
  ]);
  assert.deepEqual(validatePackOutput({
    label: "core",
    manifest: coreManifest,
    output: [],
    requiredFiles: [],
    allowedFiles: [],
    allowedPrefixes: [],
    allowedPatterns: []
  }), ["core npm pack output must contain exactly one package"]);
});

test("pack check rejects unexpected source paths", () => {
  assert.deepEqual(validatePackOutput({
    label: "root",
    manifest,
    output: [{
      name: manifest.name,
      version: manifest.version,
      filename: "fullstack-ai-infra-digital-employee-0.1.0.tgz",
      files: [
        { path: "package.json" },
        { path: "dist/apps/cli/bin.js" },
        { path: "dist/packages/core/index.js" },
        { path: "dist/packages/core/index.d.ts" },
        { path: "packages/core/index.ts" }
      ]
    }],
    requiredFiles: [
      "package.json",
      "dist/apps/cli/bin.js",
      "dist/packages/core/index.js",
      "dist/packages/core/index.d.ts"
    ],
    allowedFiles: ["package.json", "LICENSE", "NOTICE"],
    allowedPrefixes: ["dist/"],
    allowedPatterns: [/^README[^/]*\.md$/]
  }), ["root npm pack includes unexpected packages/core/index.ts"]);
});

test("distribution policy maps only tracked runtime TypeScript outputs", () => {
  assert.deepEqual(compiledDistributionFiles([
    "apps/cli/bin.ts",
    "tests/apps/cli.test.ts",
    "types/json.d.ts"
  ]), [
    "dist/apps/cli/bin.d.ts",
    "dist/apps/cli/bin.d.ts.map",
    "dist/apps/cli/bin.js",
    "dist/apps/cli/bin.js.map"
  ]);
});

test("distribution policy rejects missing, undeclared and credential-shaped files", () => {
  const expected = [
    "dist/apps/cli/bin.js",
    "dist/examples/recipes/minimal-answer.v1/minimal-answer/employee.json",
    "dist/locales/en.json"
  ];
  assert.deepEqual(validateCandidateFileSet(expected, ["dist/apps/cli/bin.js"]), [{
    code: "DISTRIBUTION_REQUIRED_FILE_MISSING",
    path: "dist/examples/recipes/minimal-answer.v1/minimal-answer/employee.json"
  }, {
    code: "DISTRIBUTION_REQUIRED_FILE_MISSING",
    path: "dist/locales/en.json"
  }]);
  assert.deepEqual(validateCandidateFileSet(expected, [
    ...expected,
    "dist/undeclared.txt"
  ]), [{
    code: "DISTRIBUTION_UNDECLARED_FILE",
    path: "dist/undeclared.txt"
  }]);
  assert.deepEqual(validateCandidateFileSet(expected, [
    ...expected,
    "dist/config/credentials.json"
  ]), [{
    code: "DISTRIBUTION_CREDENTIAL_PATH_FORBIDDEN",
    path: "dist/config/credentials.json"
  }]);
});

test("distribution manifest binds source, toolchain and per-file digests", () => {
  const files = [{
    path: "dist/apps/cli/bin.js",
    size: 3,
    sha256: "a".repeat(64)
  }];
  const artifactManifest = {
    schemaVersion: "digital-employee-distribution.v1",
    package: { name: manifest.name, version: manifest.version },
    source: { gitCommit: "b".repeat(40), dirty: false },
    toolchain: { node: "v24.13.0", npm: "11.6.2", typescript: "7.0.2" },
    digestAlgorithm: "sha256",
    manifestPath: "dist/distribution-manifest.json",
    manifestDigestExcluded: true,
    fileSetDigest: computeDistributionFileSetDigest(files),
    files
  };
  assert.deepEqual(validateDistributionManifest(artifactManifest, manifest), []);
  assert.deepEqual(validateDistributionManifest({
    ...artifactManifest,
    fileSetDigest: `sha256:${"0".repeat(64)}`
  }, manifest), [{ code: "DISTRIBUTION_MANIFEST_DIGEST_INVALID" }]);
});

test("distribution archive integrity binds the manifest and every payload byte", () => {
  const bytes = Buffer.from("candidate archive");
  const pack = {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  };
  assert.deepEqual(validateArchiveIntegrity(bytes, pack), []);
  assert.deepEqual(validateArchiveIntegrity(Buffer.from("tampered"), pack), [
    { code: "DISTRIBUTION_ARCHIVE_SHASUM_MISMATCH" },
    { code: "DISTRIBUTION_ARCHIVE_INTEGRITY_MISMATCH" }
  ]);
});

test("real archive missing a declared recipe returns the stable missing code", async (t) => {
  if (process.platform === "win32") return t.skip("tar fixture is POSIX-only");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "distribution-missing-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const packageRoot = path.join(temporary, "package");
  const manifestDirectory = path.join(packageRoot, "dist");
  await mkdir(manifestDirectory, { recursive: true });
  const actualPackageManifest = JSON.parse(await readFile(
    path.join(repositoryRoot, "package.json"),
    "utf8"
  ));
  const missingPath = "dist/examples/recipes/minimal-answer.v1/minimal-answer/employee.json";
  const files = [{ path: missingPath, size: 2, sha256: createHash("sha256").update("{}", "utf8").digest("hex") }];
  const artifactManifest = {
    schemaVersion: "digital-employee-distribution.v1",
    package: { name: actualPackageManifest.name, version: actualPackageManifest.version },
    source: { gitCommit: "b".repeat(40), dirty: false },
    toolchain: { node: "v24.13.0", npm: "11.6.2", typescript: "7.0.2" },
    digestAlgorithm: "sha256",
    manifestPath: "dist/distribution-manifest.json",
    manifestDigestExcluded: true,
    fileSetDigest: computeDistributionFileSetDigest(files),
    files
  };
  await writeFile(
    path.join(manifestDirectory, "distribution-manifest.json"),
    `${JSON.stringify(artifactManifest)}\n`
  );
  const archiveFilename = `fullstack-ai-infra-digital-employee-${actualPackageManifest.version}.tgz`;
  const archivePath = path.join(temporary, archiveFilename);
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", temporary, "package"], {
    encoding: "utf8"
  });
  assert.equal(tar.status, 0, tar.stderr);
  const archiveBytes = await readFile(archivePath);
  const pack = {
    name: actualPackageManifest.name,
    version: actualPackageManifest.version,
    filename: archiveFilename,
    shasum: createHash("sha1").update(archiveBytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`,
    files: [
      { path: "dist/distribution-manifest.json" },
      { path: missingPath }
    ]
  };
  assert.deepEqual(await validateRootArchive({
    archivePath,
    pack,
    packageManifest: actualPackageManifest
  }), {
    violations: [{
      code: "DISTRIBUTION_REQUIRED_FILE_MISSING",
      path: missingPath
    }]
  });

  const coreManifest = JSON.parse(await readFile(
    path.join(repositoryRoot, "packages", "core", "package.json"),
    "utf8"
  ));
  const coreFilename = `fullstack-ai-infra-digital-employee-core-${coreManifest.version}.tgz`;
  await writeFile(path.join(temporary, coreFilename), "core archive fixture");
  const rootOutput = path.join(temporary, "root-pack.json");
  const coreOutput = path.join(temporary, "core-pack.json");
  await writeFile(rootOutput, JSON.stringify([pack]));
  await writeFile(coreOutput, JSON.stringify([{
    name: coreManifest.name,
    version: coreManifest.version,
    filename: coreFilename,
    files: [
      { path: "package.json" },
      { path: "dist/index.js" },
      { path: "dist/index.d.ts" }
    ]
  }]));
  const cli = spawnSync(process.execPath, [
    path.join(repositoryRoot, "scripts", "release-pack-check.js"),
    temporary,
    rootOutput,
    coreOutput
  ], { encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stderr);
  const result = JSON.parse(cli.stderr);
  assert.ok(result.violations.some((violation: { code: string; path?: string }) =>
    violation.code === "DISTRIBUTION_REQUIRED_FILE_MISSING" &&
    violation.path === missingPath
  ));
  assert.doesNotMatch(cli.stderr, /ENOENT/);
});

test("container and CI consume the generated tarball without source fallback", async () => {
  const [dockerfile, dockerignore, workflowText] = await Promise.all([
    readFile(path.join(repositoryRoot, "Dockerfile"), "utf8"),
    readFile(path.join(repositoryRoot, ".dockerignore"), "utf8"),
    readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8")
  ]);
  assert.match(dockerfile, /COPY --chown=node:node \.cache\/distribution\/digital-employee-package\.tgz/);
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node \. /);
  assert.match(dockerignore, /^\*\*$/m);
  const workflow = YAML.parse(workflowText);
  assert.ok(workflow.jobs["distribution-candidate"]);
  assert.equal(workflow.jobs["distribution-consumer"].strategy["fail-fast"], false);
  assert.deepEqual(workflow.jobs["distribution-consumer"].strategy.matrix["node-version"], [
    20,
    22,
    24
  ]);
  assert.ok(workflow.jobs["distribution-reproducibility"]);
});

test("release workflow has independently scoped jobs for all channels", async () => {
  const workflowText = await readFile(
    path.join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8"
  );
  const workflow = YAML.parse(workflowText);
  const npmRoot = workflow.jobs["npm-root"];
  const npmCore = workflow.jobs["npm-core"];
  for (const job of [npmRoot, npmCore]) {
    assert.equal(job.needs, "verify");
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.deepEqual(job.permissions, {
      contents: "read",
      "id-token": "write"
    });
    assert.ok(job.steps.some((step: { uses?: string }) =>
      step.uses === "actions/checkout@v6"
    ));
    assert.ok(job.steps.some((step: { uses?: string }) =>
      step.uses === "actions/setup-node@v6"
    ));
    assert.ok(job.steps.some((step: { run?: string }) =>
      step.run === "npm install --global npm@11.18.0"
    ));
  }

  const rootPublish = npmRoot.steps.at(-1).run;
  const corePublish = npmCore.steps.at(-1).run;
  assert.match(rootPublish, /npm publish --access public/);
  assert.doesNotMatch(rootPublish, /packages\/core/);
  assert.match(corePublish, /npm publish \.\/packages\/core --access public/);
  assert.doesNotMatch(workflowText, /NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.match(workflowText, /mkdir -p "\$pack_destination"/);
  assert.match(
    workflowText,
    /npm pack --json --pack-destination "\$pack_destination"/
  );
  assert.match(
    workflowText,
    /npm pack \.\/packages\/core --json --pack-destination "\$pack_destination"/
  );
  assert.doesNotMatch(workflowText, /npm pack[^\n]*--dry-run/);
  assert.doesNotMatch(workflowText, /npm --prefix packages\/core pack/);
  assert.match(workflowText, /release-pack-check\.js/);
  assert.match(workflowText, /npm run test:coverage/);
  assert.ok(workflow.jobs["github-release"]);
  assert.ok(workflow.jobs.ghcr);
  assert.match(workflowText, /gh release (?:create|upload)/);
  assert.match(workflowText, /docker push/);
});
