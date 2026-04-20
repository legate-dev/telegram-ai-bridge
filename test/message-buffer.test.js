import { mock, test } from "node:test"
import assert from "node:assert/strict"
import {
  createMockCtx,
  createCallbackCtx,
  createMockBackend,
  makeMockBot,
} from "./helpers/message-handler-mocks.js"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"
// Use a fixed debounce window so tests can tick fake timers by a known amount.
process.env.BRIDGE_MESSAGE_DEBOUNCE_MS = "500"

// Telegram's split boundary — matches TELEGRAM_SPLIT_LENGTH in message-handler.js.
const SPLIT = 4096
const LONG = "x".repeat(SPLIT)  // exactly at the boundary → starts a buffer

// ── Mutable mock state ──────────────────────────────────────────────────────

const mockDb = {
  binding: null,
}

const mockBackend = createMockBackend()

// ── Module mocks (must be set up before importing message-handler.js) ────────

await mock.module("grammy", {
  namedExports: {
    InlineKeyboard: class {
      text() { return this }
      row() { return this }
    },
  },
})

await mock.module("../src/db.js", {
  namedExports: {
    getChatBinding: () => mockDb.binding,
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
    getBackend: () => mockBackend,
    supportedClis: () => ["claude"],
  },
})

await mock.module("../src/commands.js", {
  namedExports: {
    createNewSession: async () => {},
  },
})

await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    redactString: (s) => s,
  },
})

await mock.module("../src/telegram-utils.js", {
  namedExports: {
    replyChunks: async (ctx, text) => ctx.reply(text),
    resolvePreferredAgent: () => "default-agent",
    hasBoundSession: (b) => !!(b?.session_id && b?.directory),
    displayPath: (p) => p ?? "/",
    explainBackendFailure: async (ctx, _binding, error) => ctx.reply(`Error: ${error.message}`),
    registerPath: () => "fakehash",
    resolvePath: () => null,
    parseUserPath: (raw) => ({ ok: true, path: raw }),
    validateWorkspaceDirectory: () => ({ ok: true }),
    resolveSessionLabel: (binding) => binding?.session_id?.slice(0, 12) ?? "unknown",
  },
})

// ── Import module under test ─────────────────────────────────────────────────

const { config } = await import("../src/config.js")
const { setupHandlers, getBufferedFragmentCount, clearMessageBuffer } = await import("../src/message-handler.js")

const DEBOUNCE_MS = config.bridgeMessageDebounceMs

// ── Wire up handlers once ─────────────────────────────────────────────────────

const fakeRegistrySnapshot = {
  bridgeDefault: "default-agent",
  primaryAgents: ["default-agent"],
  bridgeAgentFallbacks: [],
}
const fakeRegistry = {
  get: () => fakeRegistrySnapshot,
  refresh: async () => fakeRegistrySnapshot,
}

const bot = makeMockBot()
setupHandlers(bot, null, fakeRegistry)

const textHandler = bot.handlers["message:text"]
const callbackHandler = bot.handlers["callback_query:data"]

// ── Per-test reset helper ─────────────────────────────────────────────────────

function resetMocks() {
  mockDb.binding = { cli: "claude", session_id: "sess-1", agent: null, directory: "/tmp" }
  mockBackend.sendMessageCalls = []
  mockBackend._sendResult = { text: "ok" }
  mockBackend.supported = true
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("clearMessageBuffer is a no-op when no buffer exists for the chat", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  // Should not throw when the chat has no buffered entry
  clearMessageBuffer("9001")
  assert.equal(getBufferedFragmentCount("9001"), 0)
})

test("clearMessageBuffer removes buffered fragments and cancels the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 9002
  await textHandler(createMockCtx({ chatId, text: LONG }))
  assert.equal(getBufferedFragmentCount(String(chatId)), 1, "one fragment should be buffered")

  clearMessageBuffer(String(chatId))
  assert.equal(getBufferedFragmentCount(String(chatId)), 0, "buffer must be empty after clear")

  // Advance past the debounce window — the cancelled timer must not fire
  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 0, "backend must NOT be called after buffer is cleared")
})

test("clearMessageBuffer is idempotent — calling it twice on the same chat is safe", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 9003
  await textHandler(createMockCtx({ chatId, text: LONG }))

  clearMessageBuffer(String(chatId))
  clearMessageBuffer(String(chatId))  // second call: no-op

  assert.equal(getBufferedFragmentCount(String(chatId)), 0)

  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 0, "backend must not be called after double-clear")
})

test("after clearMessageBuffer, a new long message starts a fresh buffer that flushes normally", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 9004
  // First message goes into the buffer, then gets cleared
  await textHandler(createMockCtx({ chatId, text: LONG }))
  clearMessageBuffer(String(chatId))
  assert.equal(getBufferedFragmentCount(String(chatId)), 0)

  // A subsequent long message should open a fresh buffer
  await textHandler(createMockCtx({ chatId, text: LONG }))
  assert.equal(getBufferedFragmentCount(String(chatId)), 1, "fresh buffer should start after clear")

  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 1, "fresh buffer must flush normally")
  assert.equal(mockBackend.sendMessageCalls[0].text, LONG)
})

test("callback query handler does not clear the message buffer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 9005
  // Buffer a long fragment
  await textHandler(createMockCtx({ chatId, text: LONG }))
  assert.equal(getBufferedFragmentCount(String(chatId)), 1)

  // Simulate an unrecognized callback query (inline keyboard tap) — buffer must survive
  const cbCtx = createCallbackCtx({ chatId, data: "unrelated:action" })
  await callbackHandler(cbCtx)

  assert.equal(
    getBufferedFragmentCount(String(chatId)),
    1,
    "buffer must not be cleared by a callback query",
  )

  // The buffer should still flush normally after the debounce window
  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 1, "buffered text must flush after callback query")
  assert.equal(mockBackend.sendMessageCalls[0].text, LONG)
})
