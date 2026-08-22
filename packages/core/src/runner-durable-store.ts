/**
 * Durable store port for Runner local deployments, attempt tracking, and
 * event/receipt outbox. Enables crash recovery by persisting state that
 * survives process restarts.
 *
 * Security invariant: records stored here MUST NEVER contain Host service
 * credentials, private model output, chain-of-thought, or platform-supplied
 * filesystem paths.
 */

import { CoreError, ValidationError } from "./contracts.js"
import type { RunnerReplayClaim, RunnerReplayGuardPort } from "./runner-replay-guard.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current storage schema version for migration detection. */
export const DURABLE_STORE_SCHEMA_VERSION = 1

/** Maximum number of entries in the outbox before overflow rejection. */
export const DURABLE_OUTBOX_MAX_SIZE = 4_096

/** When acknowledged entries exceed this count, compaction is eligible. */
export const DURABLE_OUTBOX_COMPACTION_THRESHOLD = 1_024

/** Maximum number of delivery retries before an entry is marked dead. */
export const DURABLE_OUTBOX_MAX_RETRIES = 16

/** Maximum number of deployment records a store should hold. */
export const DURABLE_STORE_MAX_DEPLOYMENTS = 256

// ---------------------------------------------------------------------------
// Corruption / degraded state
// ---------------------------------------------------------------------------

export type DurableStoreCorruptionKind =
  | "schema_version_mismatch"
  | "checksum_invalid"
  | "data_truncated"
  | "unknown"

export interface DurableStoreCorruption {
  kind: DurableStoreCorruptionKind
  message: string
  detectedAt: string
}

export type DurableStoreDegradedReason =
  | "readonly"
  | "compaction_overdue"
  | "near_capacity"

export interface DurableStoreDegradedState {
  reason: DurableStoreDegradedReason
  message: string
}

// ---------------------------------------------------------------------------
// Deployment record
// ---------------------------------------------------------------------------

/**
 * Binds an employee id/version/digest to a local package reference and
 * agent host identifier. Does NOT store platform-supplied filesystem paths,
 * credentials, or private model output.
 */
export interface RunnerDeploymentRecord {
  /** Stable employee identifier. */
  employeeId: string
  /** Semantic version of the employee package. */
  employeeVersion: string
  /** Content-addressable digest of the employee package (sha256:hex). */
  packageDigest: string
  /** Opaque local reference for the package (e.g. OCI tag, not a path). */
  localPackageRef: string
  /** Identifier of the agent host this deployment targets. */
  agentHostId: string
  /** ISO-8601 timestamp of registration. */
  registeredAt: string
  /** ISO-8601 timestamp of last successful health check (optional). */
  lastHealthCheckAt?: string
}

// ---------------------------------------------------------------------------
// Attempt state
// ---------------------------------------------------------------------------

export type RunnerAttemptStatus =
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "superseded"

export interface RunnerAttemptState {
  /** Task identifier this attempt belongs to. */
  taskId: string
  /** Runner that owns this attempt. */
  runnerId: string
  /** Nonce that was claimed. */
  nonce: string
  /** Fencing token at time of claim. */
  fencingToken: number
  /** Current status. */
  status: RunnerAttemptStatus
  /** Number of events emitted so far. */
  eventsEmitted: number
  /** Receipt digest if completed. */
  receiptDigest?: string
  /** ISO-8601 timestamp of claim. */
  claimedAt: string
  /** ISO-8601 expiry of the claim. */
  expiresAt: string
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export type OutboxEntryKind = "event" | "receipt"

export type OutboxEntryStatus = "pending" | "inflight" | "acknowledged" | "dead"

export interface RunnerOutboxEntry {
  /** Monotonically increasing sequence within the outbox. */
  sequence: number
  /** What this entry carries. */
  kind: OutboxEntryKind
  /** Task identifier this entry relates to. */
  taskId: string
  /** Fencing token at time of append. */
  fencingToken: number
  /** Opaque serialised payload (base64url of canonical JSON). */
  payload: string
  /** Current delivery status. */
  status: OutboxEntryStatus
  /** Number of delivery attempts so far. */
  retryCount: number
  /** ISO-8601 timestamp of next eligible retry. */
  nextRetryAt?: string
  /** ISO-8601 timestamp of creation. */
  createdAt: string
}

// ---------------------------------------------------------------------------
// Outbox port
// ---------------------------------------------------------------------------

export interface RunnerOutbox {
  /** Append an entry. Rejects if outbox is at capacity. */
  append(entry: Omit<RunnerOutboxEntry, "sequence" | "status" | "retryCount" | "createdAt">): RunnerOutboxEntry | Promise<RunnerOutboxEntry>

  /** Return entries eligible for delivery, ordered by sequence. */
  pending(limit: number): RunnerOutboxEntry[] | Promise<RunnerOutboxEntry[]>

  /** Mark an entry as inflight (delivery attempted). */
  markInflight(sequence: number): boolean | Promise<boolean>

  /** Mark delivery as failed, incrementing retry count. Returns false if max retries exceeded (entry goes dead). */
  markRetry(sequence: number, nextRetryAt: string): boolean | Promise<boolean>

  /** Acknowledge successful delivery. */
  ack(sequence: number): boolean | Promise<boolean>

  /** Remove acknowledged/dead entries to reclaim space. Returns number of entries removed. */
  compact(): number | Promise<number>

  /** Current number of entries (all statuses). */
  size(): number | Promise<number>
}

// ---------------------------------------------------------------------------
// Durable store port
// ---------------------------------------------------------------------------

export interface RunnerDurableStorePort {
  // -- Schema / health --
  /** Returns current schema version stored, or null if uninitialised. */
  schemaVersion(): number | null | Promise<number | null>

  /** Detect corruption. Returns null if healthy. */
  detectCorruption(): DurableStoreCorruption | null | Promise<DurableStoreCorruption | null>

  /** Report degraded conditions (non-fatal). */
  degradedState(): DurableStoreDegradedState | null | Promise<DurableStoreDegradedState | null>

  // -- Deployments --
  /** Register or update a deployment record. Rejects if digest mismatches an existing record for same employee+version. */
  putDeployment(record: RunnerDeploymentRecord): void | Promise<void>

  /** Retrieve a deployment by employee id + version. */
  getDeployment(employeeId: string, employeeVersion: string): RunnerDeploymentRecord | undefined | Promise<RunnerDeploymentRecord | undefined>

  /** List all deployment records. */
  listDeployments(): RunnerDeploymentRecord[] | Promise<RunnerDeploymentRecord[]>

  /** Remove a deployment record. */
  removeDeployment(employeeId: string, employeeVersion: string): boolean | Promise<boolean>

  // -- Atomic claim --
  /** Atomically claim a nonce. Returns false if already claimed or fencing token is stale. */
  claimNonce(attempt: RunnerAttemptState): boolean | Promise<boolean>

  /** Get attempt state by taskId + nonce. */
  getAttempt(taskId: string, nonce: string): RunnerAttemptState | undefined | Promise<RunnerAttemptState | undefined>

  /** Advance attempt status. Rejects if fencing token does not match (superseded). */
  advanceAttempt(taskId: string, nonce: string, update: Partial<Pick<RunnerAttemptState, "status" | "eventsEmitted" | "receiptDigest">>): boolean | Promise<boolean>

  // -- Outbox --
  /** Access the outbox. */
  outbox(): RunnerOutbox
}

// ---------------------------------------------------------------------------
// DurableRunnerReplayGuard
// ---------------------------------------------------------------------------

/**
 * Replay guard backed by a durable store. Claims survive process restarts,
 * closing the replay window that InMemoryRunnerReplayGuard leaves open.
 */
export class DurableRunnerReplayGuard implements RunnerReplayGuardPort {
  readonly #store: RunnerDurableStorePort
  readonly #clock: () => Date

  constructor(store: RunnerDurableStorePort, options?: { clock?: () => Date }) {
    this.#store = store
    this.#clock = options?.clock ?? (() => new Date())
  }

  async claim(claim: RunnerReplayClaim): Promise<boolean> {
    if (
      !claim ||
      typeof claim !== "object" ||
      typeof claim.runnerId !== "string" ||
      typeof claim.taskId !== "string" ||
      typeof claim.nonce !== "string" ||
      typeof claim.fencingToken !== "number" ||
      !Number.isSafeInteger(claim.fencingToken) ||
      claim.fencingToken < 1 ||
      typeof claim.expiresAt !== "string"
    ) {
      throw new ValidationError("runner_replay_claim_invalid")
    }

    const now = this.#clock()
    const expiryMs = Date.parse(claim.expiresAt)
    if (!Number.isFinite(expiryMs) || expiryMs <= now.getTime()) {
      return false
    }

    const attemptState: RunnerAttemptState = {
      taskId: claim.taskId,
      runnerId: claim.runnerId,
      nonce: claim.nonce,
      fencingToken: claim.fencingToken,
      status: "claimed",
      eventsEmitted: 0,
      claimedAt: now.toISOString(),
      expiresAt: claim.expiresAt,
    }

    return this.#store.claimNonce(attemptState)
  }
}

// ---------------------------------------------------------------------------
// In-memory reference implementation (for tests only)
// ---------------------------------------------------------------------------

/**
 * Reference-only in-memory implementation of RunnerDurableStorePort.
 * NOT suitable for production use — data is lost on process exit.
 */
export class InMemoryDurableStore implements RunnerDurableStorePort {
  readonly #deployments = new Map<string, RunnerDeploymentRecord>()
  readonly #attempts = new Map<string, RunnerAttemptState>()
  readonly #outbox: InMemoryOutbox
  readonly #version: number = DURABLE_STORE_SCHEMA_VERSION
  #corrupted: DurableStoreCorruption | null = null

  constructor() {
    this.#outbox = new InMemoryOutbox()
  }

  schemaVersion(): number {
    return this.#version
  }

  detectCorruption(): DurableStoreCorruption | null {
    return this.#corrupted
  }

  degradedState(): DurableStoreDegradedState | null {
    const size = this.#outbox.size()
    if (size > DURABLE_OUTBOX_MAX_SIZE * 0.9) {
      return { reason: "near_capacity", message: "Outbox is near capacity" }
    }
    return null
  }

  /** Inject corruption for testing purposes. */
  _injectCorruption(corruption: DurableStoreCorruption): void {
    this.#corrupted = corruption
  }

  // -- Deployments --

  putDeployment(record: RunnerDeploymentRecord): void {
    const key = `${record.employeeId}::${record.employeeVersion}`
    const existing = this.#deployments.get(key)
    if (existing && existing.packageDigest !== record.packageDigest) {
      throw new CoreError(
        "DURABLE_STORE_DIGEST_MISMATCH",
        `Package digest mismatch for ${record.employeeId}@${record.employeeVersion}: ` +
          `existing=${existing.packageDigest}, incoming=${record.packageDigest}`,
        { retryable: false },
      )
    }
    if (this.#deployments.size >= DURABLE_STORE_MAX_DEPLOYMENTS && !existing) {
      throw new CoreError(
        "DURABLE_STORE_CAPACITY",
        "Maximum deployment records exceeded",
        { retryable: false },
      )
    }
    this.#deployments.set(key, { ...record })
  }

  getDeployment(employeeId: string, employeeVersion: string): RunnerDeploymentRecord | undefined {
    return this.#deployments.get(`${employeeId}::${employeeVersion}`)
  }

  listDeployments(): RunnerDeploymentRecord[] {
    return [...this.#deployments.values()]
  }

  removeDeployment(employeeId: string, employeeVersion: string): boolean {
    return this.#deployments.delete(`${employeeId}::${employeeVersion}`)
  }

  // -- Atomic claim --

  claimNonce(attempt: RunnerAttemptState): boolean {
    const key = `${attempt.taskId}::${attempt.nonce}`
    if (this.#attempts.has(key)) return false

    // Check fencing: if a newer fencing token exists for this task, reject.
    // A zero token can only come from the legacy replay adapter, which lost
    // the verified value. Fail closed because its ordering cannot be proven.
    for (const existing of this.#attempts.values()) {
      if (
        existing.taskId === attempt.taskId &&
        (existing.fencingToken === 0 || existing.fencingToken > attempt.fencingToken)
      ) {
        return false
      }
    }

    this.#attempts.set(key, { ...attempt })
    return true
  }

  getAttempt(taskId: string, nonce: string): RunnerAttemptState | undefined {
    return this.#attempts.get(`${taskId}::${nonce}`)
  }

  advanceAttempt(
    taskId: string,
    nonce: string,
    update: Partial<Pick<RunnerAttemptState, "status" | "eventsEmitted" | "receiptDigest">>,
  ): boolean {
    const key = `${taskId}::${nonce}`
    const existing = this.#attempts.get(key)
    if (!existing) return false

    // Check fencing: if a newer claim exists for this task, reject advancement
    for (const other of this.#attempts.values()) {
      if (other.taskId === taskId && other.nonce !== nonce && other.fencingToken > existing.fencingToken) {
        // Mark the old attempt as superseded
        existing.status = "superseded"
        this.#attempts.set(key, existing)
        return false
      }
    }

    if (update.status !== undefined) existing.status = update.status
    if (update.eventsEmitted !== undefined) existing.eventsEmitted = update.eventsEmitted
    if (update.receiptDigest !== undefined) existing.receiptDigest = update.receiptDigest
    this.#attempts.set(key, existing)
    return true
  }

  // -- Outbox --

  outbox(): RunnerOutbox {
    return this.#outbox
  }
}

/**
 * Reference-only in-memory outbox. NOT for production.
 */
class InMemoryOutbox implements RunnerOutbox {
  readonly #entries: RunnerOutboxEntry[] = []
  #nextSequence = 1

  append(entry: Omit<RunnerOutboxEntry, "sequence" | "status" | "retryCount" | "createdAt">): RunnerOutboxEntry {
    if (this.#entries.length >= DURABLE_OUTBOX_MAX_SIZE) {
      throw new CoreError(
        "DURABLE_OUTBOX_OVERFLOW",
        "Outbox has reached maximum capacity",
        { retryable: true },
      )
    }
    const full: RunnerOutboxEntry = {
      ...entry,
      sequence: this.#nextSequence++,
      status: "pending",
      retryCount: 0,
      createdAt: new Date().toISOString(),
    }
    this.#entries.push(full)
    return full
  }

  pending(limit: number): RunnerOutboxEntry[] {
    const now = new Date().toISOString()
    return this.#entries
      .filter(
        (e) =>
          e.status === "pending" ||
          (e.status === "inflight" && e.nextRetryAt && e.nextRetryAt <= now),
      )
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit)
  }

  markInflight(sequence: number): boolean {
    const entry = this.#entries.find((e) => e.sequence === sequence)
    if (!entry || entry.status === "acknowledged" || entry.status === "dead") return false
    entry.status = "inflight"
    return true
  }

  markRetry(sequence: number, nextRetryAt: string): boolean {
    const entry = this.#entries.find((e) => e.sequence === sequence)
    if (!entry || entry.status === "acknowledged" || entry.status === "dead") return false
    entry.retryCount++
    if (entry.retryCount >= DURABLE_OUTBOX_MAX_RETRIES) {
      entry.status = "dead"
      return false
    }
    entry.status = "pending"
    entry.nextRetryAt = nextRetryAt
    return true
  }

  ack(sequence: number): boolean {
    const entry = this.#entries.find((e) => e.sequence === sequence)
    if (!entry) return false
    entry.status = "acknowledged"
    return true
  }

  compact(): number {
    let removed = 0
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i].status === "acknowledged" || this.#entries[i].status === "dead") {
        this.#entries.splice(i, 1)
        removed++
      }
    }
    return removed
  }

  size(): number {
    return this.#entries.length
  }
}
