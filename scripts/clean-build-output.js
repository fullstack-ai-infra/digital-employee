#!/usr/bin/env node

import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await rm(path.join(repositoryRoot, "dist"), { recursive: true, force: true });
await rm(path.join(repositoryRoot, "packages", "core", "dist"), {
  recursive: true,
  force: true
});
