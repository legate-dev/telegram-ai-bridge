import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Mutable mock DB state. bindingSequence lets tests return different bindings
// on successive getChatBinding() calls (simulating a mid-turn rebind).
const mockDb = {
  // Bindings stored by chat ID (number)
  bindings: {},
  // If set for a chat ID, getChatBinding returns entries in order on each call
  bindingSequence: {},
  bindingCallCounts: {},
  setCalls: [],
}

function getChatBindingMock(chatId) {
  const seq = mockDb.bindingSequence[chatId]
  if (seq) {
    const count = mockDb.bindingCallCounts[chatId] ?? 0
    mockDb.bindingCallCounts[chatId] = count + 1
    return seq[Math.min(count, seq.length - 1)]
  }
  return mockDb.bindings[chatId] ?? null
}

await mock.module("../src/db.js", {
  namedExports: {
    getChatBinding: getChatBindingMock,
    setChatBinding: (chatId, binding) => { mockDb.setCalls.push({ chatId, binding }) },
    clearChatBinding: () => {},
    getCliSessionById: () => null,
  },
})

const capturedLogs = []
await mock.module("../src/log.js", {
  namedExports: {
    log: {
      debug: () => {},
      info: (...args) => { capturedLogs.push({ level: "info", args }) },
      warn: (...args) => { capturedLogs.push({ level: "warn", args }) },
      error: () => {},
    },
    redactString: (s) => s,
  },
})

const capturedReplies = []
await mock.module("../src/telegram-utils.js", {
  namedExports: {
    replyChunks: async (_ctx, text) => { capturedReplies.push(text) },
    resolvePreferredAgent: () => "default-agent",
    hasBoundSession: (binding) => !!(binding?.session_id),
    displayPath: (p) => p ?? "/",
    explainBackendFailure: async () => {},
    resolveDirectory: (p) => p,
    compactPath: (p) => p ?? ".",
    registerPath: () => "fakehash",
    resolvePath: () => null,
    parseUserPath: (p) => ({ ok: true, path: p }),
    validateWorkspaceDirectory: () => ({ ok: true }),
    resolveSessionLabel: (binding) => binding?.session_id?.slice(0, 12) ?? "unknown",
  },
})

await mock.module("../src/config.js", {
  namedExports: {
    config: { defaultDirectory: "/tmp", bridgeAgentFallbacks: [], logLevel: "error" },
  },
})

await mock.module("../src/rate-limit.js", {
  namedExports: {
    checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
  },
})

await mock.module("../src/commands.js", {
  namedExports: {
    createNewSession: async () => {},
  },
})

// Mutable backend mock
const mockBackend = { result: null }
await mock.module("../src/backends.js", {
  namedExports: {
    getBackend: () => ({ supported: true, sendMessage: async () => mockBackend.result }),
    supportedClis: () => ["codex", "claude", "kilo"],
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

await mock.module("../src/agent-registry.js", {
  namedExports: {
    loadAgentRegistry: async () => ({
      bridgeDefault: "default-agent",
      primaryAgents: ["default-agent"],
      bridgeAgentFallbacks: [],
    }),
  },
})

const { setupHandlers } = await import("../src/message-handler.js")

// Capture registered handlers by event name
const eventHandlers = {}
const fakeBot = {
  on: (event, handler) => { eventHandlers[event] = handler },
}

const fakeRegistrySnapshot = {
  bridgeDefault: "default-agent",
  primaryAgents: ["default-agent"],
  bridgeAgentFallbacks: [],
}
const fakeRegistry = {
  get: () => fakeRegistrySnapshot,
  refresh: async () => fakeRegistrySnapshot,
}

const fakeKilo = { getAllStatuses: async () => ({}) }

setupHandlers(fakeBot, fakeKilo, fakeRegistry)

const messageTextHandler = eventHandlers["message:text"]

function makeCtx(chatId = 42, text = "hello") {
  return {
    chat: { id: chatId },
    from: { id: chatId },
    message: { text },
    reply: async () => {},
    api: { sendChatAction: async () => {} },
  }
}

function resetState() {
  mockDb.bindings = {}
  mockDb.bindingSequence = {}
  mockDb.bindingCallCounts = {}
  mockDb.setCalls = []
  capturedLogs.length = 0
  capturedReplies.length = 0
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("threadId update applies when binding unchanged during turn", async () => {
  resetState()
  const chatId = 101
  const initialBinding = {
    cli: "codex",
    session_id: "thread-A",
    directory: "/repo",
    model: null,
    agent: "default-agent",
  }
  // Both calls return the same binding (no change during turn)
  mockDb.bindings[chatId] = initialBinding
  mockBackend.result = { text: "ok", threadId: "thread-B" }

  await messageTextHandler(makeCtx(chatId, "hello"))

  // setChatBinding must have been called with the new threadId
  assert.equal(mockDb.setCalls.length, 1)
  assert.equal(mockDb.setCalls[0].binding.session_id, "thread-B")
  assert.equal(mockDb.setCalls[0].binding.cli, "codex")
  assert.equal(mockDb.setCalls[0].binding.directory, "/repo")

  // binding.thread_updated log event must be emitted
  const updated = capturedLogs.find(
    (l) => l.level === "info" && l.args[1] === "binding.thread_updated",
  )
  assert.ok(updated, "binding.thread_updated event should be emitted")

  // binding.thread_update_skipped must NOT be emitted
  const skipped = capturedLogs.find(
    (l) => l.args[1] === "binding.thread_update_skipped",
  )
  assert.equal(skipped, undefined, "binding.thread_update_skipped should not be emitted")
})

test("threadId update is skipped when user switched CLI during turn", async () => {
  resetState()
  const chatId = 102
  const initialBinding = {
    cli: "codex",
    session_id: "thread-A",
    directory: "/repo1",
    model: null,
    agent: "default-agent",
  }
  const newBinding = {
    cli: "claude",
    session_id: "claude-123",
    directory: "/repo2",
    model: null,
    agent: "default-agent",
  }
  // First call (at turn start) → initialBinding; second call (compare-and-set) → newBinding
  mockDb.bindingSequence[chatId] = [initialBinding, newBinding]
  mockBackend.result = { text: "ok", threadId: "thread-B" }

  await messageTextHandler(makeCtx(chatId, "hello"))

  // setChatBinding must NOT have been called
  assert.equal(mockDb.setCalls.length, 0)

  // binding.thread_update_skipped must be emitted with reason binding_changed_during_turn
  const skipped = capturedLogs.find(
    (l) => l.level === "info" && l.args[1] === "binding.thread_update_skipped",
  )
  assert.ok(skipped, "binding.thread_update_skipped event should be emitted")
  assert.equal(skipped.args[2].reason, "binding_changed_during_turn")
  assert.equal(skipped.args[2].original_cli, "codex")
  assert.equal(skipped.args[2].current_cli, "claude")
})

test("threadId update is skipped when user rebound to a different session of the same CLI", async () => {
  resetState()
  const chatId = 103
  const initialBinding = {
    cli: "codex",
    session_id: "thread-A",
    directory: "/repo",
    model: null,
    agent: "default-agent",
  }
  const newBinding = {
    cli: "codex",
    session_id: "thread-X",
    directory: "/repo",
    model: null,
    agent: "default-agent",
  }
  mockDb.bindingSequence[chatId] = [initialBinding, newBinding]
  mockBackend.result = { text: "ok", threadId: "thread-B" }

  await messageTextHandler(makeCtx(chatId, "hello"))

  // setChatBinding must NOT have been called
  assert.equal(mockDb.setCalls.length, 0)

  // Post-handler: if someone read the binding now it would still be thread-X (not thread-B)
  // We verify by checking no setCalls modified the binding
  const skipped = capturedLogs.find(
    (l) => l.level === "info" && l.args[1] === "binding.thread_update_skipped",
  )
  assert.ok(skipped, "binding.thread_update_skipped event should be emitted")
  assert.equal(skipped.args[2].original_session_id, "thread-A")
  assert.equal(skipped.args[2].current_session_id, "thread-X")
})

test("threadId update is skipped when user changed directory during turn", async () => {
  resetState()
  const chatId = 104
  const initialBinding = {
    cli: "codex",
    session_id: "thread-A",
    directory: "/repo1",
    model: null,
    agent: "default-agent",
  }
  const newBinding = {
    cli: "codex",
    session_id: "thread-A",
    directory: "/repo2",
    model: null,
    agent: "default-agent",
  }
  mockDb.bindingSequence[chatId] = [initialBinding, newBinding]
  mockBackend.result = { text: "ok", threadId: "thread-B" }

  await messageTextHandler(makeCtx(chatId, "hello"))

  // setChatBinding must NOT have been called
  assert.equal(mockDb.setCalls.length, 0)

  const skipped = capturedLogs.find(
    (l) => l.level === "info" && l.args[1] === "binding.thread_update_skipped",
  )
  assert.ok(skipped, "binding.thread_update_skipped event should be emitted")
})

test("threadId update still applies when user changed model during turn", async () => {
  resetState()
  const chatId = 105
  const initialBinding = {
    cli: "codex",
    session_id: "thread-A",
    directory: "/repo",
    model: "gpt-5.4",
    agent: "default-agent",
  }
  const midTurnBinding = {
    cli: "codex",
    session_id: "thread-A",
    directory: "/repo",
    model: "gpt-5.4-mini",
    agent: "default-agent",
  }
  // First call → initialBinding; second call (compare-and-set re-read) → midTurnBinding
  mockDb.bindingSequence[chatId] = [initialBinding, midTurnBinding]
  mockBackend.result = { text: "ok", threadId: "thread-B" }

  await messageTextHandler(makeCtx(chatId, "hello"))

  // setChatBinding MUST have been called (model change doesn't block threadId update)
  assert.equal(mockDb.setCalls.length, 1)
  assert.equal(mockDb.setCalls[0].binding.session_id, "thread-B")
  // The fresh binding's model (gpt-5.4-mini) must be preserved, not the stale one
  assert.equal(mockDb.setCalls[0].binding.model, "gpt-5.4-mini")
  assert.equal(mockDb.setCalls[0].binding.cli, "codex")
  assert.equal(mockDb.setCalls[0].binding.directory, "/repo")

  // binding.thread_updated must be emitted
  const updated = capturedLogs.find(
    (l) => l.level === "info" && l.args[1] === "binding.thread_updated",
  )
  assert.ok(updated, "binding.thread_updated event should be emitted")
})

test("threadId update is skipped when user detached during turn", async () => {
  resetState()
  const chatId = 106
  const initialBinding = {
    cli: "codex",
    session_id: "thread-A",
    directory: "/repo",
    model: null,
    agent: "default-agent",
  }
  // First call → initialBinding; second call → null (user detached)
  mockDb.bindingSequence[chatId] = [initialBinding, null]
  mockBackend.result = { text: "ok", threadId: "thread-B" }

  await messageTextHandler(makeCtx(chatId, "hello"))

  // setChatBinding must NOT have been called
  assert.equal(mockDb.setCalls.length, 0)

  const skipped = capturedLogs.find(
    (l) => l.level === "info" && l.args[1] === "binding.thread_update_skipped",
  )
  assert.ok(skipped, "binding.thread_update_skipped event should be emitted")
  assert.equal(skipped.args[2].current_cli, null)
  assert.equal(skipped.args[2].current_session_id, null)
})
