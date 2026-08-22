import { CoreError, ValidationError } from "./contracts.js"
import { types as utilTypes } from "node:util"

const CLAIM_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,199})$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export interface RunnerReplayClaim {
  runnerId: string
  taskId: string
  nonce: string
  fencingToken: number
  expiresAt: string
}

/**
 * Implementations must atomically consume a nonce. Returning false means the
 * nonce was already consumed or durable replay protection is unavailable.
 */
export interface RunnerReplayGuardPort {
  claim(claim: RunnerReplayClaim): boolean | Promise<boolean>
}

export interface InMemoryRunnerReplayGuardOptions {
  /** Independent upper bound for nonce entries and task high-watermarks. */
  maxEntries?: number
  clock?: () => Date
}

function validTimestamp(value: string): number {
  const milliseconds = Date.parse(value)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new ValidationError("runner_replay_claim_invalid")
  }
  return milliseconds
}

/**
 * Process-local preview implementation. Production runners should provide a
 * durable atomic port so restarts cannot reopen the replay window.
 */
export class InMemoryRunnerReplayGuard implements RunnerReplayGuardPort {
  readonly #nonceEntries = new Map<string, number>()
  readonly #taskHighWatermarks = new Map<string, number>()
  readonly #maxEntries: number
  readonly #clock: () => Date
  #lastClockMilliseconds = Number.NEGATIVE_INFINITY

  constructor(options: InMemoryRunnerReplayGuardOptions = {}) {
    const maxEntries = options.maxEntries ?? 10_000
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new ValidationError("runner_replay_guard_max_entries_invalid")
    }
    this.#maxEntries = maxEntries
    this.#clock = options.clock ?? (() => new Date())
  }

  claim(claim: RunnerReplayClaim): boolean {
    let descriptors: Record<string, PropertyDescriptor>
    try {
      if (
        !claim ||
        typeof claim !== "object" ||
        utilTypes.isProxy(claim) ||
        Object.getPrototypeOf(claim) !== Object.prototype
      ) {
        throw new ValidationError("runner_replay_claim_invalid")
      }
      descriptors = Object.getOwnPropertyDescriptors(claim)
      if (
        Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
        Object.keys(descriptors).length !== 5 ||
        !["runnerId", "taskId", "nonce", "fencingToken", "expiresAt"].every((key) => {
          const descriptor = descriptors[key]
          return (
            Object.hasOwn(descriptors, key) &&
            Boolean(descriptor?.enumerable) &&
            "value" in (descriptor ?? {})
          )
        })
      ) {
        throw new ValidationError("runner_replay_claim_invalid")
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error
      throw new ValidationError("runner_replay_claim_invalid")
    }
    const runnerId = descriptors.runnerId.value as unknown
    const taskId = descriptors.taskId.value as unknown
    const nonce = descriptors.nonce.value as unknown
    const fencingToken = descriptors.fencingToken.value as unknown
    const expiresAt = descriptors.expiresAt.value as unknown
    if (
      typeof runnerId !== "string" ||
      typeof taskId !== "string" ||
      typeof nonce !== "string" ||
      typeof fencingToken !== "number" ||
      typeof expiresAt !== "string" ||
      !CLAIM_ID_PATTERN.test(runnerId) ||
      !CLAIM_ID_PATTERN.test(taskId) ||
      !BASE64URL_PATTERN.test(nonce) ||
      !Number.isSafeInteger(fencingToken) ||
      fencingToken < 1
    ) {
      throw new ValidationError("runner_replay_claim_invalid")
    }
    let nonceBytes: Buffer
    try {
      nonceBytes = Buffer.from(nonce, "base64url")
    } catch {
      throw new ValidationError("runner_replay_claim_invalid")
    }
    if (
      nonceBytes.length < 16 ||
      nonceBytes.length > 64 ||
      nonceBytes.toString("base64url") !== nonce
    ) {
      throw new ValidationError("runner_replay_claim_invalid")
    }
    let now: Date
    try {
      now = this.#clock()
    } catch {
      throw new CoreError(
        "RUNNER_REPLAY_CLOCK_INVALID",
        "Runner replay guard clock is unavailable",
        { retryable: false },
      )
    }
    const nowMilliseconds = now instanceof Date ? now.getTime() : Number.NaN
    if (
      !Number.isFinite(nowMilliseconds) ||
      nowMilliseconds < this.#lastClockMilliseconds
    ) {
      throw new CoreError(
        "RUNNER_REPLAY_CLOCK_INVALID",
        "Runner replay guard clock is unavailable",
        { retryable: false },
      )
    }
    this.#lastClockMilliseconds = nowMilliseconds
    const expiryMilliseconds = validTimestamp(expiresAt)
    for (const [key, expiry] of this.#nonceEntries) {
      if (expiry <= nowMilliseconds) this.#nonceEntries.delete(key)
    }
    if (expiryMilliseconds <= nowMilliseconds) return false
    // Consume a nonce across all tasks for one Runner. taskId is validated for
    // auditability but deliberately cannot scope away a replay collision.
    const key = `${runnerId.length}:${runnerId}${nonce.length}:${nonce}`
    if (this.#nonceEntries.has(key)) return false
    const taskKey = taskId
    const highWatermark = this.#taskHighWatermarks.get(taskKey)
    if (highWatermark !== undefined && highWatermark > fencingToken) {
      return false
    }
    if (
      this.#nonceEntries.size >= this.#maxEntries ||
      (highWatermark === undefined &&
        this.#taskHighWatermarks.size >= this.#maxEntries)
    ) {
      throw new CoreError(
        "RUNNER_REPLAY_GUARD_CAPACITY",
        "Runner replay guard cannot safely accept another claim",
        { retryable: true },
      )
    }
    // Capacity and ordering are checked before either table is mutated so a
    // rejected claim cannot consume its nonce or advance a task watermark.
    this.#taskHighWatermarks.set(
      taskKey,
      Math.max(highWatermark ?? fencingToken, fencingToken),
    )
    this.#nonceEntries.set(key, expiryMilliseconds)
    return true
  }
}
