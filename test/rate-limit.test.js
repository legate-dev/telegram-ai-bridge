import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

await mock.module("../src/config.js", {
  namedExports: {
    config: { rateLimitMax: 3, rateLimitWindowMs: 60_000 },
  },
})

const { checkRateLimit } = await import("../src/rate-limit.js")

// ── Allowance ──

test("checkRateLimit allows the first request for a new user", () => {
  const result = checkRateLimit("rl-user-1")
  assert.deepEqual(result, { allowed: true })
})

test("checkRateLimit allows requests up to the configured maximum", () => {
  checkRateLimit("rl-user-2")
  checkRateLimit("rl-user-2")
  const third = checkRateLimit("rl-user-2")
  assert.deepEqual(third, { allowed: true })
})

// ── Blocking ──

test("checkRateLimit blocks a request once the limit is exceeded", () => {
  checkRateLimit("rl-user-3")
  checkRateLimit("rl-user-3")
  checkRateLimit("rl-user-3")
  const blocked = checkRateLimit("rl-user-3")
  assert.equal(blocked.allowed, false)
  assert.ok(typeof blocked.retryAfterMs === "number", "retryAfterMs must be a number")
  assert.ok(blocked.retryAfterMs > 0, "retryAfterMs must be positive")
})

test("checkRateLimit retryAfterMs does not exceed the configured window", () => {
  checkRateLimit("rl-user-4")
  checkRateLimit("rl-user-4")
  checkRateLimit("rl-user-4")
  const blocked = checkRateLimit("rl-user-4")
  assert.ok(blocked.retryAfterMs <= 60_000, "retryAfterMs must not exceed the rate-limit window")
})

// ── Isolation ──

test("checkRateLimit gives independent buckets to different user IDs", () => {
  checkRateLimit("rl-user-5a")
  checkRateLimit("rl-user-5a")
  checkRateLimit("rl-user-5a")
  // user-5a is at the limit, but user-5b is unrelated and must still be allowed
  const result = checkRateLimit("rl-user-5b")
  assert.deepEqual(result, { allowed: true })
})

// ── Type coercion ──

test("checkRateLimit coerces a numeric userId to a string bucket key", () => {
  const result = checkRateLimit(123_456_789)
  assert.equal(result.allowed, true)
})
