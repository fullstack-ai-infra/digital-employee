import assert from "node:assert/strict"
import test from "node:test"

import { InMemoryRunnerReplayGuard } from "../../packages/core/src/runner-replay-guard.js"

const claim = {
  runnerId: "runner-1",
  taskId: "task-1",
  nonce: Buffer.alloc(16, 1).toString("base64url"),
  fencingToken: 1,
  expiresAt: "2026-08-04T00:05:00.000Z",
}

test("replay guard atomically consumes a runner nonce", () => {
  const guard = new InMemoryRunnerReplayGuard({
    clock: () => new Date("2026-08-04T00:00:00.000Z"),
  })
  assert.equal(guard.claim(claim), true)
  assert.equal(guard.claim({ ...claim, taskId: "different-task" }), false)
  assert.equal(
    guard.claim({
      ...claim,
      nonce: Buffer.alloc(16, 2).toString("base64url"),
    }),
    true,
  )
})

test("replay guard prunes expired claims and fails closed at capacity", () => {
  let now = new Date("2026-08-04T00:00:00.000Z")
  const guard = new InMemoryRunnerReplayGuard({
    maxEntries: 1,
    clock: () => now,
  })
  assert.equal(guard.claim(claim), true)
  assert.throws(
    () =>
      guard.claim({
        ...claim,
        nonce: Buffer.alloc(16, 2).toString("base64url"),
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RUNNER_REPLAY_GUARD_CAPACITY",
  )
  now = new Date("2026-08-04T00:05:00.000Z")
  assert.equal(
    guard.claim({
      ...claim,
      nonce: Buffer.alloc(16, 2).toString("base64url"),
      expiresAt: "2026-08-04T00:10:00.000Z",
    }),
    true,
  )
})

test("replay guard rejects expired claims and bad clocks", () => {
  const expired = new InMemoryRunnerReplayGuard({
    clock: () => new Date("2026-08-04T00:05:00.000Z"),
  })
  assert.equal(expired.claim(claim), false)
  const broken = new InMemoryRunnerReplayGuard({
    clock: () => new Date(Number.NaN),
  })
  assert.throws(
    () => broken.claim(claim),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RUNNER_REPLAY_CLOCK_INVALID",
  )
})

test("replay guard rejects a lower fencing token but accepts an equal token with a new nonce", () => {
  const guard = new InMemoryRunnerReplayGuard({
    clock: () => new Date("2026-08-04T00:00:00.000Z"),
  })
  assert.equal(guard.claim({ ...claim, fencingToken: 9 }), true)
  assert.equal(
    guard.claim({
      ...claim,
      runnerId: "runner-2",
      nonce: Buffer.alloc(16, 2).toString("base64url"),
      fencingToken: 8,
    }),
    false,
  )
  assert.equal(
    guard.claim({
      ...claim,
      nonce: Buffer.alloc(16, 3).toString("base64url"),
      fencingToken: 9,
    }),
    true,
  )
})

test("replay guard retains a task high-watermark after the higher nonce expires", () => {
  let now = new Date("2026-08-04T00:00:00.000Z")
  const guard = new InMemoryRunnerReplayGuard({ clock: () => now })
  assert.equal(
    guard.claim({
      ...claim,
      fencingToken: 9,
      expiresAt: "2026-08-04T00:01:00.000Z",
    }),
    true,
  )
  assert.equal(
    guard.claim({
      ...claim,
      nonce: Buffer.alloc(16, 2).toString("base64url"),
      fencingToken: 8,
      expiresAt: "2026-08-04T00:10:00.000Z",
    }),
    false,
  )

  now = new Date("2026-08-04T00:01:00.000Z")
  assert.equal(
    guard.claim({
      ...claim,
      nonce: Buffer.alloc(16, 3).toString("base64url"),
      fencingToken: 8,
      expiresAt: "2026-08-04T00:10:00.000Z",
    }),
    false,
  )
  assert.equal(
    guard.claim({
      ...claim,
      nonce: Buffer.alloc(16, 4).toString("base64url"),
      fencingToken: 9,
      expiresAt: "2026-08-04T00:10:00.000Z",
    }),
    true,
  )
})

test("replay guard fails closed atomically when task watermark capacity is exhausted", () => {
  let now = new Date("2026-08-04T00:00:00.000Z")
  const guard = new InMemoryRunnerReplayGuard({ maxEntries: 1, clock: () => now })
  assert.equal(
    guard.claim({
      ...claim,
      fencingToken: 9,
      expiresAt: "2026-08-04T00:01:00.000Z",
    }),
    true,
  )

  now = new Date("2026-08-04T00:01:00.000Z")
  assert.throws(
    () =>
      guard.claim({
        ...claim,
        taskId: "task-2",
        nonce: Buffer.alloc(16, 2).toString("base64url"),
        fencingToken: 20,
        expiresAt: "2026-08-04T00:10:00.000Z",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RUNNER_REPLAY_GUARD_CAPACITY",
  )
  assert.equal(
    guard.claim({
      ...claim,
      nonce: Buffer.alloc(16, 2).toString("base64url"),
      fencingToken: 9,
      expiresAt: "2026-08-04T00:10:00.000Z",
    }),
    true,
  )
})

test("replay guard capacity rejection does not advance an existing task watermark", () => {
  let now = new Date("2026-08-04T00:00:00.000Z")
  const guard = new InMemoryRunnerReplayGuard({ maxEntries: 1, clock: () => now })
  assert.equal(
    guard.claim({
      ...claim,
      fencingToken: 9,
      expiresAt: "2026-08-04T00:01:00.000Z",
    }),
    true,
  )
  assert.throws(
    () =>
      guard.claim({
        ...claim,
        nonce: Buffer.alloc(16, 2).toString("base64url"),
        fencingToken: 20,
        expiresAt: "2026-08-04T00:10:00.000Z",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RUNNER_REPLAY_GUARD_CAPACITY",
  )

  now = new Date("2026-08-04T00:01:00.000Z")
  assert.equal(
    guard.claim({
      ...claim,
      nonce: Buffer.alloc(16, 3).toString("base64url"),
      fencingToken: 10,
      expiresAt: "2026-08-04T00:10:00.000Z",
    }),
    true,
  )
})

test("replay guard validates and rejects proxy claims without traps", () => {
  const guard = new InMemoryRunnerReplayGuard({
    clock: () => new Date("2026-08-04T00:00:00.000Z"),
  })
  assert.throws(() => guard.claim({ ...claim, nonce: "short" }))
  assert.throws(() => guard.claim({ ...claim, taskId: "invalid task id" }))
  for (const fencingToken of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => guard.claim({ ...claim, fencingToken }))
  }
  assert.throws(() => guard.claim({ ...claim, fencingToken: "1" as never }))

  let traps = 0
  const proxy = new Proxy(claim, {
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
  assert.throws(() => guard.claim(proxy))
  assert.equal(traps, 0)
})

test("replay guard rejects clock rollback before it can reopen an expired nonce", () => {
  let now = new Date("2026-08-04T00:00:00.000Z")
  const guard = new InMemoryRunnerReplayGuard({ clock: () => now })
  assert.equal(guard.claim(claim), true)
  now = new Date("2026-08-04T00:05:00.000Z")
  assert.equal(
    guard.claim({
      ...claim,
      nonce: Buffer.alloc(16, 2).toString("base64url"),
      expiresAt: "2026-08-04T00:10:00.000Z",
    }),
    true,
  )
  now = new Date("2026-08-04T00:04:59.999Z")
  assert.throws(
    () => guard.claim({ ...claim, expiresAt: "2026-08-04T00:10:00.000Z" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RUNNER_REPLAY_CLOCK_INVALID",
  )
})
