# Reproducible distribution candidate

This repository treats the generated npm tarball as the release candidate. A
container installs that same tarball; it does not rebuild or copy runtime files
from the source checkout. Issue #92 owns publication. The commands below only
build and verify a candidate.

The root package has a fail-closed allowlist. Compiled files must correspond to
tracked runtime TypeScript sources, and runtime data is copied from an exact
asset map. That map includes the two bounded recipes and the `en`, `zh-CN` and
`ja` locale catalogs. Missing files, undeclared files and credential-shaped
paths stop verification.

## Build and verify

Start with a clean checkout. Provenance preparation rejects staged, modified or
untracked source input.

```bash
npm ci
pack_directory="$(mktemp -d)"
npm pack --json --pack-destination "$pack_directory" > "$pack_directory/root-pack.json"
npm pack ./packages/core --json --pack-destination "$pack_directory" > "$pack_directory/core-pack.json"
node ./scripts/release-pack-check.js \
  "$pack_directory" \
  "$pack_directory/root-pack.json" \
  "$pack_directory/core-pack.json"
package_file="$(node --input-type=module -e \
  "import fs from 'node:fs'; const [entry] = JSON.parse(fs.readFileSync('$pack_directory/root-pack.json', 'utf8')); process.stdout.write(entry.filename)")"
```

The root tarball contains `dist/distribution-manifest.json`. It records the
exact source commit, package identity, Node/npm/TypeScript toolchain and a
SHA-256 digest for every other packed file. The manifest explicitly excludes
its own digest to avoid a recursive checksum; the verifier extracts it from the
tarball, verifies every listed byte, and binds the complete archive through
the integrity emitted by `npm pack`.

## Installed consumer smoke

Run the smoke harness against the generated root tarball. It creates an empty
consumer and npm cache, installs only the tarball, runs CLI help and completes
`init -> validate -> eval` for both recipes.

```bash
node ./scripts/distribution-smoke.js \
  "$pack_directory/$package_file"
```

This is offline package/Schema fixture conformance. It does not evaluate a
model, Agent Host, MCP service, live provider behavior or employee quality.

## Container from the same candidate

Stage the already verified root tarball at the single Docker input path:

```bash
mkdir -p .cache/distribution
cp "$pack_directory/$package_file" \
  .cache/distribution/digital-employee-package.tgz
docker build --tag digital-employee:candidate .
docker run --rm digital-employee:candidate --help
```

`.dockerignore` rejects every other source path from the context. CI repeats
the installed smoke on Node 20, 22 and 24 and compares the payload manifest and
every declared file digest from two independently built clean checkouts. The
npm tar container encoding is not a cross-toolchain byte-reproducibility
contract.
