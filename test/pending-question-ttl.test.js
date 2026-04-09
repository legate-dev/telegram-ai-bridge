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
    resolveSessionLabel: (binding) => binding?.session_id?.slice(0, 12) ?? "unknown",
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
  setPendingQuestion,
  hasPendingQuestion,
  getPendingQuestion,
} = await import("../src/message-handler.js")

const TTL_MS = config.bridgePendingQuestionTtlMs

// ── TTL expiry ──

test("pending question is removed from the Map after the TTL elapses", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  debugCalls.length = 0

  const chatKey = "ttl-chat-1"
  setPendingQuestion(chatKey, {
    options: [{ label: "Yes" }, { label: "No" }],
    questionText: "Do you agree?",
    binding: {},
    agent: null,
    backend: null,
  })

  assert.ok(hasPendingQuestion(chatKey), "entry should exist immediately after setPendingQuestion")
  assert.ok(getPendingQuestion(chatKey)?.timeoutId, "entry should have a scheduled timeoutId")

  t.mock.timers.tick(TTL_MS + 1)

  assert.ok(!hasPendingQuestion(chatKey), "entry should be removed after TTL has elapsed")
})

test("pending_question.ttl_expired debug log is emitted when the timeout fires", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  debugCalls.length = 0

  const chatKey = "ttl-chat-2"
  setPendingQuestion(chatKey, {
    options: [],
    questionText: "Pick one",
    binding: {},
    agent: null,
    backend: null,
  })

  t.mock.timers.tick(TTL_MS + 1)

  const expiredLog = debugCalls.find(
    (c) => c.event === "pending_question.ttl_expired" && c.data?.chat_id === chatKey,
  )
  assert.ok(expiredLog, "pending_question.ttl_expired debug event should be emitted for the expired chat")
})

// ── Replace-clears-previous-timeout ──

test("replacing a pending question clears the previous timeout so only one deletion occurs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  debugCalls.length = 0

  const chatKey = "ttl-chat-replace"

  // First entry — capture its timeoutId before replacing
  setPendingQuestion(chatKey, {
    options: [{ label: "A" }],
    questionText: "First question",
    binding: {},
    agent: null,
    backend: null,
  })
  const firstTimeoutId = getPendingQuestion(chatKey).timeoutId
  assert.ok(firstTimeoutId, "first entry should have a scheduled timeoutId")

  // Spy on clearTimeout after the first entry is registered so we only
  // capture calls made during the replacement, not during the first set.
  const clearTimeoutSpy = t.mock.method(globalThis, "clearTimeout")

  // Replace with a second entry before the first TTL fires
  setPendingQuestion(chatKey, {
    options: [{ label: "B" }],
    questionText: "Second question",
    binding: {},
    agent: null,
    backend: null,
  })

  // clearTimeout must have been called exactly once with the first entry's timeoutId.
  assert.equal(clearTimeoutSpy.mock.callCount(), 1, "clearTimeout should be called exactly once on replace")
  assert.equal(
    clearTimeoutSpy.mock.calls[0].arguments[0],
    firstTimeoutId,
    "clearTimeout should be called with the first entry's timeoutId",
  )

  // The map should hold the replacement entry's data
  assert.equal(
    getPendingQuestion(chatKey).questionText,
    "Second question",
    "entry should reflect the replacement data, not the original",
  )

  // Advance past the TTL — only the second timeout should fire
  t.mock.timers.tick(TTL_MS + 1)

  assert.ok(!hasPendingQuestion(chatKey), "entry should be removed after TTL")

  // Exactly one ttl_expired log event — not two (first timeout was cancelled)
  const expiredLogs = debugCalls.filter(
    (c) => c.event === "pending_question.ttl_expired" && c.data?.chat_id === chatKey,
  )
  assert.equal(expiredLogs.length, 1, "exactly one ttl_expired event should fire (old timeout was cleared)")
})
