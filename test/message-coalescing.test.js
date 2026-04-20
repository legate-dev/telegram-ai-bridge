import { mock, test } from "node:test"
import assert from "node:assert/strict"
import {
  createMockCtx,
  createMockBackend,
  makeMockBot,
} from "./helpers/message-handler-mocks.js"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"
// Use a fixed debounce window so tests can tick fake timers by a known amount.
process.env.BRIDGE_MESSAGE_DEBOUNCE_MS = "500"

// Telegram's split boundary — matches TELEGRAM_SPLIT_LENGTH in message-handler.js.
// Fragment tests must use a first message of exactly this length to trigger buffering.
const SPLIT = 4096
const LONG = "x".repeat(SPLIT)   // exactly at the boundary → starts a buffer
const SHORT = "short message"    // below boundary → processed immediately

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
const { setupHandlers, getBufferedFragmentCount } = await import("../src/message-handler.js")

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

// ── Per-test reset helper ─────────────────────────────────────────────────────

function resetMocks() {
  // agent: null means "no preferred agent set"; resolvePreferredAgent() will
  // pick the registry default. This mirrors how most real chat bindings start.
  mockDb.binding = { cli: "claude", session_id: "sess-1", agent: null, directory: "/tmp" }
  mockBackend.sendMessageCalls = []
  mockBackend._sendResult = { text: "ok" }
  mockBackend.supported = true
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("short standalone message is processed immediately without debounce delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 5000
  const ctx = createMockCtx({ chatId, text: SHORT })

  // Short messages must NOT start a buffer — they are processed right away.
  await textHandler(ctx)

  assert.equal(mockBackend.sendMessageCalls.length, 1, "backend must be called immediately for short messages")
  assert.equal(mockBackend.sendMessageCalls[0].text, SHORT)
  assert.equal(getBufferedFragmentCount(String(chatId)), 0, "no buffer should be created for short messages")
})

test("two short messages sent in rapid succession are NOT merged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 5009
  const ctx1 = createMockCtx({ chatId, text: "First short message" })
  const ctx2 = createMockCtx({ chatId, text: "Second short message" })

  // Both are below the split boundary — each must reach the backend independently.
  await textHandler(ctx1)
  await textHandler(ctx2)

  assert.equal(mockBackend.sendMessageCalls.length, 2, "each short message must produce its own backend call")
  assert.equal(mockBackend.sendMessageCalls[0].text, "First short message")
  assert.equal(mockBackend.sendMessageCalls[1].text, "Second short message")
})

test("full-length first fragment starts a buffer and is not dispatched immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 5010
  await textHandler(createMockCtx({ chatId, text: LONG }))

  // Message at the split boundary: a buffer must be created, backend not yet called.
  assert.equal(getBufferedFragmentCount(String(chatId)), 1, "first full-length fragment should be buffered")
  assert.equal(mockBackend.sendMessageCalls.length, 0, "backend must not be called before the debounce window")

  // Advance past the window — flush fires with just the one fragment.
  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 1)
  assert.equal(mockBackend.sendMessageCalls[0].text, LONG)
})

test("two fragments (full + short) are coalesced into a single backend call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 5001
  const ctx1 = createMockCtx({ chatId, text: LONG })
  const ctx2 = createMockCtx({ chatId, text: "Final fragment" })

  // First fragment at split boundary starts the buffer.
  await textHandler(ctx1)
  // Second fragment (shorter, final piece) is appended to the existing buffer.
  await textHandler(ctx2)

  assert.equal(
    getBufferedFragmentCount(String(chatId)),
    2,
    "both fragments should be buffered before the debounce window closes",
  )
  assert.equal(mockBackend.sendMessageCalls.length, 0, "backend must not be called before the debounce window closes")

  // Advance past the debounce window, then drain the async callback.
  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 1, "exactly one backend call after debounce")
  assert.equal(
    mockBackend.sendMessageCalls[0].text,
    `${LONG}Final fragment`,
    "backend must receive the joined text",
  )
})

test("three fragments reset the timer each time — only one backend call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 5003
  // First fragment at the boundary starts the buffer.
  await textHandler(createMockCtx({ chatId, text: LONG }))
  // Advance partway — still within the debounce window; should NOT flush yet.
  t.mock.timers.tick(DEBOUNCE_MS - 10)
  assert.equal(mockBackend.sendMessageCalls.length, 0, "must not flush while window is still active")

  await textHandler(createMockCtx({ chatId, text: "Part two" }))
  t.mock.timers.tick(DEBOUNCE_MS - 10)
  assert.equal(mockBackend.sendMessageCalls.length, 0, "must not flush while window is still active")

  await textHandler(createMockCtx({ chatId, text: "Part three" }))
  // Advance past the window from the LAST fragment.
  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 1, "exactly one backend call for all three fragments")
  assert.equal(
    mockBackend.sendMessageCalls[0].text,
    `${LONG}Part twoPart three`,
    "all fragments must be joined in order",
  )
})

test("fragments from different chats are buffered independently", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatA = 5004
  const chatB = 5005

  await textHandler(createMockCtx({ chatId: chatA, text: LONG }))
  await textHandler(createMockCtx({ chatId: chatB, text: LONG }))
  await textHandler(createMockCtx({ chatId: chatA, text: "Chat A final" }))

  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 2, "one call per chat")

  const callA = mockBackend.sendMessageCalls.find((c) => c.text.includes("Chat A final"))
  const callB = mockBackend.sendMessageCalls.find((c) => !c.text.includes("Chat A final"))

  assert.ok(callA, "expected a backend call for chat A")
  assert.equal(callA.text, `${LONG}Chat A final`)
  assert.ok(callB, "expected a backend call for chat B")
  assert.equal(callB.text, LONG)
})

test("buffer is cleared after flush so subsequent messages start a fresh buffer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  const chatId = 5006

  // First turn: two fragments (full + final shorter piece).
  await textHandler(createMockCtx({ chatId, text: LONG }))
  await textHandler(createMockCtx({ chatId, text: "Turn 1 final" }))
  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 1)
  assert.equal(mockBackend.sendMessageCalls[0].text, `${LONG}Turn 1 final`)

  // Second turn: short standalone — must NOT be joined with the first turn.
  await textHandler(createMockCtx({ chatId, text: "Turn 2 standalone" }))

  assert.equal(mockBackend.sendMessageCalls.length, 2)
  assert.equal(mockBackend.sendMessageCalls[1].text, "Turn 2 standalone")
})

test("4096-char fragment with trailing whitespace is still detected as a split boundary", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  resetMocks()

  // Telegram's raw message is exactly 4096 chars including a trailing newline.
  // After trim() the length is 4095, which would miss the boundary check if we
  // used text.length instead of rawText.length.
  const SPLIT = 4096
  const rawFragment = "x".repeat(SPLIT - 1) + "\n"  // raw length = 4096, trimmed = 4095
  const chatId = 5007

  await textHandler(createMockCtx({ chatId, text: rawFragment }))

  assert.equal(
    getBufferedFragmentCount(String(chatId)),
    1,
    "fragment with trailing whitespace must be recognised as a split boundary and buffered",
  )
  assert.equal(mockBackend.sendMessageCalls.length, 0, "backend must not be called before the debounce window")

  await textHandler(createMockCtx({ chatId, text: "Final part" }))

  t.mock.timers.tick(DEBOUNCE_MS + 1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mockBackend.sendMessageCalls.length, 1, "both fragments must be coalesced into one call")
  // Raw fragments are concatenated directly (join "") with no trimming applied to
  // the combined result. Trimming would corrupt code blocks and structured prompts
  // that rely on precise leading/trailing whitespace. The first rawText is
  // "x".repeat(4095) + "\n" and the second is "Final part", so the combined
  // result preserves the "\n" exactly as the user typed it.
  assert.equal(
    mockBackend.sendMessageCalls[0].text,
    `${"x".repeat(SPLIT - 1)}\nFinal part`,
    "raw fragments must be concatenated without any extra delimiter or trimming",
  )
})

