/**
 * Tests that the rate-limit check in processTextMessage counts coalesced
 * fragment groups as a single slot, not one slot per fragment.
 *
 * Acceptance criteria from the issue:
 *   (a) single short message = 1 slot consumed
 *   (b) single long (3+ fragment) message = 1 slot consumed
 *   (c) N consecutive short messages = N slots consumed
 */
import { mock, test } from "node:test"
import assert from "node:assert/strict"
import {
  createMockCtx,
  createMockBackend,
  makeMockBot,
} from "./helpers/message-handler-mocks.js"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"
// Fixed debounce window so tests can tick fake timers precisely.
process.env.BRIDGE_MESSAGE_DEBOUNCE_MS = "500"

// Telegram's split boundary — matches TELEGRAM_SPLIT_LENGTH in message-handler.js.
const SPLIT = 4096
const LONG = "x".repeat(SPLIT)   // exactly at the boundary → starts a buffer
const SHORT = "short message"    // below boundary → processed immediately

// ── Mutable mock state ──────────────────────────────────────────────────────

const mockDb = {
  binding: null,
}

const mockBackend = createMockBackend()

// Track checkRateLimit invocations.
const mockRateLimit = {
  callCount: 0,
  result: { allowed: true },
}

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
    checkRateLimit: () => {
      mockRateLimit.callCount++
      return mockRateLimit.result
    },
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
    resolveDirectory: (p) => p ?? "/tmp",
    registerPath: () => "fakehash",
    resolvePath: () => null,
    parseUserPath: (raw) => ({ ok: true, path: raw }),
    validateWorkspaceDirectory: () => ({ ok: true }),
    resolveSessionLabel: (binding) => binding?.session_id?.slice(0, 12) ?? "unknown",
  },
})

// ── Import module under test ─────────────────────────────────────────────────

const { config } = await import("../src/config.js")
const { setupHandlers } = await import("../src/message-handler.js")

const DEBOUNCE_MS = config.bridgeMessageDebounceMs

// ── Wire up handlers once ────────────────────────────────────────────────────

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

// ── Per-test reset helper ─────────────────────────────────────────────────────

function resetMocks() {
  mockDb.binding = { cli: "claude", session_id: "sess-1", agent: null, directory: "/tmp" }
  mockBackend.sendMessageCalls = []
  mockBackend._sendResult = { text: "ok" }
  mockBackend.supported = true
  mockRateLimit.callCount = 0
  mockRateLimit.result = { allowed: true }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("(a) single short message consumes exactly 1 rate-limit slot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 9001
  await textHandler(createMockCtx({ chatId, text: SHORT }))

  assert.equal(mockBackend.sendMessageCalls.length, 1, "backend must be called once")
  assert.equal(mockRateLimit.callCount, 1, "exactly 1 rate-limit slot must be consumed for 1 short message")
})

test("(b) 3-fragment message coalesced into one turn consumes exactly 1 rate-limit slot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 9002
  // Three fragments: two at the split boundary + one shorter final piece.
  await textHandler(createMockCtx({ chatId, text: LONG }))
  await textHandler(createMockCtx({ chatId, text: LONG }))
  await textHandler(createMockCtx({ chatId, text: "final fragment" }))

  // Before the debounce window closes, the backend must not have been called yet.
  assert.equal(mockBackend.sendMessageCalls.length, 0, "backend must not be called before debounce window closes")
  // Rate-limit must not have been checked yet either (fragments are still buffered).
  assert.equal(mockRateLimit.callCount, 0, "rate-limit must not be checked while fragments are buffered")

  // Advance past the debounce window — flush fires with the coalesced turn.
  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 1, "exactly 1 backend call after debounce flush")
  assert.equal(mockRateLimit.callCount, 1, "exactly 1 rate-limit slot must be consumed for the coalesced turn")
  assert.equal(
    mockBackend.sendMessageCalls[0].text,
    `${LONG}${LONG}final fragment`,
    "all three fragments must be joined",
  )
})

test("(c) N consecutive short messages consume N rate-limit slots", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 9003
  const N = 4
  for (let i = 0; i < N; i++) {
    await textHandler(createMockCtx({ chatId, text: `Message ${i + 1}` }))
  }

  assert.equal(mockBackend.sendMessageCalls.length, N, `${N} short messages must each trigger a backend call`)
  assert.equal(mockRateLimit.callCount, N, `${N} rate-limit slots must be consumed for ${N} separate short messages`)
})

test("rate-limited text message is replied to with error and does not reach backend", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()
  mockRateLimit.result = { allowed: false, retryAfterMs: 3000 }

  const chatId = 9004
  const ctx = createMockCtx({ chatId, text: SHORT })
  await textHandler(ctx)

  assert.equal(mockBackend.sendMessageCalls.length, 0, "backend must not be called when rate-limited")
  assert.equal(ctx.replies.length, 1, "user must receive a rate-limit reply")
  assert.ok(ctx.replies[0].text.includes("Rate limit exceeded"), "reply must mention rate limit")
  assert.ok(ctx.replies[0].text.includes("3s"), "reply must include retry time in seconds")
})
