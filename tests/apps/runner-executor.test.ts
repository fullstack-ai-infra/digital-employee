import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createEmployeePackage } from "../../apps/cli/employee-package.js"
import { computeEmployeePackageDirectoryDigest } from "../../apps/cli/employee-package.js"
import { executeOneShotRunnerTask } from "../../apps/cli/runner-executor.js"
import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostEvent,
  AgentHostProbeResult,
} from "../../packages/core/src/agent-host.js"
import { AgentHostRegistry } from "../../packages/core/src/agent-host-registry.js"
import {
  RUNNER_PROTOCOL_VERSION,
  decodeOpaqueJson,
  encodeOpaqueJson,
  signRunnerTask,
  verifyRunnerEventChain,
  verifyRunnerReceipt,
} from "../../packages/core/src/runner-protocol.js"
import type { RunnerTaskPayload } from "../../packages/core/src/runner-protocol.js"
import { InMemoryRunnerReplayGuard } from "../../packages/core/src/runner-replay-guard.js"
import type { RunnerReplayClaim } from "../../packages/core/src/runner-replay-guard.js"
import { RunnerLeaseState } from "../../packages/core/src/runner-lease.js"

function readyProbe(): AgentHostProbeResult {
  const capabilities = createUnknownAgentHostCapabilities()
  capabilities.non_interactive_run = "supported"
  capabilities.event_stream = "supported"
  capabilities.tool_allowlist = "supported"
  capabilities.filesystem_scope = "supported"
  capabilities.network_policy = "supported"
  capabilities.usage_events = "supported"
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: "fixture-host",
    displayName: "Fixture Host",
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    capabilities,
    capabilitySource: "conformance_test",
    issues: [],
  }
}

function registryFor(options: {
  failed?: boolean
  invalidUsage?: boolean
  assistantText?: string
  onRun?: () => void
} = {}): AgentHostRegistry {
  const adapter: AgentHostAdapter = {
    hostId: "fixture-host",
    async probe() {
      return readyProbe()
    },
    async preflight() {
      return readyProbe()
    },
    async *run(request) {
      options.onRun?.()
      const timestamp = "2026-08-04T00:00:01.000Z"
      yield { type: "run.started", runId: request.runId, timestamp }
      if (options.assistantText) {
        yield {
          type: "assistant.delta",
          runId: request.runId,
          timestamp,
          text: options.assistantText,
        }
      }
      yield {
        type: "usage",
        runId: request.runId,
        timestamp,
        inputTokens: 10,
        outputTokens: options.invalidUsage ? -1 : 5,
        totalTokens: 15,
      }
      yield {
        type: "tool.completed",
        runId: request.runId,
        timestamp,
        toolCallId: "call-1",
        toolName: "knowledge.search",
        output: { matches: 1 },
        isError: false,
      }
      if (options.failed) {
        yield {
          type: "run.failed",
          runId: request.runId,
          timestamp,
          error: {
            code: "provider_unavailable",
            message: "provider detail not copied to the receipt",
            retryable: true,
          },
        }
        return
      }
      const completed: AgentHostEvent = {
        type: "run.completed",
        runId: request.runId,
        timestamp,
        output: {
          status: "answered",
          answer: "local answer",
          citations: [],
        },
      }
      yield completed
    },
  }
  return new AgentHostRegistry().register({
    id: "fixture-host",
    probe: () => adapter.probe(),
    createAdapter: () => adapter,
  })
}

function blockingRegistry(options: {
  started(): void
  wait(): Promise<void>
  cancelled(): void
}): AgentHostRegistry {
  const adapter: AgentHostAdapter = {
    hostId: "fixture-host",
    async probe() {
      return readyProbe()
    },
    async preflight() {
      return readyProbe()
    },
    async *run(request) {
      options.started()
      yield {
        type: "run.started",
        runId: request.runId,
        timestamp: "2026-08-04T00:00:01.000Z",
      }
      await options.wait()
      yield {
        type: "run.completed",
        runId: request.runId,
        timestamp: "2026-08-04T00:00:02.000Z",
        output: {
          status: "answered",
          answer: "after heartbeat",
          citations: [],
        },
      }
    },
    async cancel() {
      options.cancelled()
    },
  }
  return new AgentHostRegistry().register({
    id: "fixture-host",
    probe: () => adapter.probe(),
    createAdapter: () => adapter,
  })
}

function hangingPreflightRegistry(options: {
  started(): void
  cancelled(): void
}): AgentHostRegistry {
  const adapter: AgentHostAdapter = {
    hostId: "fixture-host",
    async probe() {
      return readyProbe()
    },
    async preflight() {
      options.started()
      return new Promise<AgentHostProbeResult>(() => undefined)
    },
    async *run() {
      throw new Error("run must not start after preflight cancellation")
    },
    async cancel() {
      options.cancelled()
    },
  }
  return new AgentHostRegistry().register({
    id: "fixture-host",
    probe: () => adapter.probe(),
    createAdapter: () => adapter,
  })
}

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "runner-executor-"))
  const directory = path.join(parent, "answer-agent")
  await createEmployeePackage(directory)
  const packageDigest = await computeEmployeePackageDirectoryDigest(directory)
  const platform = generateKeyPairSync("ed25519")
  const runner = generateKeyPairSync("ed25519")
  const task: RunnerTaskPayload = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.task",
    taskId: "task-1",
    runId: "run-1",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-1",
    quoteId: "quote-1",
    reservationId: "reservation-1",
    sellerId: "seller-1",
    runnerId: "runner-1",
    employee: { id: "answer-agent", version: "0.1.0", packageDigest },
    engine: "fixture-host",
    input: encodeOpaqueJson({ message: "hello" }),
    issuedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2026-08-04T00:05:00.000Z",
    leaseExpiresAt: "2026-08-04T00:04:00.000Z",
    nonce: Buffer.alloc(16, 4).toString("base64url"),
  }
  const envelope = signRunnerTask({
    task,
    keyId: "platform-key-1",
    privateKey: platform.privateKey,
  })
  return { directory, packageDigest, platform, runner, task, envelope }
}

function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

test("one-shot runner executes locally, chains events, aggregates usage, and signs receipt", async () => {
  const target = await fixture()
  const inMemoryReplayGuard = new InMemoryRunnerReplayGuard({
    clock: () => new Date("2026-08-04T00:00:01.000Z"),
  })
  let observedReplayClaim: RunnerReplayClaim | undefined
  const replayGuard = {
    claim(claim: RunnerReplayClaim) {
      observedReplayClaim = { ...claim }
      return inMemoryReplayGuard.claim(claim)
    },
  }
  const secretReasoning = "never store this model text"
  const result = await executeOneShotRunnerTask({
    taskEnvelope: target.envelope,
    resolvePlatformPublicKey: (keyId) => {
      assert.equal(keyId, "platform-key-1")
      return target.platform.publicKey
    },
    runnerId: "runner-1",
    sellerId: "seller-1",
    resolveLocalPackage: (request) => {
      assert.deepEqual(request, {
        sellerId: "seller-1",
        employeeId: "answer-agent",
        employeeVersion: "0.1.0",
        packageDigest: target.packageDigest,
      })
      return target.directory
    },
    hostRegistry: registryFor({ assistantText: secretReasoning }),
    replayGuard,
    receiptKeyId: "runner-key-1",
    receiptPrivateKey: target.runner.privateKey,
    clock: () => new Date("2026-08-04T00:00:01.000Z"),
  })

  const receipt = verifyRunnerReceipt({
    envelope: result.signedReceipt,
    publicKey: target.runner.publicKey,
  })
  assert.equal(receipt.outcome.status, "completed")
  assert.deepEqual(observedReplayClaim, {
    runnerId: target.task.runnerId,
    taskId: target.task.taskId,
    nonce: target.task.nonce,
    fencingToken: target.task.fencingToken,
    expiresAt: target.task.expiresAt,
  })
  assert.deepEqual(receipt.usage, {
    inputTokens: 10,
    outputTokens: 5,
    durationMilliseconds: 0,
    actions: [{ name: "knowledge.search", count: 1 }],
  })
  assert.equal(receipt.eventCount, 5)
  const chain = verifyRunnerEventChain(result.events, {
    taskId: target.task.taskId,
    runId: target.task.runId,
    attempt: target.task.attempt,
    fencingToken: target.task.fencingToken,
    leaseId: target.task.leaseId,
    quoteId: target.task.quoteId,
    runnerId: target.task.runnerId,
    employeeId: target.task.employee.id,
    packageDigest: target.task.employee.packageDigest,
  })
  assert.equal(chain.finalDigest, receipt.finalEventDigest)
  const encodedEvents = JSON.stringify(result.events)
  assert.doesNotMatch(encodedEvents, /never store this model text/)
  const assistant = result.events.find((event) => event.type === "assistant.delta")
  assert.deepEqual(assistant && decodeOpaqueJson(assistant.data), {
    characters: [...secretReasoning].length,
  })

  await assert.rejects(
    () =>
      executeOneShotRunnerTask({
        taskEnvelope: target.envelope,
        resolvePlatformPublicKey: () => target.platform.publicKey,
        runnerId: "runner-1",
        sellerId: "seller-1",
        resolveLocalPackage: () => target.directory,
        hostRegistry: registryFor(),
        replayGuard,
        receiptKeyId: "runner-key-1",
        receiptPrivateKey: target.runner.privateKey,
        clock: () => new Date("2026-08-04T00:00:01.000Z"),
      }),
    (error) => code(error) === "RUNNER_TASK_REPLAYED",
  )
})

test("signature failure does not call the replay guard", async () => {
  const target = await fixture()
  const wrong = generateKeyPairSync("ed25519")
  let claimCalls = 0
  await assert.rejects(
    () =>
      executeOneShotRunnerTask({
        taskEnvelope: target.envelope,
        resolvePlatformPublicKey: () => wrong.publicKey,
        runnerId: target.task.runnerId,
        sellerId: target.task.sellerId,
        resolveLocalPackage: () => target.directory,
        hostRegistry: registryFor(),
        replayGuard: {
          claim() {
            claimCalls += 1
            return true
          },
        },
        receiptKeyId: "runner-key-1",
        receiptPrivateKey: target.runner.privateKey,
        clock: () => new Date("2026-08-04T00:00:01.000Z"),
      }),
    (error) => code(error) === "RUNNER_SIGNATURE_INVALID",
  )
  assert.equal(claimCalls, 0)
})

test("wrong keys, identities, expiry, and lease expiry are rejected before local execution", async () => {
  const target = await fixture()
  const base = {
    taskEnvelope: target.envelope,
    resolvePlatformPublicKey: () => target.platform.publicKey,
    runnerId: "runner-1",
    sellerId: "seller-1",
    resolveLocalPackage: () => target.directory,
    hostRegistry: registryFor(),
    replayGuard: new InMemoryRunnerReplayGuard({
      clock: () => new Date("2026-08-04T00:00:01.000Z"),
    }),
    receiptKeyId: "runner-key-1",
    receiptPrivateKey: target.runner.privateKey,
  }
  const wrong = generateKeyPairSync("ed25519")
  await assert.rejects(
    () =>
      executeOneShotRunnerTask({
        ...base,
        resolvePlatformPublicKey: () => wrong.publicKey,
        clock: () => new Date("2026-08-04T00:00:01.000Z"),
      }),
    (error) => code(error) === "RUNNER_SIGNATURE_INVALID",
  )
  await assert.rejects(
    () =>
      executeOneShotRunnerTask({
        ...base,
        runnerId: "foreign-runner",
        clock: () => new Date("2026-08-04T00:00:01.000Z"),
      }),
    (error) => code(error) === "RUNNER_TASK_IDENTITY_MISMATCH",
  )
  await assert.rejects(
    () =>
      executeOneShotRunnerTask({
        ...base,
        replayGuard: new InMemoryRunnerReplayGuard({
          clock: () => new Date("2026-08-04T00:05:00.000Z"),
        }),
        clock: () => new Date("2026-08-04T00:05:00.000Z"),
      }),
    (error) => code(error) === "RUNNER_TASK_EXPIRED",
  )
  await assert.rejects(
    () =>
      executeOneShotRunnerTask({
        ...base,
        replayGuard: new InMemoryRunnerReplayGuard({
          clock: () => new Date("2026-08-04T00:04:00.000Z"),
        }),
        clock: () => new Date("2026-08-04T00:04:00.000Z"),
      }),
    (error) => code(error) === "RUNNER_LEASE_EXPIRED",
  )
  await assert.rejects(
    () =>
      executeOneShotRunnerTask({
        ...base,
        replayGuard: { claim: () => "true" as never },
        clock: () => new Date("2026-08-04T00:00:01.000Z"),
      }),
    (error) => code(error) === "RUNNER_REPLAY_GUARD_FAILED",
  )
})

test("post-claim package/input and Host failures produce signed non-success receipts", async () => {
  const target = await fixture()
  const deterministicFailures: Array<{
    task: RunnerTaskPayload
    errorCode: string
  }> = [
    {
      task: {
        ...target.task,
        employee: { ...target.task.employee, id: "different-agent" },
        nonce: Buffer.alloc(16, 5).toString("base64url"),
      },
      errorCode: "runner_package_identity_mismatch",
    },
    {
      task: {
        ...target.task,
        employee: {
          ...target.task.employee,
          packageDigest: `sha256:${"f".repeat(64)}`,
        },
        nonce: Buffer.alloc(16, 6).toString("base64url"),
      },
      errorCode: "runner_package_digest_mismatch",
    },
    {
      task: {
        ...target.task,
        input: { mediaType: "text/plain", encoding: "base64url", data: "" },
        nonce: Buffer.alloc(16, 7).toString("base64url"),
      },
      errorCode: "runner_input_unsupported",
    },
  ]

  for (const failure of deterministicFailures) {
    let runCalled = false
    const replayGuard = new InMemoryRunnerReplayGuard({
      clock: () => new Date("2026-08-04T00:00:01.000Z"),
    })
    const options = {
      taskEnvelope: signRunnerTask({
        task: failure.task,
        keyId: "platform-key-1",
        privateKey: target.platform.privateKey,
      }),
      resolvePlatformPublicKey: () => target.platform.publicKey,
      runnerId: "runner-1",
      sellerId: "seller-1",
      resolveLocalPackage: () => target.directory,
      hostRegistry: registryFor({ onRun: () => (runCalled = true) }),
      replayGuard,
      receiptKeyId: "runner-key-1",
      receiptPrivateKey: target.runner.privateKey,
      clock: () => new Date("2026-08-04T00:00:01.000Z"),
    }
    const result = await executeOneShotRunnerTask(options)
    const signedReceipt = verifyRunnerReceipt({
      envelope: result.signedReceipt,
      publicKey: target.runner.publicKey,
    })
    assert.deepEqual(signedReceipt.outcome, {
      status: "failed",
      errorCode: failure.errorCode,
    })
    assert.equal(runCalled, false)
    assert.equal(result.events.length, 0)
    await assert.rejects(
      () => executeOneShotRunnerTask(options),
      (error) => code(error) === "RUNNER_TASK_REPLAYED",
    )
  }

  const failed = await executeOneShotRunnerTask({
    taskEnvelope: target.envelope,
    resolvePlatformPublicKey: () => target.platform.publicKey,
    runnerId: "runner-1",
    sellerId: "seller-1",
    resolveLocalPackage: () => target.directory,
    hostRegistry: registryFor({ failed: true }),
    replayGuard: new InMemoryRunnerReplayGuard({
      clock: () => new Date("2026-08-04T00:00:01.000Z"),
    }),
    receiptKeyId: "runner-key-1",
    receiptPrivateKey: target.runner.privateKey,
    clock: () => new Date("2026-08-04T00:00:01.000Z"),
  })
  assert.deepEqual(failed.receipt.outcome, {
    status: "failed",
    errorCode: "provider_unavailable",
  })
  assert.doesNotMatch(JSON.stringify(failed), /provider detail/)

  const invalidUsage = await executeOneShotRunnerTask({
    taskEnvelope: target.envelope,
    resolvePlatformPublicKey: () => target.platform.publicKey,
    runnerId: "runner-1",
    sellerId: "seller-1",
    resolveLocalPackage: () => target.directory,
    hostRegistry: registryFor({ invalidUsage: true }),
    replayGuard: new InMemoryRunnerReplayGuard({
      clock: () => new Date("2026-08-04T00:00:01.000Z"),
    }),
    receiptKeyId: "runner-key-1",
    receiptPrivateKey: target.runner.privateKey,
    clock: () => new Date("2026-08-04T00:00:01.000Z"),
  })
  assert.equal(invalidUsage.receipt.usage.inputTokens, 0)
  assert.equal(invalidUsage.receipt.usage.outputTokens, 0)
  assert.deepEqual(invalidUsage.events.map((event) => event.type), [
    "run.started",
  ])
})

test("executor options accessors are rejected without invocation", async () => {
  const target = await fixture()
  let reads = 0
  const options = {
    taskEnvelope: target.envelope,
    resolvePlatformPublicKey: () => target.platform.publicKey,
    runnerId: "runner-1",
    sellerId: "seller-1",
    resolveLocalPackage: () => target.directory,
    hostRegistry: registryFor(),
    replayGuard: new InMemoryRunnerReplayGuard(),
    receiptKeyId: "runner-key-1",
    get receiptPrivateKey() {
      reads += 1
      return target.runner.privateKey
    },
  }
  await assert.rejects(
    () => executeOneShotRunnerTask(options),
    (error) => code(error) === "RUNNER_TASK_IDENTITY_MISMATCH",
  )
  assert.equal(reads, 0)

  let traps = 0
  const proxy = new Proxy(options, {
    get() {
      traps += 1
      throw new Error("proxy get trap must not run")
    },
    getPrototypeOf() {
      traps += 1
      throw new Error("proxy prototype trap must not run")
    },
    ownKeys() {
      traps += 1
      throw new Error("proxy ownKeys trap must not run")
    },
  })
  await assert.rejects(
    () => executeOneShotRunnerTask(proxy),
    (error) => code(error) === "RUNNER_TASK_IDENTITY_MISMATCH",
  )
  assert.equal(traps, 0)
})

test("outer lease cancellation settles even when Host preflight ignores AbortSignal", async () => {
  const target = await fixture()
  let now = new Date("2026-08-04T00:00:01.000Z")
  let preflightStarted!: () => void
  const started = new Promise<void>((resolve) => {
    preflightStarted = resolve
  })
  let cancelled = false
  const leaseState = await RunnerLeaseState.create({
    initialEnvelope: target.envelope,
    resolvePlatformPublicKey: () => target.platform.publicKey,
    clock: () => now,
  })
  try {
    const execution = executeOneShotRunnerTask({
      taskEnvelope: target.envelope,
      resolvePlatformPublicKey: () => target.platform.publicKey,
      runnerId: "runner-1",
      sellerId: "seller-1",
      resolveLocalPackage: () => target.directory,
      hostRegistry: hangingPreflightRegistry({
        started: preflightStarted,
        cancelled: () => {
          cancelled = true
        },
      }),
      replayGuard: new InMemoryRunnerReplayGuard({ clock: () => now }),
      receiptKeyId: "runner-key-1",
      receiptPrivateKey: target.runner.privateKey,
      leaseState,
      clock: () => now,
    })
    await started
    now = new Date("2026-08-04T00:03:55.000Z")
    assert.throws(() => leaseState.assertActive())
    const result = await execution
    assert.equal(cancelled, true)
    assert.deepEqual(result.receipt.outcome, {
      status: "cancelled_by_runner",
      reasonCode: "lease_deadline_reached",
    })
    assert.equal(result.events.length, 0)
  } finally {
    leaseState.close()
  }
})

test("signed lease expiry cancels locally with upload margin and emits no late event", async () => {
  const target = await fixture()
  let now = new Date("2026-08-04T00:00:01.000Z")
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let firstEvent!: () => void
  const firstEventPublished = new Promise<void>((resolve) => {
    firstEvent = resolve
  })
  let cancelled = false
  const leaseState = await RunnerLeaseState.create({
    initialEnvelope: target.envelope,
    resolvePlatformPublicKey: () => target.platform.publicKey,
    clock: () => now,
  })
  try {
    const execution = executeOneShotRunnerTask({
      taskEnvelope: target.envelope,
      resolvePlatformPublicKey: () => target.platform.publicKey,
      runnerId: "runner-1",
      sellerId: "seller-1",
      resolveLocalPackage: () => target.directory,
      hostRegistry: blockingRegistry({
        started,
        wait: () => gate,
        cancelled: () => {
          cancelled = true
          release()
        },
      }),
      replayGuard: new InMemoryRunnerReplayGuard({ clock: () => now }),
      receiptKeyId: "runner-key-1",
      receiptPrivateKey: target.runner.privateKey,
      leaseState,
      clock: () => now,
      onEvent: (event) => {
        if (event.type === "run.started") firstEvent()
      },
    })
    await running
    await firstEventPublished
    now = new Date("2026-08-04T00:03:55.000Z")
    assert.throws(() => leaseState.assertActive())
    const result = await execution
    assert.equal(cancelled, true)
    assert.deepEqual(result.receipt.outcome, {
      status: "cancelled_by_runner",
      reasonCode: "lease_deadline_reached",
    })
    assert.ok(
      Date.parse(result.receipt.completedAt) <
        Date.parse(target.task.leaseExpiresAt),
    )
    assert.deepEqual(result.events.map((event) => event.type), ["run.started"])
  } finally {
    release()
    leaseState.close()
  }
})

test("a canonical signed renewal extends an in-flight local execution", async () => {
  const target = await fixture()
  let now = new Date("2026-08-04T00:00:01.000Z")
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let firstEvent!: () => void
  const firstEventPublished = new Promise<void>((resolve) => {
    firstEvent = resolve
  })
  const leaseState = await RunnerLeaseState.create({
    initialEnvelope: target.envelope,
    resolvePlatformPublicKey: () => target.platform.publicKey,
    clock: () => now,
  })
  try {
    const execution = executeOneShotRunnerTask({
      taskEnvelope: target.envelope,
      resolvePlatformPublicKey: () => target.platform.publicKey,
      runnerId: "runner-1",
      sellerId: "seller-1",
      resolveLocalPackage: () => target.directory,
      hostRegistry: blockingRegistry({
        started,
        wait: () => gate,
        cancelled: release,
      }),
      replayGuard: new InMemoryRunnerReplayGuard({ clock: () => now }),
      receiptKeyId: "runner-key-1",
      receiptPrivateKey: target.runner.privateKey,
      leaseState,
      clock: () => now,
      onEvent: (event) => {
        if (event.type === "run.started") firstEvent()
      },
    })
    await running
    await firstEventPublished
    now = new Date("2026-08-04T00:03:50.000Z")
    const renewalTask = {
      ...target.task,
      leaseExpiresAt: "2026-08-04T00:04:30.000Z",
    }
    await leaseState.acceptRenewal(
      signRunnerTask({
        task: renewalTask,
        keyId: "platform-key-1",
        privateKey: target.platform.privateKey,
      }),
    )
    now = new Date("2026-08-04T00:04:01.000Z")
    release()
    const result = await execution
    assert.equal(result.receipt.outcome.status, "completed")
    assert.equal(result.task.leaseExpiresAt, renewalTask.leaseExpiresAt)
    assert.deepEqual(result.leaseEnvelope, leaseState.envelope)
    assert.ok(
      Date.parse(result.receipt.completedAt) >
        Date.parse(target.task.leaseExpiresAt),
    )
    assert.ok(
      Date.parse(result.receipt.completedAt) <
        Date.parse(renewalTask.leaseExpiresAt),
    )
  } finally {
    release()
    leaseState.close()
  }
})

test("hard lease expiry returns no dead receipt", async () => {
  const target = await fixture()
  let now = new Date("2026-08-04T00:00:01.000Z")
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let firstEvent!: () => void
  const firstEventPublished = new Promise<void>((resolve) => {
    firstEvent = resolve
  })
  const execution = executeOneShotRunnerTask({
    taskEnvelope: target.envelope,
    resolvePlatformPublicKey: () => target.platform.publicKey,
    runnerId: "runner-1",
    sellerId: "seller-1",
    resolveLocalPackage: () => target.directory,
    hostRegistry: blockingRegistry({
      started,
      wait: () => gate,
      cancelled: release,
    }),
    replayGuard: new InMemoryRunnerReplayGuard({ clock: () => now }),
    receiptKeyId: "runner-key-1",
    receiptPrivateKey: target.runner.privateKey,
    clock: () => now,
    onEvent: (event) => {
      if (event.type === "run.started") firstEvent()
    },
  })
  await running
  await firstEventPublished
  now = new Date(target.task.leaseExpiresAt)
  release()
  await assert.rejects(
    () => execution,
    (error) => code(error) === "RUNNER_LEASE_EXPIRED",
  )
})
