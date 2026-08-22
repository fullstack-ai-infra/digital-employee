import type { KeyLike } from "node:crypto"
import { types as utilTypes } from "node:util"

import type { AgentHostEvent } from "../../packages/core/src/agent-host.js"
import type { AgentHostRegistryPort } from "../../packages/core/src/agent-host-registry.js"
import { CoreError } from "../../packages/core/src/contracts.js"
import {
  RUNNER_EVENT_GENESIS_DIGEST,
  MAX_RUNNER_CLOCK_SKEW_MS,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_RECEIPT_DOMAIN,
  createRunnerEvent,
  decodeOpaqueJson,
  encodeOpaqueJson,
  runnerPrivateKey,
  signRunnerReceipt,
  signRunnerEnvelope,
  validateSignedEnvelope,
  validateRunnerReceipt,
  verifyRunnerTask,
} from "../../packages/core/src/runner-protocol.js"
import type {
  RunnerEvent,
  RunnerOutcome,
  RunnerReceiptPayload,
  RunnerTaskPayload,
  RunnerUsageSummary,
  SignedEnvelope,
} from "../../packages/core/src/runner-protocol.js"
import type { RunnerReplayGuardPort } from "../../packages/core/src/runner-replay-guard.js"
import {
  RUNNER_LEASE_SAFETY_MARGIN_MS,
  RunnerLeaseState,
} from "../../packages/core/src/runner-lease.js"
import { runEmployeePackage } from "./agent-run.js"
import {
  createSealedEmployeePackageSnapshot,
} from "./employee-package.js"

const ACTION_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/

export type RunnerExecutionErrorCode =
  | "RUNNER_CLOCK_INVALID"
  | "RUNNER_PLATFORM_KEY_UNAVAILABLE"
  | "RUNNER_TASK_IDENTITY_MISMATCH"
  | "RUNNER_TASK_NOT_YET_VALID"
  | "RUNNER_TASK_EXPIRED"
  | "RUNNER_LEASE_EXPIRED"
  | "RUNNER_TASK_REPLAYED"
  | "RUNNER_REPLAY_GUARD_FAILED"
  | "RUNNER_LOCAL_PACKAGE_UNAVAILABLE"
  | "RUNNER_EVENT_LIMIT_EXCEEDED"

export class RunnerExecutionError extends CoreError {
  constructor(code: RunnerExecutionErrorCode, retryable = false) {
    super(code, "Runner task could not be executed safely", {
      status: 400,
      retryable,
    })
    this.name = "RunnerExecutionError"
  }
}

export interface LocalEmployeePackageRequest {
  sellerId: string
  employeeId: string
  employeeVersion: string
  packageDigest: string
}

export interface OneShotRunnerExecutorOptions {
  taskEnvelope: unknown
  resolvePlatformPublicKey(keyId: string): KeyLike | Promise<KeyLike>
  /** Identity configured on this publisher/runner-owned machine. */
  runnerId: string
  sellerId: string
  /** Resolves identity to a local path. Task payloads can never provide paths. */
  resolveLocalPackage(
    request: LocalEmployeePackageRequest,
  ): string | Promise<string>
  /** Local trusted Agent Host registry; credentials remain in the local process. */
  hostRegistry: AgentHostRegistryPort
  /** Required and atomically consuming; no unsafe implicit replay store exists. */
  replayGuard: RunnerReplayGuardPort
  receiptKeyId: string
  receiptPrivateKey: KeyLike
  clock?: () => Date
  onEvent?: (event: RunnerEvent) => void | Promise<void>
  /** Optional state shared with an outbound signed-renewal heartbeat loop. */
  leaseState?: RunnerLeaseState
}

export interface OneShotRunnerExecution {
  /** Latest verified grant (renewed when a lease state was supplied). */
  task: RunnerTaskPayload
  leaseEnvelope: SignedEnvelope
  events: RunnerEvent[]
  receipt: RunnerReceiptPayload
  signedReceipt: SignedEnvelope
}

type CapturedOptions = Omit<
  OneShotRunnerExecutorOptions,
  "clock" | "onEvent" | "leaseState"
> & {
  clock?: () => Date
  onEvent?: (event: RunnerEvent) => void | Promise<void>
  leaseState?: RunnerLeaseState
}

function executionError(code: RunnerExecutionErrorCode, retryable = false): never {
  throw new RunnerExecutionError(code, retryable)
}

function captureOptions(input: OneShotRunnerExecutorOptions): CapturedOptions {
  const required = [
    "taskEnvelope",
    "resolvePlatformPublicKey",
    "runnerId",
    "sellerId",
    "resolveLocalPackage",
    "hostRegistry",
    "replayGuard",
    "receiptKeyId",
    "receiptPrivateKey",
  ] as const
  const optional = ["clock", "onEvent", "leaseState"] as const
  try {
    if (
      !input ||
      typeof input !== "object" ||
      utilTypes.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      executionError("RUNNER_TASK_IDENTITY_MISMATCH")
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = Reflect.ownKeys(descriptors)
    const allowed = [...required, ...optional] as readonly string[]
    if (
      keys.some((key) => typeof key !== "string") ||
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !allowed.includes(key),
      )
    ) {
      executionError("RUNNER_TASK_IDENTITY_MISMATCH")
    }
    const captured = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        executionError("RUNNER_TASK_IDENTITY_MISMATCH")
      }
      captured[key] = descriptor.value
    }
    if (
      typeof captured.resolvePlatformPublicKey !== "function" ||
      typeof captured.runnerId !== "string" ||
      typeof captured.sellerId !== "string" ||
      typeof captured.resolveLocalPackage !== "function" ||
      !captured.hostRegistry ||
      typeof captured.hostRegistry !== "object" ||
      !captured.replayGuard ||
      typeof captured.replayGuard !== "object" ||
      typeof captured.receiptKeyId !== "string" ||
      (captured.clock !== undefined && typeof captured.clock !== "function") ||
      (captured.onEvent !== undefined && typeof captured.onEvent !== "function")
    ) {
      executionError("RUNNER_TASK_IDENTITY_MISMATCH")
    }
    if (
      captured.leaseState !== undefined &&
      !(captured.leaseState instanceof RunnerLeaseState)
    ) {
      executionError("RUNNER_TASK_IDENTITY_MISMATCH")
    }
    return captured as unknown as CapturedOptions
  } catch (error) {
    if (error instanceof RunnerExecutionError) throw error
    executionError("RUNNER_TASK_IDENTITY_MISMATCH")
  }
}

function monotonicClock(clock: (() => Date) | undefined): () => Date {
  const source = clock ?? (() => new Date())
  let previous = Number.NEGATIVE_INFINITY
  return () => {
    let value: unknown
    try {
      value = source()
    } catch {
      executionError("RUNNER_CLOCK_INVALID")
    }
    if (!(value instanceof Date)) executionError("RUNNER_CLOCK_INVALID")
    const milliseconds = value.getTime()
    if (!Number.isFinite(milliseconds) || milliseconds < previous) {
      executionError("RUNNER_CLOCK_INVALID")
    }
    previous = milliseconds
    return new Date(milliseconds)
  }
}

function addChecked(left: number, right: number): number {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < 0) {
    executionError("RUNNER_EVENT_LIMIT_EXCEEDED")
  }
  return result
}

function checkedHostUsage(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    executionError("RUNNER_EVENT_LIMIT_EXCEEDED")
  }
  return value
}

function actionName(value: unknown): string {
  return typeof value === "string" && ACTION_NAME_PATTERN.test(value)
    ? value
    : "unknown"
}

function normalizedEventData(event: AgentHostEvent): unknown {
  switch (event.type) {
    case "run.started":
    case "run.completed":
      return {}
    case "assistant.delta":
      // Never retain model reasoning or response text in metering events.
      return { characters: event.text.length }
    case "tool.started":
      return { toolName: actionName(event.toolName) }
    case "tool.completed":
      return { isError: event.isError, toolName: actionName(event.toolName) }
    case "approval.required":
      return { toolName: actionName(event.toolName) }
    case "usage":
      return {
        inputTokens: checkedHostUsage(event.inputTokens),
        outputTokens: checkedHostUsage(event.outputTokens),
        totalTokens: checkedHostUsage(event.totalTokens),
      }
    case "run.failed":
      return {
        errorCode: actionName(event.error.code),
        retryable: event.error.retryable,
      }
  }
}

function outcomeFromRun(
  result: Awaited<ReturnType<typeof runEmployeePackage>>,
): RunnerOutcome {
  if (result.status === "completed") {
    try {
      return { status: "completed", output: encodeOpaqueJson(result.output) }
    } catch {
      return { status: "failed", errorCode: "runner_output_invalid" }
    }
  }
  const code = actionName(result.error.code)
  return { status: "failed", errorCode: code }
}

function failedOutcome(errorCode: string): RunnerOutcome {
  return { status: "failed", errorCode: actionName(errorCode) }
}

/**
 * Executes exactly one platform-signed task on the publisher's own machine.
 * It performs no pull/heartbeat transport and exposes no inbound endpoint.
 * Signature, identity, lease and replay failures reject before execution.
 * After the nonce is consumed, deterministic package/input/Host failures
 * resolve with a Runner-signed non-success receipt so the platform receives an
 * auditable terminal outcome and must not retry the same nonce.
 */
export async function executeOneShotRunnerTask(
  inputOptions: OneShotRunnerExecutorOptions,
): Promise<OneShotRunnerExecution> {
  const options = captureOptions(inputOptions)
  const now = monotonicClock(options.clock)
  const envelope = validateSignedEnvelope(options.taskEnvelope)
  let platformPublicKey: KeyLike
  try {
    platformPublicKey = await options.resolvePlatformPublicKey(envelope.keyId)
  } catch {
    executionError("RUNNER_PLATFORM_KEY_UNAVAILABLE")
  }
  const task = verifyRunnerTask({ envelope, publicKey: platformPublicKey })
  if (task.runnerId !== options.runnerId || task.sellerId !== options.sellerId) {
    executionError("RUNNER_TASK_IDENTITY_MISMATCH")
  }
  if (options.leaseState && !options.leaseState.matchesTask(task)) {
    executionError("RUNNER_TASK_IDENTITY_MISMATCH")
  }

  const acceptedAt = now()
  const acceptedMilliseconds = acceptedAt.getTime()
  if (
    Date.parse(task.issuedAt) >
    acceptedMilliseconds + MAX_RUNNER_CLOCK_SKEW_MS
  ) {
    executionError("RUNNER_TASK_NOT_YET_VALID")
  }
  if (acceptedMilliseconds >= Date.parse(task.expiresAt)) {
    executionError("RUNNER_TASK_EXPIRED")
  }
  if (options.leaseState) {
    try {
      options.leaseState.assertActive()
    } catch {
      executionError("RUNNER_LEASE_EXPIRED")
    }
  } else if (
    acceptedMilliseconds >=
    Date.parse(task.leaseExpiresAt) - RUNNER_LEASE_SAFETY_MARGIN_MS
  ) {
    executionError("RUNNER_LEASE_EXPIRED")
  }
  const receiptPrivateKey = runnerPrivateKey(options.receiptPrivateKey)
  // Validate the key id before consuming the nonce or starting a model run.
  // The probe signature is never transmitted or persisted.
  signRunnerEnvelope({
    domain: RUNNER_RECEIPT_DOMAIN,
    keyId: options.receiptKeyId,
    privateKey: receiptPrivateKey,
    payload: Buffer.from("{}", "utf8"),
  })
  let claimResult: unknown
  try {
    claimResult = await options.replayGuard.claim({
      runnerId: task.runnerId,
      taskId: task.taskId,
      nonce: task.nonce,
      fencingToken: task.fencingToken,
      expiresAt: task.expiresAt,
    })
  } catch {
    executionError("RUNNER_REPLAY_GUARD_FAILED", true)
  }
  if (claimResult === false) executionError("RUNNER_TASK_REPLAYED")
  if (claimResult !== true) {
    executionError("RUNNER_REPLAY_GUARD_FAILED", true)
  }

  const events: RunnerEvent[] = []
  let previousDigest: string = RUNNER_EVENT_GENESIS_DIGEST
  let inputTokens = 0
  let outputTokens = 0
  const actions = new Map<string, number>()
  let snapshot: Awaited<ReturnType<typeof createSealedEmployeePackageSnapshot>> | undefined
  let startedAt = now()
  let outcome: RunnerOutcome

  const appendEvent = async (hostEvent: AgentHostEvent): Promise<void> => {
    if (options.leaseState) {
      options.leaseState.assertActive()
    } else if (
      now().getTime() >=
      Date.parse(task.leaseExpiresAt) - RUNNER_LEASE_SAFETY_MARGIN_MS
    ) {
      executionError("RUNNER_LEASE_EXPIRED")
    }
    if (events.length >= 1_024) executionError("RUNNER_EVENT_LIMIT_EXCEEDED")
    let nextInputTokens = inputTokens
    let nextOutputTokens = outputTokens
    let action: { name: string; count: number } | undefined
    if (hostEvent.type === "usage") {
      nextInputTokens = addChecked(
        inputTokens,
        checkedHostUsage(hostEvent.inputTokens),
      )
      nextOutputTokens = addChecked(
        outputTokens,
        checkedHostUsage(hostEvent.outputTokens),
      )
    }
    if (hostEvent.type === "tool.completed") {
      const name = actionName(hostEvent.toolName)
      action = { name, count: addChecked(actions.get(name) ?? 0, 1) }
    }
    const event = createRunnerEvent({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      kind: "runner.event",
      taskId: task.taskId,
      runId: task.runId,
      attempt: task.attempt,
      fencingToken: task.fencingToken,
      leaseId: task.leaseId,
      quoteId: task.quoteId,
      runnerId: task.runnerId,
      employeeId: task.employee.id,
      packageDigest: task.employee.packageDigest,
      sequence: events.length + 1,
      timestamp: now().toISOString(),
      type: hostEvent.type,
      data: encodeOpaqueJson(normalizedEventData(hostEvent)),
      previousDigest,
    })
    events.push(event)
    previousDigest = event.digest
    inputTokens = nextInputTokens
    outputTokens = nextOutputTokens
    if (action) actions.set(action.name, action.count)
    await options.onEvent?.(event)
  }

  try {
    let localDirectory: string
    try {
      localDirectory = await options.resolveLocalPackage({
        sellerId: task.sellerId,
        employeeId: task.employee.id,
        employeeVersion: task.employee.version,
        packageDigest: task.employee.packageDigest,
      })
      if (typeof localDirectory !== "string" || !localDirectory) {
        executionError("RUNNER_LOCAL_PACKAGE_UNAVAILABLE")
      }
      snapshot = await createSealedEmployeePackageSnapshot(localDirectory)
    } catch (error) {
      if (error instanceof RunnerExecutionError) throw error
      executionError("RUNNER_LOCAL_PACKAGE_UNAVAILABLE")
    }
    if (
      snapshot.manifest.name !== task.employee.id ||
      snapshot.manifest.version !== task.employee.version
    ) {
      outcome = failedOutcome("runner_package_identity_mismatch")
    } else if (snapshot.digest !== task.employee.packageDigest) {
      outcome = failedOutcome("runner_package_digest_mismatch")
    } else if (task.input.mediaType !== "application/json") {
      outcome = failedOutcome("runner_input_unsupported")
    } else {
      let taskInput: unknown
      try {
        taskInput = decodeOpaqueJson(task.input)
      } catch {
        taskInput = undefined
      }
      if (taskInput === undefined) {
        outcome = failedOutcome("runner_input_unsupported")
      } else {
        startedAt = now()
        const currentLeaseExpiry = options.leaseState
          ? Date.parse(options.leaseState.leaseExpiresAt)
          : Date.parse(task.leaseExpiresAt)
        const deadline = Math.min(
          Date.parse(task.expiresAt),
          currentLeaseExpiry - RUNNER_LEASE_SAFETY_MARGIN_MS,
        )
        if (startedAt.getTime() >= deadline) {
          outcome = {
            status: "cancelled_by_runner",
            reasonCode: "lease_expired",
          }
        } else {
          const controller = options.leaseState
            ? undefined
            : new AbortController()
          const timeout = controller
            ? setTimeout(
                () => controller.abort(new Error("runner_lease_expiring")),
                Math.max(1, deadline - startedAt.getTime()),
              )
            : undefined
          timeout?.unref()
          try {
            const result = await runEmployeePackage({
              directory: snapshot.directory,
              engine: task.engine,
              hostRegistry: options.hostRegistry,
              input: taskInput,
              runId: task.runId,
              deadline: new Date(
                options.leaseState ? Date.parse(task.expiresAt) : deadline,
              ).toISOString(),
              signal: options.leaseState?.signal ?? controller?.signal,
              expectedPackageDigest: task.employee.packageDigest,
              onEvent: appendEvent,
            })
            if (options.leaseState?.signal.aborted || controller?.signal.aborted) {
              outcome = {
                status: "cancelled_by_runner",
                reasonCode: "lease_deadline_reached",
              }
            } else {
              outcome = outcomeFromRun(result)
            }
          } catch {
            outcome = failedOutcome("runner_execution_failed")
          } finally {
            if (timeout) clearTimeout(timeout)
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof RunnerExecutionError) {
      outcome = failedOutcome(error.code.toLowerCase())
    } else {
      outcome = failedOutcome("runner_execution_failed")
    }
  } finally {
    await snapshot?.cleanup()
  }

  const completedAt = now()
  const finalLeaseExpiry = options.leaseState
    ? Date.parse(options.leaseState.leaseExpiresAt)
    : Date.parse(task.leaseExpiresAt)
  if (completedAt.getTime() >= Date.parse(task.expiresAt)) {
    executionError("RUNNER_TASK_EXPIRED")
  }
  if (completedAt.getTime() >= finalLeaseExpiry) {
    executionError("RUNNER_LEASE_EXPIRED")
  }
  if (
    options.leaseState?.signal.aborted ||
    completedAt.getTime() >=
      finalLeaseExpiry - RUNNER_LEASE_SAFETY_MARGIN_MS
  ) {
    outcome = {
      status: "cancelled_by_runner",
      reasonCode: "lease_deadline_reached",
    }
  }
  const usage: RunnerUsageSummary = {
    inputTokens,
    outputTokens,
    durationMilliseconds: Math.max(
      0,
      completedAt.getTime() - startedAt.getTime(),
    ),
    actions: [...actions]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, count]) => ({ name, count })),
  }
  const receipt: RunnerReceiptPayload = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.receipt",
    taskId: task.taskId,
    runId: task.runId,
    attempt: task.attempt,
    fencingToken: task.fencingToken,
    leaseId: task.leaseId,
    quoteId: task.quoteId,
    reservationId: task.reservationId,
    sellerId: task.sellerId,
    runnerId: task.runnerId,
    employee: task.employee,
    engine: task.engine,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    eventCount: events.length,
    finalEventDigest: previousDigest,
    usage,
    outcome,
  }
  const normalizedReceipt = validateRunnerReceipt(receipt)
  const signedReceipt = signRunnerReceipt({
    receipt: normalizedReceipt,
    keyId: options.receiptKeyId,
    privateKey: receiptPrivateKey,
  })
  return Object.freeze({
    task: options.leaseState?.task ?? task,
    leaseEnvelope: options.leaseState?.envelope ?? envelope,
    events: Object.freeze([...events]) as unknown as RunnerEvent[],
    receipt: normalizedReceipt,
    signedReceipt,
  })
}
