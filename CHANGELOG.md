# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- The capability evidence standard is now codified and enforced (#140
  REQ-001 / REQ-002 / REQ-004, AC-001 / AC-002): every claim must carry the
  exact Host version, the deterministic fixture (kit) version, the
  `fixtureConformant` vs `liveQualified` boundary, and the sha256
  fixture-corpus digest recomputed from the kit's frozen case contract.
  `adapter-qualification-snapshot.v1` is the machine-readable per-release
  form: `createQualificationSnapshot` derives it from a validated record and
  `validateAdapterQualificationSnapshot` rejects incomplete or incoherent
  claims (missing fields, unknown kit versions, digest/corpus mismatches,
  dropped or duplicated domain rows, under-reported counts, or axes that
  disagree with the rows). The release regression harness re-runs the full
  deterministic vector set against the reference stdio Host on every
  `npm run check` (CI and the release workflow) and fails closed via
  `compareQualificationSnapshots` if any evidence earned in the committed
  v0.4.0 baseline snapshot
  (`fixtures/qualification/snapshots/v0.4.0.json`) disappears or weakens;
  strengthened evidence always passes.
- The Adapter qualification kit earns a tenth domain, `readonly_projection`
  (#140 REQ-003 / AC-003), through two deterministic, model-free vectors:
  `read_search_only` (one final `run.completed`, every tool event inside the
  frozen read-only pair `read_file`/`search_workspace`, both exercised) and
  `write_tool_refused` (a typed `qualification_filesystem_policy_denied` at
  preflight or in one final `run.failed`, with zero executed tool events). Kit
  version moves to `1.3.0` (20 cases); the v1 record validator now accepts
  four versioned contracts (`1.0.0`, `1.1.0`, `1.2.0`, `1.3.0`) with
  per-version domain sets, so a pre-`1.3.0` record carrying
  `readonly_projection` fails closed exactly like a `1.3.0` record that drops
  it. The reference stdio Host serves both operations deterministically.
- The reusable Adapter qualification kit now earns `output_schema` evidence
  through six deterministic vectors (#113): `valid_json`, `non_json`,
  `schema_mismatch`, `invalid_schema_preflight`, `cancel_buffered`, and
  `secret_rejected`. Kit version moves to `1.2.0` (18 cases); the v1 record
  validator still accepts the superseded `1.1.0` 13-case and legacy `1.0.0`
  nine-case contracts, and unknown kit versions fail closed. Rejection is
  Adapter-enforced and synchronous: invalid, `$async`, or oversized Schemas
  never reach a model process, nonconforming terminals are replaced by one
  typed final `run.failed` without echoing hostile output bytes, cancellation
  wins over buffered success, and the credential sentinel never surfaces.
  Default CI stays offline: records are `fixtureConformant` with
  `liveQualified: false` and no live model or paid call.

### Changed

- Claude, Qwen, CodeBuddy and Qoder now share one synchronous output-Schema
  preflight guard (`apps/cli/output-schema-guard.ts`, #113): invalid,
  oversized (>16 KiB), `$async:true` and otherwise unsupported Schemas are
  rejected before any version probe, projection or model process, and each
  run prepares exactly one Schema snapshot that projection and terminal
  validation both consume — the stream layer never recompiles or re-accepts
  a Schema. Claude, Qwen and CodeBuddy preflight previously probed first,
  and Qwen/CodeBuddy recompiled Ajv at the terminal; both behaviors are
  gone. New deterministic regressions prove the shared guard unit contract
  and that each of the three adapters fails closed with its typed code,
  zero version-probe calls and no model spawn for invalid/`$async`/oversized
  Schemas; Schema-absent requests keep the existing unstructured behavior.
- Issue #113 AC-004 evidence is hardened without changing any authority:
  Claude, Qwen and CodeBuddy projection tests now assert (as Qoder already
  did) that output-Schema bytes never reach process environment values or
  the public event stream, joining the existing argv assertions; stdin
  stays the one bounded channel. `docs/agent-hosts.md` gains the canonical
  exact-version qualification table (Qoder `1.1.x` family / fixture
  `1.1.12`, Claude Code `>=2.1.214 <2.2.0`, Qwen Code `0.17.1`, CodeBuddy
  Code `2.106.4`) separating fixture conformance from live entitlement, and
  `docs/verification.md` is refreshed (Codex 0.146.0 wording replaced by
  the 0.148.0 audit, new #113 evidence row). The later versioned release
  proving generic downstream selection remains a separate release gate.
- Codex default-deny research is re-audited against stable Codex CLI 0.148.0
  (release `rust-v0.148.0`, tag commit `3ba0f71`): the offline Responses
  fixture still observes model-visible `apply_patch` after every expressible
  tool reduction, four candidate removal surfaces are rejected by
  `--strict-config` as unknown fields, and upstream closed the `apply_patch`
  disable request as NOT_PLANNED (openai/codex#8161). The verdict stays
  NO-GO / probe-only; the audit script and tests now pin 0.148.0 with a new
  sanitized fixture, and `docs/agent-hosts.md` drops the stale 0.146.0
  wording in favor of the 0.148.0/0.147.0 research records.

### Fixed

- Public `RunnerReplayClaim` values now require the verified positive
  safe-integer `fencingToken`; direct claim callers and typed custom guard
  fixtures must add the field, while executor-integrated guards receive it
  automatically. The durable adapter persists the value unchanged and rejects
  lower tokens after a new guard instance is attached to the same store;
  legacy durable records whose token is `0` fail closed because their original
  ordering cannot be recovered. The preview guard now bounds nonce TTL entries
  separately from process-lifetime task high-watermarks, but remains explicitly
  restart-unsafe.
- The external stdio Adapter no longer fails closed on its own teardown
  traffic (#113). After a synthesized Schema-mismatch terminal, the mandated
  closing response is drained before the run stream is deleted, and `cancel`
  registers a bounded waiter for its exchange id, so late closing responses
  and cancel acknowledgements can no longer be dispatched as unsolicited
  messages that kill every active stream and signal the host child. Pipe
  errors on a dead Adapter are absorbed instead of escaping as uncaught
  stream errors.
- Deploy i18n malformed-catalog handling is now observable and pinned by
  built-CLI tests (#79). A catalog that fails JSON parsing or has a
  non-object root falls back to canonical English with a single `[i18n]`
  stderr warning instead of silently or unsafely loading. New
  `tests/apps/deploy-i18n-discovery.test.ts` proves on the built CLI that a
  JSON-only synthetic locale is discovered and rendered without any
  TypeScript registration, that malformed catalogs fall back to English, and
  that an explicitly unsupported `--locale` exits nonzero;
  `locales/README.md` documents the exact built-CLI verification commands.

## [0.4.0] - 2026-08-16

### Added

- Git source refresh is fail closed by default and can serve a validated
  last-known-good generation when the remote is unreachable (#103). With
  `policy: "prefer_last_known_good"` and an integer `maxStaleMs` in
  [1000, 604800000], every degraded read revalidates the pinned commit,
  manifest provenance, selected-content digest, path safety, and age;
  `legacy sync` reports `degraded` and exits 2, and runtime/HTTP health
  report per-source status. A failed refresh never touches the active
  generation, and the cache remains disposable.
- Qoder CLI 1.1.x now advertises `structured_output` from Adapter-specific
  deterministic conformance fixtures under the common Adapter-enforced
  terminal-validity contract. A checked-in employee package
  that keeps `requiredCapabilities: ["structured_output"]` can pass the normal
  package-aware Qoder preflight; unverified Qoder versions remain fail closed.
  Deterministic fixtures cover matching JSON, malformed/fenced/prose/truncated
  output, Schema mismatch and additional properties, unstructured output,
  buffered cancellation, and the independent deadline path.
- Added revisioned roadmap/feature/maintenance Issue requirements, an
  append-only decision policy, PR-to-REQ/AC traces, append-only merge
  verification ledgers, explicit product review, and frozen milestone packets
  requiring a named owner's ACCEPT/REJECT decision. These are review policies,
  not technical tamper prevention. A bounded checker validates templates,
  fixtures, the actual PR body, and every source commit message in the exact
  event base-to-head range from a safe event file and local Git history in CI.
- Added the immutable `agent-host-vectors/v2` corpus revision with one
  aggregate digest and 50 independently consumable vectors. The revision
  preserves the frozen v1 fixtures while pinning capability-key allowlisting,
  not-ready/non-conformance/probe-only/unavailable migration rejection,
  completed-plus-failed terminal ambiguity, and exact probe result/issue keys
  in one integrated Issue #46 ledger.
- Added package-bound `deploy [package-path]` with exact identity/version/digest
  binding, explicit runtime semantics, localized deterministic automation,
  truthful `ready|pending_external_action|unsupported|failed` outcomes, a
  verified loopback HTTP runtime, Console pending guidance, and a fail-closed
  DingTalk reconciliation path. Current DWS JSON list output omits the required
  pagination metadata, so real DingTalk integration remains on external HOLD.
- Hardened deploy so DingTalk resources cannot be orphaned by implicit
  rebinding, provider create errors retain their durable reconciliation fence,
  provider identities and fences are tenant/auth-scope bound without persisting
  raw identity or credential data,
  HTTP runtimes receive only the selected engine credentials, and requests run
  from a private digest-bound package snapshot.
- Added bounded interactive input and clean installed-tarball deploy gates,
  including recipe assets, setup version identity, health/ask readback, and
  runtime PID cleanup.
- Real-local Phase A path (#42): a `component-matrix.v1` contract that pins
  the exact `mem` and `doc` service commits as the sole version authority, a
  deterministic `real-local-stdio-host` Agent Host fixture that resumes
  scoped durable memory (`durable-context.v1`) and reads ETag-pinned
  documents from actual loopback services behind the operator
  `capability-grant.v1` gate, the `recipes/real-local-context` employee
  package with a deterministic fault-scenario table, and a credential-free
  harness (`scripts/real-local-harness.mjs`) that bootstraps, seeds, runs,
  emits `real-local-e2e` evidence with an empty secret scan, and cleans up.
  Real-local failures use the frozen `real_local_*` code namespace, never
  the synthetic `mcp_*` codes.

### Security

- Adapter qualification kit 1.1.0 now gives every case one awaited, bounded
  finalizer; teardown that cannot settle aborts the suite without emitting a
  record. Typed filesystem/network/MCP denial codes replace generic failure evidence,
  sentinel scans fail closed on accessors, Proxies, descriptor errors, and
  budget exhaustion, and process cleanup is bound to the exact Adapter,
  config/probe/version fingerprint, and verified child-to-grandchild lineage.
  The v1 record validator retains the original 1.0.0 nine-case contract while
  deriving all domain counts and axes exactly for both supported kit versions.
- Employee-package inspection and the generic run/eval boundaries now reject
  asynchronous JSON Schemas. Claude, Qwen, and CodeBuddy also prepare one
  immutable Schema snapshot per run, reject `$async` before Host execution,
  and require synchronous validators to return exactly `true`; this closes the
  Ajv Promise-truthiness path across every built-in structured-output Adapter.
  All built-ins validate the unchanged terminal JSON before safety scrubbing;
  repair, coercion, defaults, field removal, or redaction cannot manufacture a
  passing value, and a required post-validation mutation fails closed.

- Qoder JSON Schemas are serialized, capped at 16 KiB, and compiled before
  any run-workspace projection or Qoder subprocess, including the bounded
  version probe; invalid, oversized, or asynchronous Schemas therefore cannot
  reach a paid model invocation. Invalid, oversized, or asynchronous Schema and
  unsafe terminal output produce typed failures.
- Deployment state now uses a strict secret-free schema, owner-only atomic
  persistence, generation checks, and a retained local `lockf`/`flock`
  descriptor. HTTP activation is parent-coupled through an exact fd4 lease and
  publishes Ready only after fresh state/package/endpoint readback; unsafe PIDs
  are preserved without blind signals. DingTalk writes persist an operation
  fence before create and every uncertain retry is reconcile-only.
- Qoder assistant text is now buffered until successful process and cleanup
  completion, then scrubbed as one value with the exact service credential.
  This prevents secrets split across native stream chunks from escaping in
  standard events. Tool input values are scrubbed before truncation,
  credential-bearing tool identifiers and keys are rejected, and schema-bound
  structured output that would require credential or pattern redaction fails
  closed.

## [0.3.0] - 2026-08-04

This public release added the publisher-owned Runner execution boundary and is
available through the root and core npm packages, GHCR, and GitHub Releases.
It predates the package-bound `deploy` work in `[Unreleased]`.

### Added

- Added the cross-repository `digital-employee.runner-protocol.v1` contract:
  Ed25519 task/receipt envelopes, strict canonical payloads, lease fencing,
  bounded hash-chained events, Runner-attested usage and shared golden vectors.
- Added deterministic employee-package digests and per-run sealed local
  snapshots so the bytes verified are the bytes passed to the Agent Host.
- Added a required replay-guard port, process-local preview implementation,
  signed-renewal lease state and a one-shot Runner executor for a publisher or
  operator-owned machine.
- Added package identity checks before and after Host preflight/execution,
  lease-aware cancellation, bounded normalized event transport and signed
  completion receipts.

### Security

- Runner tasks can resolve packages by immutable identity only; a platform
  payload cannot provide a local path, command, module or Agent credential.
- Runner receipts prove provenance and integrity only. They deliberately carry
  no Credit or price authority and cannot make self-reported usage billable.
- All validity windows are half-open, bounded clock skew is explicit, signed
  renewals preserve the full task identity, and late executions cannot produce
  an acceptable receipt.

## [0.2.0] - 2026-08-04

This release is the Agent-native CLI and Host Adapter release. The published
`0.1.0` artifacts remain the frozen `standalone-v1` compatibility release;
the `0.2.0` artifacts are not public until the release workflow completes.

### Breaking changes

- **Source-checkout startup:** Running `npm start` without arguments no longer
  starts the `standalone-v1` configured channel. It prints Agent-native CLI
  help and exits. Use `npm run legacy:start -- [options]` to retain that
  behavior.
- **Source-built container startup:** Running the image without arguments no
  longer starts the compatibility HTTP server on port 3000, and the image no
  longer declares `EXPOSE 3000`. Existing deployments must explicitly pass
  `legacy serve --config ./dist/configs/demo.json --host 0.0.0.0 --port 3000`.
  The published `0.1.0` image is unchanged.

### Added

- Added the host-neutral `employee-package.v1alpha1` manifest, source package
  scaffold, static validation, and public JSON Schema.
- Added `employee-mcp.v1alpha1` for host-neutral stdio/HTTPS MCP declarations
  with environment-variable secret references.
- Added the `agent-host.v1` adapter/event/capability contract and fail-closed
  host compatibility assessment.
- Added an explicit, host-neutral `AgentHostRegistry` and trusted embedder API.
  Host IDs and aliases cannot shadow each other; employee packages cannot
  discover or install adapters, and deployments can inject only adapters they
  register deliberately.
- Added local-only `doctor`, `init`, and `validate` CLI commands; diagnosis
  probes executable versions without starting a model run.
- Added built-in catalog entries for Claude Code, Qoder CLI, Codex CLI, Qwen
  Code and CodeBuddy Code. Documentation claims never satisfy runnable package
  compatibility, and Codex remains probe-only because Codex CLI 0.146.0 cannot
  reliably remove every model-visible built-in tool, notably `apply_patch`.
- Added the `run --engine qoder` path for Qoder CLI 1.1.x, verified by
  Adapter-specific deterministic process fixtures. It uses a stateless
  read-only projection,
  isolated configuration, filtered environment, stdin JSONL initialization and
  task transport, native stream normalization, package-aware preflight,
  pre-launch cancellation, file-identity checks, runtime policy attestation,
  SDK process-mode authentication, protocol-major validation, atomic native
  event validation, pre-terminal credential cleanup, and outer JSON Schema
  validation.
- Added runnable, stateless context-only adapters for Claude Code
  `>=2.1.214 <2.2.0`, Qwen Code `0.17.1` and CodeBuddy Code `2.106.4`. They use
  explicit service API keys instead of personal login state, sealed bounded
  UTF-8 asset values over stdin, empty isolated workspace, home, configuration
  and temp directories, version-specific zero-tool/MCP runtime attestation,
  filtered environments, strict unknown-event and secret-output handling,
  bounded cleanup, POSIX process-group termination, cancellation and
  post-cleanup terminal events. Qwen also
  disables its built-in slash commands; CodeBuddy exhaustively denies every
  tool exposed by 2.106.4 because its empty `--tools` flag alone is ineffective.
  MCP, attachments, session resume, write tools, approval callbacks and Windows
  execution remain unsupported; live model entitlement was not tested.
- Added `--stdin` and `--input-file` task sources so callers can keep task data
  out of the outer CLI argument vector.
- Added the strict `employee-profile.v1` manifest and runtime API compatibility contract.
- Added explicit profile, source, model, channel, and tool registries plus a fail-closed local module loader.

### Changed

- Reframed the existing model/retriever execution path as the
  `standalone-v1` compatibility runtime; new Agent behavior targets external
  Agent hosts through adapters instead of extending a second general loop.
- Added the explicit `legacy ask|sync|start|serve` namespace. Existing
  top-level commands remain deprecated aliases through `0.x`; Agent-native
  commands do not eagerly import or fall back to the compatibility runtime.
- Changed zero-argument `npm start` and the source-built container to show the
  Agent-native CLI help. Compatibility services now require an explicit
  `legacy ...` entry point.
- npm releases now use GitHub Actions OIDC trusted publishing instead of a long-lived repository token.
- Shipped runtime, connector, profile, application, and test sources now use
  strict TypeScript; npm and CLI entry points execute generated ESM from
  `dist/` with declarations and source maps.
- `answer-agent` and all shipped connectors now assemble through registry entries instead of CLI conditionals; legacy 0.1 profile strings remain supported.
- The first-release runtime now rejects any deployment or profile that requests write capability.

## [0.1.0] - 2026-08-01

### Added

- Generic digital employee runtime with a read-only `answer-agent` profile.
- Approved filesystem, Git, and optional DWS knowledge sources.
- Console and optional DingTalk channels.
- OpenAI-compatible and zero-credential extractive model providers.
