import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"

import {
  DURABLE_OUTBOX_COMPACTION_THRESHOLD,
  DURABLE_OUTBOX_MAX_RETRIES,
  DURABLE_OUTBOX_MAX_SIZE,
  DURABLE_STORE_SCHEMA_VERSION,
  DurableRunnerReplayGuard,
  InMemoryDurableStore,
} from "../../packages/core/src/runner-durable-store.js"
import type {
  RunnerAttemptState,
  RunnerDeploymentRecord,
} from "../../packages/core/src/runner-durable-store.js"

function makeDeployment(overrides?: Partial<RunnerDeploymentRecord>): RunnerDeploymentRecord {
  return {
    employeeId: "emp-001",
    employeeVersion: "1.0.0",
    packageDigest: "sha256:" + "a".repeat(64),
    localPackageRef: "oci://registry.local/emp-001:1.0.0",
    agentHostId: "host-alpha",
    registeredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeAttempt(overrides?: Partial<RunnerAttemptState>): RunnerAttemptState {
  return {
    taskId: "task-100",
    runnerId: "runner-A",
    nonce: "dGVzdC1ub25jZS0xMjM0NTY3OA",
    fencingToken: 1,
    status: "claimed",
    eventsEmitted: 0,
    claimedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  }
}

describe("InMemoryDurableStore", () => {
  let store: InMemoryDurableStore

  beforeEach(() => {
    store = new InMemoryDurableStore()
  })

  describe("schema and health", () => {
    it("reports current schema version", () => {
      assert.equal(store.schemaVersion(), DURABLE_STORE_SCHEMA_VERSION)
    })

    it("reports no corruption by default", () => {
      assert.equal(store.detectCorruption(), null)
    })

    it("reports injected corruption", () => {
      store._injectCorruption({
        kind: "checksum_invalid",
        message: "bad checksum",
        detectedAt: "2026-01-01T00:00:00.000Z",
      })
      const c = store.detectCorruption()
      assert.notEqual(c, null)
      assert.equal(c!.kind, "checksum_invalid")
    })

    it("reports no degraded state when healthy", () => {
      assert.equal(store.degradedState(), null)
    })
  })

  describe("deployment CRUD", () => {
    it("puts and retrieves a deployment", () => {
      const dep = makeDeployment()
      store.putDeployment(dep)
      const got = store.getDeployment("emp-001", "1.0.0")
      assert.deepEqual(got, dep)
    })

    it("lists deployments", () => {
      store.putDeployment(makeDeployment())
      store.putDeployment(makeDeployment({ employeeVersion: "2.0.0" }))
      assert.equal(store.listDeployments().length, 2)
    })

    it("removes a deployment", () => {
      store.putDeployment(makeDeployment())
      assert.equal(store.removeDeployment("emp-001", "1.0.0"), true)
      assert.equal(store.getDeployment("emp-001", "1.0.0"), undefined)
    })

    it("returns false removing non-existent deployment", () => {
      assert.equal(store.removeDeployment("nope", "0.0.0"), false)
    })

    it("rejects digest mismatch for same employee+version", () => {
      store.putDeployment(makeDeployment())
      assert.throws(
        () => store.putDeployment(makeDeployment({ packageDigest: "sha256:" + "b".repeat(64) })),
        (err: Error) => err.message.includes("digest mismatch"),
      )
    })

    it("allows update with same digest", () => {
      store.putDeployment(makeDeployment())
      store.putDeployment(makeDeployment({ localPackageRef: "oci://other:1.0.0" }))
      const got = store.getDeployment("emp-001", "1.0.0")
      assert.equal(got!.localPackageRef, "oci://other:1.0.0")
    })
  })

  describe("atomic nonce claim", () => {
    it("claims a nonce successfully", () => {
      assert.equal(store.claimNonce(makeAttempt()), true)
    })

    it("rejects duplicate nonce for same task", () => {
      store.claimNonce(makeAttempt())
      assert.equal(store.claimNonce(makeAttempt()), false)
    })

    it("claim survives simulated restart (new store instance sees old claims)", () => {
      // Simulate restart by creating a new guard over the same store
      store.claimNonce(makeAttempt())
      // A "new process" with a fresh replay guard but same store
      const guard = new DurableRunnerReplayGuard(store)
      // The nonce should already be consumed
      const got = store.getAttempt("task-100", "dGVzdC1ub25jZS0xMjM0NTY3OA")
      assert.notEqual(got, undefined)
      assert.equal(got!.status, "claimed")
    })

    it("rejects claim with stale fencing token", () => {
      store.claimNonce(makeAttempt({ fencingToken: 5 }))
      // New attempt with lower fencing token should be rejected
      const stale = makeAttempt({ nonce: "bmV3LW5vbmNlLTk4NzY1NDMyMQ", fencingToken: 3 })
      assert.equal(store.claimNonce(stale), false)
    })

    it("retrieves attempt state", () => {
      store.claimNonce(makeAttempt())
      const got = store.getAttempt("task-100", "dGVzdC1ub25jZS0xMjM0NTY3OA")
      assert.equal(got!.runnerId, "runner-A")
      assert.equal(got!.fencingToken, 1)
    })
  })

  describe("attempt advancement and fencing", () => {
    it("advances attempt status", () => {
      store.claimNonce(makeAttempt())
      const ok = store.advanceAttempt("task-100", "dGVzdC1ub25jZS0xMjM0NTY3OA", {
        status: "running",
        eventsEmitted: 3,
      })
      assert.equal(ok, true)
      const got = store.getAttempt("task-100", "dGVzdC1ub25jZS0xMjM0NTY3OA")
      assert.equal(got!.status, "running")
      assert.equal(got!.eventsEmitted, 3)
    })

    it("fencing takeover: old attempt cannot advance after new claim", () => {
      // Old attempt
      store.claimNonce(makeAttempt({ fencingToken: 1 }))
      // New attempt with higher fencing token (different nonce)
      store.claimNonce(makeAttempt({ nonce: "bmV3LW5vbmNlLTk4NzY1NDMyMQ", fencingToken: 10 }))
      // Old attempt should fail to advance
      const ok = store.advanceAttempt("task-100", "dGVzdC1ub25jZS0xMjM0NTY3OA", {
        status: "running",
      })
      assert.equal(ok, false)
      // Old attempt should be superseded
      const old = store.getAttempt("task-100", "dGVzdC1ub25jZS0xMjM0NTY3OA")
      assert.equal(old!.status, "superseded")
    })

    it("returns false for non-existent attempt", () => {
      assert.equal(store.advanceAttempt("nope", "nope", { status: "running" }), false)
    })
  })

  describe("outbox", () => {
    it("appends and retrieves pending entries", async () => {
      const outbox = store.outbox()
      const entry = await outbox.append({
        kind: "event",
        taskId: "task-100",
        fencingToken: 1,
        payload: "dGVzdA",
      })
      assert.equal(entry.sequence, 1)
      assert.equal(entry.status, "pending")
      assert.equal(entry.retryCount, 0)

      const pending = await outbox.pending(10)
      assert.equal(pending.length, 1)
      assert.equal(pending[0].sequence, 1)
    })

    it("marks entry inflight", async () => {
      const outbox = store.outbox()
      await outbox.append({ kind: "event", taskId: "t1", fencingToken: 1, payload: "x" })
      assert.equal(await outbox.markInflight(1), true)
    })

    it("acknowledges entry", async () => {
      const outbox = store.outbox()
      await outbox.append({ kind: "receipt", taskId: "t1", fencingToken: 1, payload: "x" })
      await outbox.markInflight(1)
      assert.equal(await outbox.ack(1), true)
      // No longer shows in pending
      const pending = await outbox.pending(10)
      assert.equal(pending.length, 0)
    })

    it("retries entry and respects max retries", async () => {
      const outbox = store.outbox()
      await outbox.append({ kind: "event", taskId: "t1", fencingToken: 1, payload: "x" })
      await outbox.markInflight(1)

      // Retry up to max - 1 times
      for (let i = 0; i < DURABLE_OUTBOX_MAX_RETRIES - 1; i++) {
        assert.equal(await outbox.markRetry(1, "2026-01-01T00:00:00.000Z"), true)
        await outbox.markInflight(1)
      }
      // Next retry should mark it dead
      assert.equal(await outbox.markRetry(1, "2026-01-01T00:00:00.000Z"), false)
    })

    it("compacts acknowledged and dead entries", async () => {
      const outbox = store.outbox()
      await outbox.append({ kind: "event", taskId: "t1", fencingToken: 1, payload: "a" })
      await outbox.append({ kind: "event", taskId: "t2", fencingToken: 1, payload: "b" })
      await outbox.ack(1)
      const removed = await outbox.compact()
      assert.equal(removed, 1)
      assert.equal(await outbox.size(), 1)
    })

    it("rejects append when at capacity", async () => {
      const outbox = store.outbox()
      // Fill to max
      for (let i = 0; i < DURABLE_OUTBOX_MAX_SIZE; i++) {
        await outbox.append({ kind: "event", taskId: `t${i}`, fencingToken: 1, payload: "x" })
      }
      assert.throws(
        () => outbox.append({ kind: "event", taskId: "overflow", fencingToken: 1, payload: "x" }),
        (err: Error) => err.message.includes("capacity"),
      )
    })

    it("orders entries by sequence", async () => {
      const outbox = store.outbox()
      await outbox.append({ kind: "event", taskId: "t1", fencingToken: 1, payload: "a" })
      await outbox.append({ kind: "event", taskId: "t2", fencingToken: 1, payload: "b" })
      await outbox.append({ kind: "event", taskId: "t3", fencingToken: 1, payload: "c" })
      const pending = await outbox.pending(10)
      assert.deepEqual(
        pending.map((e: any) => e.sequence),
        [1, 2, 3],
      )
    })
  })
})

describe("DurableRunnerReplayGuard", () => {
  let store: InMemoryDurableStore
  let guard: DurableRunnerReplayGuard

  beforeEach(() => {
    store = new InMemoryDurableStore()
    guard = new DurableRunnerReplayGuard(store, {
      clock: () => new Date("2026-01-01T00:01:00.000Z"),
    })
  })

  it("claims a valid replay claim", async () => {
    const ok = await guard.claim({
      runnerId: "runner-A",
      taskId: "task-100",
      nonce: "dGVzdC1ub25jZS0xMjM0NTY3OA",
      fencingToken: 1,
      expiresAt: "2026-01-01T00:05:00.000Z",
    })
    assert.equal(ok, true)
  })

  it("persists the verified fencing token and rejects a lower token after restart", async () => {
    const accepted = await guard.claim({
      runnerId: "runner-A",
      taskId: "task-100",
      nonce: "dGVzdC1ub25jZS0xMjM0NTY3OA",
      fencingToken: 9,
      expiresAt: "2026-01-01T00:05:00.000Z",
    })
    assert.equal(accepted, true)
    assert.equal(
      store.getAttempt("task-100", "dGVzdC1ub25jZS0xMjM0NTY3OA")?.fencingToken,
      9,
    )

    const restarted = new DurableRunnerReplayGuard(store, {
      clock: () => new Date("2026-01-01T00:02:00.000Z"),
    })
    const stale = await restarted.claim({
      runnerId: "runner-A",
      taskId: "task-100",
      nonce: "bmV3LW5vbmNlLTk4NzY1NDMyMQ",
      fencingToken: 8,
      expiresAt: "2026-01-01T00:05:00.000Z",
    })
    assert.equal(stale, false)
  })

  it("rejects duplicate nonce", async () => {
    const claim = {
      runnerId: "runner-A",
      taskId: "task-100",
      nonce: "dGVzdC1ub25jZS0xMjM0NTY3OA",
      fencingToken: 1,
      expiresAt: "2026-01-01T00:05:00.000Z",
    }
    await guard.claim(claim)
    const ok = await guard.claim(claim)
    assert.equal(ok, false)
  })

  it("rejects expired claim", async () => {
    const ok = await guard.claim({
      runnerId: "runner-A",
      taskId: "task-100",
      nonce: "dGVzdC1ub25jZS0xMjM0NTY3OA",
      fencingToken: 1,
      expiresAt: "2026-01-01T00:00:30.000Z", // before clock time
    })
    assert.equal(ok, false)
    assert.equal(
      store.getAttempt("task-100", "dGVzdC1ub25jZS0xMjM0NTY3OA"),
      undefined,
    )
  })

  it("accepts an equal fencing token with a different nonce", async () => {
    assert.equal(
      await guard.claim({
        runnerId: "runner-A",
        taskId: "task-100",
        nonce: "dGVzdC1ub25jZS0xMjM0NTY3OA",
        fencingToken: 5,
        expiresAt: "2026-01-01T00:05:00.000Z",
      }),
      true,
    )
    assert.equal(
      await guard.claim({
        runnerId: "runner-A",
        taskId: "task-100",
        nonce: "bmV3LW5vbmNlLTk4NzY1NDMyMQ",
        fencingToken: 5,
        expiresAt: "2026-01-01T00:05:00.000Z",
      }),
      true,
    )
  })

  it("rejects invalid fencing token numbers without persisting a claim", async () => {
    for (const fencingToken of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () =>
          guard.claim({
            runnerId: "runner-A",
            taskId: "task-100",
            nonce: "dGVzdC1ub25jZS0xMjM0NTY3OA",
            fencingToken,
            expiresAt: "2026-01-01T00:05:00.000Z",
          }),
        (error: Error) => error.message.includes("invalid"),
      )
    }
    assert.equal(
      store.getAttempt("task-100", "dGVzdC1ub25jZS0xMjM0NTY3OA"),
      undefined,
    )
  })

  it("fails closed when a legacy zero-token record makes ordering unknowable", async () => {
    assert.equal(store.claimNonce(makeAttempt({ fencingToken: 0 })), true)
    assert.equal(
      await guard.claim({
        runnerId: "runner-A",
        taskId: "task-100",
        nonce: "bmV3LW5vbmNlLTk4NzY1NDMyMQ",
        fencingToken: 10,
        expiresAt: "2026-01-01T00:05:00.000Z",
      }),
      false,
    )
  })

  it("throws on invalid claim shape", async () => {
    await assert.rejects(
      () => guard.claim(null as any),
      (err: Error) => err.message.includes("invalid"),
    )
  })

  it("claim persists across guard instances (simulated restart)", async () => {
    await guard.claim({
      runnerId: "runner-A",
      taskId: "task-100",
      nonce: "dGVzdC1ub25jZS0xMjM0NTY3OA",
      fencingToken: 1,
      expiresAt: "2026-01-01T00:05:00.000Z",
    })
    // New guard instance, same store (simulates restart)
    const guard2 = new DurableRunnerReplayGuard(store, {
      clock: () => new Date("2026-01-01T00:02:00.000Z"),
    })
    const ok = await guard2.claim({
      runnerId: "runner-A",
      taskId: "task-100",
      nonce: "dGVzdC1ub25jZS0xMjM0NTY3OA",
      fencingToken: 1,
      expiresAt: "2026-01-01T00:05:00.000Z",
    })
    assert.equal(ok, false)
  })
})
