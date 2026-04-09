import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Mock dependencies that telegram-utils.js pulls in
await mock.module("../src/db.js", {
  namedExports: {
    getChatBinding: () => null,
    recentSessions: () => [],
    getCliSessionById: () => null,
  },
})

await mock.module("../src/config.js", {
  namedExports: {
    config: {
      telegramAllowedUserId: "12345",
      defaultDirectory: process.cwd(),
      logLevel: "error",
    },
  },
})

await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    redactString: (s) => s,
  },
})

const { registerPath, resolvePath } = await import("../src/telegram-utils.js")

// ── registerPath ──

test("registerPath returns a hash of exactly 12 hex characters", () => {
  const hash = registerPath("/some/path")
  assert.equal(hash.length, 12)
  assert.match(hash, /^[0-9a-f]{12}$/)
})

test("registerPath is deterministic — same path returns same hash", () => {
  const p = "/Users/alice/projects/my-app"
  assert.equal(registerPath(p), registerPath(p))
})

test("two different paths return different hashes (collision sanity)", () => {
  const h1 = registerPath("/path/one/project-alpha")
  const h2 = registerPath("/path/two/project-beta")
  assert.notEqual(h1, h2)
})

test("newws: callback_data is ≤ 64 bytes even for a very long path", () => {
  const longPath = "/tmp/a-fifty-nine-character-path-that-exceeds-the-limit-x/y"
  assert.ok(longPath.length > 50, "test path is long enough to be a problem without hashing")
  const hash = registerPath(longPath)
  const callbackData = `newws:${hash}`
  assert.ok(
    Buffer.byteLength(callbackData, "utf8") <= 64,
    `callback_data length ${Buffer.byteLength(callbackData, "utf8")} exceeds 64 bytes`,
  )
})

test("newcli: callback_data is ≤ 64 bytes even for a very long path", () => {
  const longPath = "/Users/alice/development/my-company/projects/api-gateway"
  const hash = registerPath(longPath)
  const callbackData = `newcli:claude:${hash}`
  assert.ok(
    Buffer.byteLength(callbackData, "utf8") <= 64,
    `callback_data length ${Buffer.byteLength(callbackData, "utf8")} exceeds 64 bytes`,
  )
})

// ── resolvePath ──

test("resolvePath returns the original path for a valid hash", () => {
  const original = "/home/user/my-project"
  const hash = registerPath(original)
  assert.equal(resolvePath(hash), original)
})

test("resolvePath returns null for an unknown hash", () => {
  assert.equal(resolvePath("deadbeef0000"), null)
})

test("resolvePath returns null for an expired entry", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] })
  const path = "/some/path/that/will/expire"
  const hash = registerPath(path)
  assert.equal(resolvePath(hash), path, "entry resolves before expiry")
  // Advance time past the TTL (10 min) plus the cleanup buffer (+1 s) used in registerPath
  t.mock.timers.tick(10 * 60 * 1000 + 2000)
  assert.equal(resolvePath(hash), null, "entry is null after expiry")
})

test("re-registering a path resets the TTL — entry survives past the original timer", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] })
  const filePath = "/home/user/project-to-refresh"
  const hash = registerPath(filePath)
  // Advance to just before the original timer fires (TTL but not +1000ms buffer)
  t.mock.timers.tick(10 * 60 * 1000)
  // Re-register: should clear old timer and schedule a fresh one from now
  registerPath(filePath)
  // Advance past the original fire point — entry must still be alive
  t.mock.timers.tick(2000)
  assert.equal(resolvePath(hash), filePath, "entry still valid after original timer would have fired")
  // Advance past the NEW TTL — now it should be gone
  t.mock.timers.tick(10 * 60 * 1000 + 2000)
  assert.equal(resolvePath(hash), null, "entry is null after refreshed TTL also expires")
})
