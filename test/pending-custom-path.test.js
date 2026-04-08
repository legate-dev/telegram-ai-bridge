import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Capture debug log calls so tests can assert on them
const debugCalls = []
const mockLog = {
  debug(scope, event, data) { debugCalls.push({ scope, event, data }) },
  info() {},
  warn() {},
  error() {},
}

// ── Module mocks (must be registered before the import below) ──

await mock.module("../src/log.js", {
  namedExports: {
    log: mockLog,
    redactString: (v) => v,
  },
})

await mock.module("../src/db.js", {
  namedExports: {
    getChatBinding: () => null,
    setChatBinding: () => {},
    getCliSessionById: () => null,
  },
})

await mock.module("../src/rate-limit.js", {
  namedExports: {
    checkRateLimit: () => ({ allowed: true }),
  },
})

await mock.module("../src/backends.js", {
  namedExports: {
    getBackend: () => null,
    supportedClis: () => [],
  },
})

await mock.module("../src/commands.js", {
  namedExports: {
    createNewSession: async () => {},
  },
})

await mock.module("../src/telegram-utils.js", {
  namedExports: {
    replyChunks: async () => {},
    resolvePreferredAgent: () => "default",
    hasBoundSession: () => false,
    displayPath: (p) => p,
    explainBackendFailure: async () => {},
    resolveDirectory: (p) => p,
    registerPath: () => "fakehash",
    resolvePath: () => null,
    parseUserPath: (p) => ({ ok: true, path: p }),
    validateWorkspaceDirectory: () => ({ ok: true }),
  },
})

await mock.module("grammy", {
  namedExports: {
    InlineKeyboard: class {
      text() { return this }
      row() { return this }
    },
  },
})

const { config } = await import("../src/config.js")
const {
  hasPendingCustomPath,
  setPendingCustomPath,
  deletePendingCustomPath,
} = await import("../src/message-handler.js")

const TTL_MS = config.bridgePendingPathTtlMs

// ── Presence after set ──

test("hasPendingCustomPath returns true immediately after setPendingCustomPath", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })

  const chatKey = "path-chat-1"
  setPendingCustomPath(chatKey)

  assert.ok(hasPendingCustomPath(chatKey), "entry should exist immediately after setPendingCustomPath")
})

// ── TTL expiry ──

test("pending custom path is removed from the Map after the TTL elapses", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  debugCalls.length = 0

  const chatKey = "path-chat-ttl"
  setPendingCustomPath(chatKey)

  assert.ok(hasPendingCustomPath(chatKey), "entry should exist before TTL")

  t.mock.timers.tick(TTL_MS + 1)

  assert.ok(!hasPendingCustomPath(chatKey), "entry should be removed after TTL has elapsed")
})

// ── Debug log on TTL expiry ──

test("pending_custom_path.ttl_expired debug log is emitted when the timeout fires", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  debugCalls.length = 0

  const chatKey = "path-chat-log"
  setPendingCustomPath(chatKey)

  t.mock.timers.tick(TTL_MS + 1)

  const expiredLog = debugCalls.find(
    (c) => c.event === "pending_custom_path.ttl_expired" && c.data?.chat_id === chatKey,
  )
  assert.ok(expiredLog, "pending_custom_path.ttl_expired debug event should be emitted for the expired chat")
})

// ── Replace-clears-previous-timeout (identity guard) ──

test("replacing an entry via setPendingCustomPath cancels the old timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  debugCalls.length = 0

  const chatKey = "path-chat-replace"

  // First registration
  setPendingCustomPath(chatKey)

  // Spy on clearTimeout after the first entry is registered
  const clearTimeoutSpy = t.mock.method(globalThis, "clearTimeout")

  // Replace with a second registration before the first TTL fires
  setPendingCustomPath(chatKey)

  assert.equal(clearTimeoutSpy.mock.callCount(), 1, "clearTimeout should be called exactly once on replace")

  // Advance past the TTL — only the second timeout should fire
  t.mock.timers.tick(TTL_MS + 1)

  assert.ok(!hasPendingCustomPath(chatKey), "entry should be removed after TTL")

  // Exactly one ttl_expired log event — not two (first timeout was cancelled)
  const expiredLogs = debugCalls.filter(
    (c) => c.event === "pending_custom_path.ttl_expired" && c.data?.chat_id === chatKey,
  )
  assert.equal(expiredLogs.length, 1, "exactly one ttl_expired event should fire (old timeout was cleared)")
})

// ── deletePendingCustomPath cancels timer and removes entry ──

test("deletePendingCustomPath removes the entry and cancels the pending timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  debugCalls.length = 0

  const chatKey = "path-chat-delete"
  setPendingCustomPath(chatKey)

  assert.ok(hasPendingCustomPath(chatKey), "entry should exist before delete")

  const clearTimeoutSpy = t.mock.method(globalThis, "clearTimeout")

  deletePendingCustomPath(chatKey)

  assert.ok(!hasPendingCustomPath(chatKey), "entry should be gone after deletePendingCustomPath")
  assert.equal(clearTimeoutSpy.mock.callCount(), 1, "clearTimeout should be called to cancel the timer")

  // Advance past the TTL — no log should fire since the entry was deleted
  t.mock.timers.tick(TTL_MS + 1)

  const expiredLogs = debugCalls.filter(
    (c) => c.event === "pending_custom_path.ttl_expired" && c.data?.chat_id === chatKey,
  )
  assert.equal(expiredLogs.length, 0, "no ttl_expired event should fire after explicit delete")
})
