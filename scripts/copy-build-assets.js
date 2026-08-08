#!/usr/bin/env node

import { chmod, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DISTRIBUTION_ASSET_MAPPINGS } from "./distribution-policy.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "dist");
const corePackageOutput = path.join(repositoryRoot, "packages", "core", "dist");

await mkdir(outputRoot, { recursive: true });
for (const [source, destination] of DISTRIBUTION_ASSET_MAPPINGS) {
  const destinationPath = path.join(repositoryRoot, destination);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(path.join(repositoryRoot, source), destinationPath, { force: true });
}
await rm(corePackageOutput, { recursive: true, force: true });
await cp(path.join(outputRoot, "packages", "core"), corePackageOutput, {
  recursive: true,
  force: true
});
await chmod(path.join(outputRoot, "apps", "cli", "bin.js"), 0o755);
