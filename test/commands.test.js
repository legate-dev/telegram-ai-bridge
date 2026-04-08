import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Mutable mock state so individual tests can change the binding
const mockDb = {
  binding: null,
  // Optional dynamic binding getter — if set, prevails over `binding`.
  // Used by race-condition tests to return different bindings on
  // successive getChatBinding() calls within the same handler invocation.
  bindingGetter: null,
  sessionsById: {},
  // bridgeSessions: rows shaped as getKiloBridgeSessions output
  // (session_id, title, display_name, message_count, last_activity)
  bridgeSessions: [],
  upsertCalls: [],
}
const capturedReplies = []

await mock.module("../src/db.js", {
  namedExports: {
    getChatBinding: () => (mockDb.bindingGetter ? mockDb.bindingGetter() : mockDb.binding),
    setChatBinding: () => {},
    clearChatBinding: () => {},
    recentSessions: () => [],
    sessionCountsByCli: () => [],
    recentWorkspaces: () => [],
    getCliSessionById: (cli, sessionId) => {
      const key = `${cli}:${sessionId}`
      if (Object.hasOwn(mockDb.sessionsById, key)) return mockDb.sessionsById[key]
      return { cli, session_id: sessionId, title: "test", display_name: null, message_count: 0 }
    },
    renameSession: () => ({ changes: 1 }),
    upsertCliSession: (row) => {
      if (mockDb.upsertShouldThrow) throw mockDb.upsertShouldThrow
      mockDb.upsertCalls.push(row)
    },
    getKiloBridgeSessions: (boundId) => {
      if (boundId) return mockDb.bridgeSessions.filter((s) => s.session_id !== boundId)
      return mockDb.bridgeSessions.slice()
    },
  },
})

// Capture raw text before MarkdownV2 formatting so assertions stay readable
await mock.module("../src/telegram-utils.js", {
  namedExports: {
    replyChunks: async (_ctx, text) => { capturedReplies.push(text) },
    resolvePreferredAgent: () => "default-agent",
    hasBoundSession: (binding) => !!(binding?.session_id),
    displayPath: (p) => p ?? "/",
    formatSessionLine: (row) => `[${row.cli}] ${row.session_id}`,
    resolveDirectory: (p) => p ?? "/tmp",
    compactPath: (p) => p ?? ".",
    registerPath: (p) => `hash_${p}`,
  },
})

await mock.module("../src/config.js", {
  namedExports: {
    config: { defaultDirectory: "/tmp", bridgeAgentFallbacks: [], logLevel: "error" },
  },
})

await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    redactString: (s) => s,
  },
})

// Mutable backend mock so individual tests can swap in a fake backend.
const mockBackends = { backend: null }

await mock.module("../src/backends.js", {
  namedExports: {
    getBackend: () => mockBackends.backend,
    supportedClis: () => ["kilo", "claude"],
  },
})

// Track refreshKiloMirror() invocations from the cleanup handler.
// `lastError` simulates a throw; `returnOk` simulates a graceful degradation
// (scanKilo returning ok=false without throwing — the very case that
// motivated extracting refreshKiloMirror as a replacement for scanAll).
const refreshKiloCalls = { count: 0, lastError: null, returnOk: true }
await mock.module("../src/cli-scanner.js", {
  namedExports: {
    refreshKiloMirror: async () => {
      refreshKiloCalls.count += 1
      if (refreshKiloCalls.lastError) throw refreshKiloCalls.lastError
      return { sessions: [], ok: refreshKiloCalls.returnOk }
    },
    // Keep scanAll mocked too in case other command handlers still use it
    scanAll: async () => 0,
  },
})

// Mutable mock state for model discovery
// codex: starts empty (no cache); claude: starts with static aliases
const mockModels = {
  codex: [],
  claude: [
    { slug: "opus", displayName: "opus" },
    { slug: "sonnet", displayName: "sonnet" },
    { slug: "haiku", displayName: "haiku" },
  ],
}

await mock.module("../src/model-discovery.js", {
  namedExports: {
    getModelsForCli: (cli) => mockModels[cli] ?? null,
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

const { setupCommands, createNewSession } = await import("../src/commands.js")

function makeMockBot() {
  const handlers = {}
  return {
    command(name, handler) { handlers[name] = handler },
    handlers,
  }
}

// capturedInlineReplies holds { text, reply_markup } from ctx.reply() calls (used by /models)
const capturedInlineReplies = []

function makeCtx(chatId = 1, match = "") {
  return {
    chat: { id: chatId },
    match,
    reply: async (text, opts) => { capturedInlineReplies.push({ text, opts }) },
  }
}

const fakeRegistry = Promise.resolve({
  bridgeDefault: "claude-sonnet",
  primaryAgents: ["claude-sonnet", "gemini-pro"],
  bridgeAgentFallbacks: [],
})

const fakeKilo = {
  listSessions: async () => [],
  getAllStatuses: async () => ({}),
  getSession: async () => ({ title: "test-session" }),
  deleteSession: async () => {},
  abortSession: async () => {},
}

const bot = makeMockBot()
setupCommands(bot, fakeKilo, fakeRegistry)

// ── /agents ────────────────────────────────────────────────────────────────

test("/agents shows informative message for Claude session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "claude", session_id: "abc123", agent: null, directory: "/tmp" }
  await bot.handlers.agents(makeCtx())
  assert.equal(capturedReplies.length, 1)
  assert.equal(
    capturedReplies[0],
    "Agent selection is not available for claude. Model configuration is managed in the CLI directly.",
  )
})

test("/agents shows informative message for Codex session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "codex", session_id: "def456", agent: null, directory: "/tmp" }
  await bot.handlers.agents(makeCtx())
  assert.equal(capturedReplies.length, 1)
  assert.equal(
    capturedReplies[0],
    "Agent selection is not available for codex. Model configuration is managed in the CLI directly.",
  )
})

test("/agents lists agents for Kilo session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "kilo", session_id: "kilo-abc", agent: null, directory: "/tmp" }
  await bot.handlers.agents(makeCtx())
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("Available primary agents:"), "should list agents")
  assert.ok(capturedReplies[0].includes("Bridge default agent:"), "should show bridge default")
})

test("/agents lists agents when no session is bound", async () => {
  capturedReplies.length = 0
  mockDb.binding = null
  await bot.handlers.agents(makeCtx())
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("Available primary agents:"), "should list agents when unbound")
})

// ── /agent ─────────────────────────────────────────────────────────────────

test("/agent shows informative message for Claude session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "claude", session_id: "abc123", agent: null, directory: "/tmp" }
  await bot.handlers.agent(makeCtx(1, "sonnet"))
  assert.equal(capturedReplies.length, 1)
  assert.equal(
    capturedReplies[0],
    "Agent selection is not supported for claude sessions. Model selection is configured directly in claude.",
  )
})

test("/agent shows informative message for Gemini session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "gemini", session_id: "ghi789", agent: null, directory: "/tmp" }
  await bot.handlers.agent(makeCtx(1, "flash"))
  assert.equal(capturedReplies.length, 1)
  assert.equal(
    capturedReplies[0],
    "Agent selection is not supported for gemini sessions. Model selection is configured directly in gemini.",
  )
})

test("/agent sets agent for Kilo session with valid agent name", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "kilo", session_id: "kilo-abc", agent: null, directory: "/tmp" }
  await bot.handlers.agent(makeCtx(1, "claude-sonnet"))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("claude-sonnet"), "message should include agent name")
  assert.ok(capturedReplies[0].includes("set"), "message should confirm agent was set")
})

test("/agent shows current agent when called without argument on Kilo session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "kilo", session_id: "kilo-abc", agent: null, directory: "/tmp" }
  await bot.handlers.agent(makeCtx(1, ""))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("Current chat agent:"), "should show current agent")
})

test("/agent shows current agent when no session is bound", async () => {
  capturedReplies.length = 0
  mockDb.binding = null
  await bot.handlers.agent(makeCtx(1, ""))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("Current chat agent:"), "should show current agent when unbound")
})

// ── /rename ───────────────────────────────────────────────────────────────

test("/rename shows usage when called without argument", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "kilo", session_id: "kilo-abc", agent: null, directory: "/tmp" }
  await bot.handlers.rename(makeCtx(1, ""))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("Usage:"), "should show usage")
  assert.ok(capturedReplies[0].includes("Current:"), "should show current name")
})

test("/rename rejects when no session is bound", async () => {
  capturedReplies.length = 0
  mockDb.binding = null
  await bot.handlers.rename(makeCtx(1, "my-project"))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("No session bound"), "should reject when unbound")
})

test("/rename confirms new name", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "claude", session_id: "abc123", agent: null, directory: "/tmp" }
  await bot.handlers.rename(makeCtx(1, "my-cool-project"))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("my-cool-project"), "should echo new name")
})

// ── /models ───────────────────────────────────────────────────────────────

test("/models rejects when no session is bound", async () => {
  capturedReplies.length = 0
  mockDb.binding = null
  await bot.handlers.models(makeCtx())
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("No session bound"))
})

test("/models redirects to /agents for Kilo session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "kilo", session_id: "kilo-abc", agent: null, directory: "/tmp" }
  await bot.handlers.models(makeCtx())
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("/agents"))
})

test("/models shows unsupported message for Gemini session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "gemini", session_id: "gem-abc", agent: null, directory: "/tmp" }
  await bot.handlers.models(makeCtx())
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("not supported"))
})

test("/models shows empty message when model list is empty for Codex", async () => {
  capturedReplies.length = 0
  mockModels.codex = []
  mockDb.binding = { cli: "codex", session_id: "cdx-abc", agent: null, directory: "/tmp" }
  await bot.handlers.models(makeCtx())
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("No models available"))
})

test("/models shows inline keyboard with models for Codex session", async () => {
  capturedReplies.length = 0
  capturedInlineReplies.length = 0
  mockModels.codex = [
    { slug: "gpt-5.4", displayName: "gpt-5.4" },
    { slug: "gpt-5-mini", displayName: "gpt-5 mini" },
  ]
  mockDb.binding = { cli: "codex", session_id: "cdx-abc", agent: null, model: null, directory: "/tmp" }
  await bot.handlers.models(makeCtx())
  // /models calls ctx.reply() directly (not replyChunks) to attach the inline keyboard
  assert.equal(capturedReplies.length, 0, "should use ctx.reply directly instead of replyChunks")
  assert.equal(capturedInlineReplies.length, 1, "should call ctx.reply with keyboard")
  assert.ok(capturedInlineReplies[0].text.includes("gpt-5.4"))
  assert.ok(capturedInlineReplies[0].text.includes("gpt-5 mini"))
})

test("/models shows current model when one is set", async () => {
  capturedReplies.length = 0
  capturedInlineReplies.length = 0
  mockModels.codex = [{ slug: "gpt-5.4", displayName: "gpt-5.4" }]
  mockDb.binding = { cli: "codex", session_id: "cdx-abc", agent: null, model: "gpt-5-mini", directory: "/tmp" }
  await bot.handlers.models(makeCtx())
  assert.equal(capturedInlineReplies.length, 1)
  assert.ok(capturedInlineReplies[0].text.includes("Current: gpt-5-mini"))
})

test("/models truncates keyboard to 25 models and shows overflow note", async () => {
  capturedReplies.length = 0
  capturedInlineReplies.length = 0
  // 30 models — only the first 25 should appear in the keyboard
  mockModels.codex = Array.from({ length: 30 }, (_, i) => ({ slug: `model-${i}`, displayName: `Model ${i}` }))
  mockDb.binding = { cli: "codex", session_id: "cdx-abc", agent: null, model: null, directory: "/tmp" }
  await bot.handlers.models(makeCtx())
  assert.equal(capturedInlineReplies.length, 1)
  const text = capturedInlineReplies[0].text
  // Should mention the 5 hidden models
  assert.ok(text.includes("5 more"), `expected overflow note, got: ${text}`)
  // Should list model-0 through model-24 but not model-25
  assert.ok(text.includes("Model 24"), "should include 25th model")
  assert.ok(!text.includes("Model 25"), "should not include 26th model")
})

// ── /model ────────────────────────────────────────────────────────────────

test("/model rejects when no session is bound", async () => {
  capturedReplies.length = 0
  mockDb.binding = null
  await bot.handlers.model(makeCtx(1, "sonnet"))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("No session bound"))
})

test("/model redirects to /agents for Kilo session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "kilo", session_id: "kilo-abc", agent: null, directory: "/tmp" }
  await bot.handlers.model(makeCtx(1, "sonnet"))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("/agents"))
})

test("/model shows unsupported message for Gemini session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "gemini", session_id: "gem-abc", agent: null, directory: "/tmp" }
  await bot.handlers.model(makeCtx(1, "flash"))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("not supported"))
})

test("/model shows current model and usage when called without argument on Claude", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "claude", session_id: "abc123", agent: null, model: "sonnet", directory: "/tmp" }
  await bot.handlers.model(makeCtx(1, ""))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("Current model: sonnet"))
  assert.ok(capturedReplies[0].includes("Usage:"))
})

test("/model shows no-model message when no model set on Codex", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "codex", session_id: "cdx-abc", agent: null, model: null, directory: "/tmp" }
  await bot.handlers.model(makeCtx(1, ""))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("No model set"))
})

test("/model sets model for Claude session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "claude", session_id: "abc123", agent: null, model: null, directory: "/tmp" }
  await bot.handlers.model(makeCtx(1, "opus"))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("opus"))
  assert.ok(capturedReplies[0].includes("set"))
})

test("/model sets model for Codex session", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "codex", session_id: "cdx-abc", agent: null, model: null, directory: "/tmp" }
  await bot.handlers.model(makeCtx(1, "gpt-5.4"))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("gpt-5.4"))
  assert.ok(capturedReplies[0].includes("set"))
})

test("/model clear resets model to CLI default on Claude", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "claude", session_id: "abc123", agent: null, model: "opus", directory: "/tmp" }
  await bot.handlers.model(makeCtx(1, "clear"))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("cleared") || capturedReplies[0].includes("default"))
})

test("/model clear resets model to CLI default on Codex", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "codex", session_id: "cdx-abc", agent: null, model: "gpt-5.4", directory: "/tmp" }
  await bot.handlers.model(makeCtx(1, "clear"))
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("cleared") || capturedReplies[0].includes("default"))
})

// ── /cleanup ──────────────────────────────────────────────────────────────

test("/cleanup previews destructive Kilo cleanup without deleting sessions", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "kilo", session_id: "keep-me-123456", agent: null, directory: "/tmp" }
  // bridgeSessions are the rows getKiloBridgeSessions would return —
  // already filtered by source='bridge' AND session_id != bound.
  // message_count holds exact user turn count (post Fix 2). Threshold is 5 by default.
  mockDb.bridgeSessions = [
    { session_id: "delete-a", title: "telegram-6584141122-1", display_name: null, message_count: 3, last_activity: "2024-04-06T10:00:00Z" },
    { session_id: "delete-b", title: "repo — Apr06-1100", display_name: null, message_count: 4, last_activity: "2024-04-06T11:00:00Z" },
    { session_id: "protected-c", title: "session — Apr06-1000", display_name: null, message_count: 12, last_activity: "2024-04-06T09:00:00Z" },
  ]

  let deleteCalls = 0
  let abortCalls = 0
  fakeKilo.getAllStatuses = async () => ({ "delete-b": { type: "busy" } })
  fakeKilo.deleteSession = async () => { deleteCalls += 1 }
  fakeKilo.abortSession = async () => { abortCalls += 1 }

  await bot.handlers.cleanup(makeCtx(1, ""))

  assert.equal(deleteCalls, 0, "preview should not delete anything")
  assert.equal(abortCalls, 0, "preview should not abort anything")
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("Cleanup preview: 2"), "should show deletion count")
  assert.ok(capturedReplies[0].includes("/cleanup confirm"), "should require explicit confirmation")
  assert.ok(capturedReplies[0].includes("Current bound session kept:"), "should mention protected bound session")
  assert.ok(capturedReplies[0].includes("exceed 5 user turns"), "should mention user-turn-based protection")
  assert.ok(capturedReplies[0].includes("user turns)"), "preview lines should display user turn counts")
  // Regression lock: blank-line separators must survive the array .filter() step.
  // Before the fix, .filter(Boolean) stripped "" and collapsed the whole preview
  // into a single dense block with no visual separation between summary, list,
  // and the "Run /cleanup confirm" footer.
  assert.ok(
    /\n\n/.test(capturedReplies[0]),
    "preview should contain at least one blank-line separator",
  )
  assert.ok(
    capturedReplies[0].includes("\n\nRun `/cleanup confirm`"),
    "the confirm footer must be separated from the list by a blank line",
  )
})

test("/cleanup confirm deletes bridge-created Kilo sessions except the current binding", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "kilo", session_id: "keep-me-123456", agent: null, directory: "/tmp" }
  mockDb.bridgeSessions = [
    { session_id: "delete-a", title: "telegram-6584141122-1", display_name: null, message_count: 3, last_activity: "2024-04-06T10:00:00Z" },
    { session_id: "delete-b", title: "repo — Apr06-1100", display_name: null, message_count: 4, last_activity: "2024-04-06T11:00:00Z" },
    { session_id: "protected-c", title: "session — Apr06-1000", display_name: null, message_count: 12, last_activity: "2024-04-06T09:00:00Z" },
  ]

  const deleted = []
  const aborted = []
  fakeKilo.getAllStatuses = async () => ({ "delete-b": { type: "busy" } })
  fakeKilo.deleteSession = async (id) => { deleted.push(id) }
  fakeKilo.abortSession = async (id) => { aborted.push(id) }

  await bot.handlers.cleanup(makeCtx(1, "confirm"))

  assert.deepEqual(deleted.sort(), ["delete-a", "delete-b"].sort())
  assert.deepEqual(aborted, ["delete-b"])
  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("Cleanup: 2 zombie sessions deleted"))
  assert.ok(capturedReplies[0].includes("Protected by policy: 1"), "should report protected sessions")
})

test("createNewSession tags the new session with source='bridge' in the local mirror", async () => {
  capturedReplies.length = 0
  mockDb.upsertCalls.length = 0
  mockDb.binding = null
  mockBackends.backend = {
    createSession: async () => ({ id: "sess-new-bridge-001" }),
  }

  await createNewSession(makeCtx(42), "kilo", "/tmp/some-dir", fakeRegistry)

  const bridgeUpsert = mockDb.upsertCalls.find((row) => row.session_id === "sess-new-bridge-001")
  assert.ok(bridgeUpsert, "createNewSession must upsert the new session into the local mirror")
  assert.equal(bridgeUpsert.source, "bridge", "the new session must be tagged source='bridge'")
  assert.equal(bridgeUpsert.cli, "kilo")
  assert.equal(bridgeUpsert.workspace, "/tmp/some-dir")

  // Reset for subsequent tests
  mockBackends.backend = null
})

test("createNewSession handles upsertCliSession failure gracefully (R2)", async () => {
  // The session is created in the backend BEFORE upsertCliSession is called.
  // If upsert throws (DB locked, disk full, SQLITE_IOERR), the function must:
  //   1. NOT call setChatBinding (the session is unrecoverable from this chat)
  //   2. Log the failure with persist=true
  //   3. Reply to the user with the session id so manual recovery is possible
  capturedReplies.length = 0
  mockDb.upsertCalls.length = 0
  mockDb.binding = null
  mockDb.upsertShouldThrow = new Error("SQLITE_IOERR: disk I/O error")
  mockBackends.backend = {
    createSession: async () => ({ id: "sess-orphan-2025" }),
  }

  let didThrow = false
  try {
    await createNewSession(makeCtx(42), "kilo", "/tmp/orphan-dir", fakeRegistry)
  } catch (error) {
    didThrow = true
  }

  assert.equal(didThrow, false, "createNewSession must NOT propagate the upsert error")
  assert.equal(mockDb.upsertCalls.length, 0, "no upsert should have completed")
  assert.equal(capturedReplies.length, 1, "user must receive an error reply")
  assert.ok(
    capturedReplies[0].includes("sess-orphan-2025"),
    "the error reply must include the orphan session id for manual recovery",
  )
  assert.ok(
    capturedReplies[0].toLowerCase().includes("not bound") || capturedReplies[0].toLowerCase().includes("mirror"),
    "the user must understand the binding step did not happen",
  )

  // Reset for subsequent tests
  mockDb.upsertShouldThrow = null
  mockBackends.backend = null
})

test("/cleanup preview hides confirm footer when all sessions are protected (R6)", async () => {
  capturedReplies.length = 0
  refreshKiloCalls.count = 0
  refreshKiloCalls.lastError = null
  mockDb.binding = { cli: "kilo", session_id: "keep-me-123456", agent: null, directory: "/tmp" }
  // All sessions exceed the default threshold (5) → all protected, 0 eligible
  mockDb.bridgeSessions = [
    { session_id: "long-1", title: "long session 1", display_name: null, message_count: 12, last_activity: "2024-04-06T10:00:00Z" },
    { session_id: "long-2", title: "long session 2", display_name: null, message_count: 30, last_activity: "2024-04-06T11:00:00Z" },
  ]
  fakeKilo.getAllStatuses = async () => ({})

  await bot.handlers.cleanup(makeCtx(1, ""))

  assert.equal(capturedReplies.length, 1)
  assert.ok(
    capturedReplies[0].includes("Cleanup preview: 0"),
    "should show 0 eligible",
  )
  assert.ok(
    !capturedReplies[0].includes("Run `/cleanup confirm`"),
    "the confirm footer must NOT appear when there is nothing to delete",
  )
  assert.ok(
    capturedReplies[0].includes("All bridge-created sessions are protected"),
    "user must be told there is nothing to do",
  )
})

test("/cleanup ignores sessions where source is NULL (external / pre-migration)", async () => {
  capturedReplies.length = 0
  mockDb.binding = { cli: "kilo", session_id: "keep-me-123456", agent: null, directory: "/tmp" }
  // getKiloBridgeSessions only returns source='bridge' rows by definition,
  // so an external session simply does not appear in the array — that IS
  // the protection. This test locks the contract: empty bridgeSessions
  // means /cleanup finds nothing to do, regardless of how many external
  // sessions exist in the real Kilo.
  mockDb.bridgeSessions = []
  fakeKilo.getAllStatuses = async () => ({})

  await bot.handlers.cleanup(makeCtx(1, ""))

  assert.equal(capturedReplies.length, 1)
  assert.ok(capturedReplies[0].includes("No bridge-created Kilo sessions found"))
})

test("/cleanup triggers refreshKiloMirror() before classification (preview)", async () => {
  capturedReplies.length = 0
  refreshKiloCalls.count = 0
  refreshKiloCalls.lastError = null
  refreshKiloCalls.returnOk = true
  mockDb.binding = null
  mockDb.bridgeSessions = []
  fakeKilo.getAllStatuses = async () => ({})

  await bot.handlers.cleanup(makeCtx(1, ""))

  assert.equal(refreshKiloCalls.count, 1, "/cleanup must refresh the Kilo mirror before reading it")
})

test("/cleanup triggers refreshKiloMirror() before classification (confirm)", async () => {
  capturedReplies.length = 0
  refreshKiloCalls.count = 0
  refreshKiloCalls.lastError = null
  refreshKiloCalls.returnOk = true
  mockDb.binding = null
  mockDb.bridgeSessions = []
  fakeKilo.getAllStatuses = async () => ({})

  await bot.handlers.cleanup(makeCtx(1, "confirm"))

  assert.equal(refreshKiloCalls.count, 1, "confirm path must also refresh the Kilo mirror")
})

test("/cleanup PREVIEW degrades gracefully when refreshKiloMirror throws (stale-warning header)", async () => {
  capturedReplies.length = 0
  refreshKiloCalls.count = 0
  refreshKiloCalls.lastError = new Error("scanner unavailable")
  refreshKiloCalls.returnOk = true
  mockDb.binding = { cli: "kilo", session_id: "keep-me-123456", agent: null, directory: "/tmp" }
  mockDb.bridgeSessions = [
    { session_id: "leftover-1", title: "leftover", display_name: null, message_count: 1, last_activity: "2024-04-06T10:00:00Z" },
  ]
  fakeKilo.getAllStatuses = async () => ({})
  let deleteCalls = 0
  fakeKilo.deleteSession = async () => { deleteCalls += 1 }

  await bot.handlers.cleanup(makeCtx(1, ""))

  // Preview path: refresh failure is non-fatal, but the user must see a warning.
  assert.equal(refreshKiloCalls.count, 1)
  assert.equal(deleteCalls, 0, "preview must never delete")
  assert.equal(capturedReplies.length, 1)
  assert.ok(
    capturedReplies[0].includes("Mirror refresh failed"),
    "preview must include the stale-mirror warning header",
  )
  assert.ok(
    capturedReplies[0].includes("Cleanup preview: 1"),
    "preview should still display the (stale) eligible list",
  )

  refreshKiloCalls.lastError = null
})

test("/cleanup PREVIEW degrades gracefully when refreshKiloMirror returns ok=false (N1 — NO throw)", async () => {
  // This is the N1 regression lock: the previous fix B1 only caught
  // scanAll() throwing. refreshKiloMirror can return ok=false WITHOUT
  // throwing when scanKilo fails internally (missing DB, locked, query
  // error). The handler must treat ok=false identically to a throw.
  capturedReplies.length = 0
  refreshKiloCalls.count = 0
  refreshKiloCalls.lastError = null
  refreshKiloCalls.returnOk = false
  mockDb.binding = { cli: "kilo", session_id: "keep-me-123456", agent: null, directory: "/tmp" }
  mockDb.bridgeSessions = [
    { session_id: "leftover-2", title: "stale", display_name: null, message_count: 1, last_activity: "2024-04-06T10:00:00Z" },
  ]
  fakeKilo.getAllStatuses = async () => ({})
  let deleteCalls = 0
  fakeKilo.deleteSession = async () => { deleteCalls += 1 }

  await bot.handlers.cleanup(makeCtx(1, ""))

  assert.equal(refreshKiloCalls.count, 1)
  assert.equal(deleteCalls, 0, "preview must never delete")
  assert.ok(
    capturedReplies[0].includes("Mirror refresh failed"),
    "preview must include the stale-mirror warning header even when refresh did not throw",
  )

  refreshKiloCalls.returnOk = true
})

test("/cleanup CONFIRM fails closed when refreshKiloMirror returns ok=false (N1 — NO throw)", async () => {
  // Companion to the preview test above. The confirm path must abort
  // even when refreshKiloMirror returns ok=false without throwing.
  capturedReplies.length = 0
  refreshKiloCalls.count = 0
  refreshKiloCalls.lastError = null
  refreshKiloCalls.returnOk = false
  mockDb.binding = { cli: "kilo", session_id: "keep-me-123456", agent: null, directory: "/tmp" }
  mockDb.bridgeSessions = [
    { session_id: "would-be-deleted", title: "stale", display_name: null, message_count: 1, last_activity: "2024-04-06T10:00:00Z" },
  ]
  fakeKilo.getAllStatuses = async () => ({})
  let deleteCalls = 0
  let abortCalls = 0
  fakeKilo.deleteSession = async () => { deleteCalls += 1 }
  fakeKilo.abortSession = async () => { abortCalls += 1 }

  await bot.handlers.cleanup(makeCtx(1, "confirm"))

  assert.equal(refreshKiloCalls.count, 1)
  assert.equal(deleteCalls, 0, "confirm with ok=false MUST NOT delete (N1 regression lock)")
  assert.equal(abortCalls, 0, "confirm with ok=false MUST NOT abort (N1 regression lock)")
  assert.ok(
    capturedReplies[0].includes("Cleanup aborted"),
    "user must be told the operation aborted on refresh failure",
  )

  refreshKiloCalls.returnOk = true
})

test("/cleanup CONFIRM re-reads binding before delete loop — protects session bound after snapshot (R1)", async () => {
  capturedReplies.length = 0
  refreshKiloCalls.count = 0
  refreshKiloCalls.lastError = null

  // Initial state: no binding, one bridge-owned session in the mirror
  mockDb.bridgeSessions = [
    { session_id: "newly-bound-456", title: "fresh", display_name: null, message_count: 1, last_activity: "2024-04-06T10:00:00Z" },
  ]

  // Race simulation: /cleanup calls getChatBinding twice within a single
  // handler invocation. First call (initial snapshot) returns null. Second
  // call (re-read just before the delete loop) returns the freshly-bound
  // session, simulating a /new that fired between the two calls.
  let bindingCallCount = 0
  mockDb.bindingGetter = () => {
    bindingCallCount++
    if (bindingCallCount === 1) return null
    return { cli: "kilo", session_id: "newly-bound-456", agent: null, directory: "/tmp" }
  }

  fakeKilo.getAllStatuses = async () => ({})
  let deleteCalls = 0
  fakeKilo.deleteSession = async () => { deleteCalls += 1 }

  await bot.handlers.cleanup(makeCtx(1, "confirm"))

  // CRITICAL: the freshly-bound session must NOT be deleted.
  assert.equal(deleteCalls, 0, "freshly-bound session must be skipped, not deleted")
  assert.ok(
    capturedReplies[0].includes("Protected from race"),
    "user must be told that race protection kicked in",
  )

  // Reset state for subsequent tests
  mockDb.bindingGetter = null
  mockDb.binding = null
})

test("/cleanup CONFIRM fails closed if refreshKiloMirror throws — never calls deleteSession", async () => {
  capturedReplies.length = 0
  refreshKiloCalls.count = 0
  refreshKiloCalls.lastError = new Error("Kilo DB locked")
  refreshKiloCalls.returnOk = true
  mockDb.binding = { cli: "kilo", session_id: "keep-me-123456", agent: null, directory: "/tmp" }
  mockDb.bridgeSessions = [
    { session_id: "delete-me", title: "victim", display_name: null, message_count: 1, last_activity: "2024-04-06T10:00:00Z" },
  ]
  fakeKilo.getAllStatuses = async () => ({})

  let deleteCalls = 0
  let abortCalls = 0
  fakeKilo.deleteSession = async () => { deleteCalls += 1 }
  fakeKilo.abortSession = async () => { abortCalls += 1 }

  await bot.handlers.cleanup(makeCtx(1, "confirm"))

  // CRITICAL: confirm path must be FAIL-CLOSED.
  // No matter what's in the stale mirror, no destructive action runs.
  assert.equal(refreshKiloCalls.count, 1)
  assert.equal(deleteCalls, 0, "confirm with failed scan must NEVER delete")
  assert.equal(abortCalls, 0, "confirm with failed scan must NEVER abort")
  assert.equal(capturedReplies.length, 1)
  assert.ok(
    capturedReplies[0].includes("Cleanup aborted"),
    "user must be told the operation aborted",
  )
  assert.ok(
    capturedReplies[0].toLowerCase().includes("stale") || capturedReplies[0].toLowerCase().includes("refresh"),
    "user must understand WHY (stale mirror)",
  )

  refreshKiloCalls.lastError = null
})
