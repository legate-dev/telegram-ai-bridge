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
// Disable message debouncing so tests receive synchronous processing without
// waiting for a debounce timer. The coalescing behaviour itself is tested in
// test/message-coalescing.test.js.
process.env.BRIDGE_MESSAGE_DEBOUNCE_MS = "0"

// ── Mutable mock state ──────────────────────────────────────────────────────

const mockDb = {
  binding: null,
  sessions: {},
  setChatBindingCalls: [],
}

const mockRateLimit = {
  result: { allowed: true },
}

const mockBackend = createMockBackend()

const mockCreateNewSessionCalls = []

// Stateful path registry (mirrors the real registerPath/resolvePath flow from telegram-utils.js)
const pathRegistry = new Map()
let nextHashId = 0

// Mutable mocks for the strict pendingCustomPath path validation chain.
// Tests override these to assert how the handler responds to parser/validator
// rejections without exercising real filesystem state.
const mockPathParser = {
  // When non-null, parseUserPath returns this object instead of the default
  // pass-through. Reset to null in resetMocks() and overridden per-test.
  result: null,
}
const mockPathValidator = {
  // Default: every path is valid. Tests set { ok: false, error: "..." } to
  // exercise the rejection branch.
  result: { ok: true },
}

// Mutable mock for supportedClis() — allows tests to exercise both the
// multi-CLI picker branch (default ["claude", "kilo"]) and the single-CLI
// fast-path branch by overriding to e.g. ["claude"].
const mockSupportedClis = {
  result: ["claude", "kilo"],
}

// ── Module mocks (must be set up before importing message-handler.js) ───────

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
    setChatBinding: (chatId, binding) => {
      mockDb.setChatBindingCalls.push({ chatId, binding })
      mockDb.binding = binding
    },
    getCliSessionById: (cli, sessionId) => {
      const key = `${cli}:${sessionId}`
      return Object.hasOwn(mockDb.sessions, key) ? mockDb.sessions[key] : null
    },
  },
})

await mock.module("../src/rate-limit.js", {
  namedExports: {
    checkRateLimit: () => mockRateLimit.result,
  },
})

await mock.module("../src/backends.js", {
  namedExports: {
    getBackend: () => mockBackend,
    supportedClis: () => mockSupportedClis.result,
  },
})

await mock.module("../src/commands.js", {
  namedExports: {
    createNewSession: async (...args) => {
      mockCreateNewSessionCalls.push(args)
    },
  },
})

const mockLastTurn = {
  result: null,
}

await mock.module("../src/last-turn.js", {
  namedExports: {
    readLastTurn: async () => mockLastTurn.result,
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
    // Delegate to ctx.reply so replies land in ctx.replies consistently
    replyChunks: async (ctx, text) => ctx.reply(text),
    resolvePreferredAgent: () => "default-agent",
    hasBoundSession: (b) => !!(b?.session_id && b?.directory),
    displayPath: (p) => p ?? "/",
    explainBackendFailure: async (ctx, _binding, error) => ctx.reply(`Error: ${error.message}`),
    resolveDirectory: (p) => p ?? "/tmp",
    registerPath: (path) => {
      const hash = `h${nextHashId++}`
      pathRegistry.set(hash, path)
      return hash
    },
    resolvePath: (hash) => pathRegistry.get(hash) ?? null,
    parseUserPath: (raw) => {
      // Default: pass through the input as a "valid absolute path" so existing
      // tests don't have to know about the parser. Tests that exercise the
      // reject branch override mockPathParser.result.
      if (mockPathParser.result !== null) return mockPathParser.result
      return { ok: true, path: raw }
    },
    validateWorkspaceDirectory: () => mockPathValidator.result,
  },
})

// ── Import module under test ─────────────────────────────────────────────────

const { setupHandlers } = await import("../src/message-handler.js")

// ── Wire up handlers once ────────────────────────────────────────────────────

const fakeRegistry = Promise.resolve({
  bridgeDefault: "default-agent",
  primaryAgents: ["default-agent"],
  bridgeAgentFallbacks: [],
})

const bot = makeMockBot()
setupHandlers(bot, null, fakeRegistry)

const textHandler = bot.handlers["message:text"]
const callbackHandler = bot.handlers["callback_query:data"]

// ── Per-test reset helper ─────────────────────────────────────────────────────

function resetMocks() {
  mockDb.binding = null
  mockDb.sessions = {}
  mockDb.setChatBindingCalls = []
  mockBackend.sendMessageCalls = []
  mockBackend._sendResult = { text: "ok" }
  mockBackend.supported = true
  mockRateLimit.result = { allowed: true }
  mockCreateNewSessionCalls.length = 0
  mockPathParser.result = null
  mockPathValidator.result = { ok: true }
  mockSupportedClis.result = ["claude", "kilo"]
  mockLastTurn.result = null
}

// ── Tests: text message routing ───────────────────────────────────────────────

test("text message with no bound session replies with no-session message", async () => {
  resetMocks()
  const ctx = createMockCtx({ chatId: 1001, text: "hello" })
  await textHandler(ctx)
  assert.ok(
    ctx.replies.some((r) => r.text.includes("No session bound")),
    "expected a 'No session bound' reply",
  )
  assert.equal(mockBackend.sendMessageCalls.length, 0)
})

test("text message starting with / is ignored and backend is not called", async () => {
  resetMocks()
  const ctx = createMockCtx({ chatId: 1002, text: "/start" })
  await textHandler(ctx)
  assert.equal(ctx.replies.length, 0)
  assert.equal(mockBackend.sendMessageCalls.length, 0)
})

// ── Tests: pendingCustomPath flow ─────────────────────────────────────────────
//
// Regression coverage for the "Custom path..." workspace picker bug where the
// text-message handler dropped any path starting with "/" (which is every Unix
// absolute path) before reaching the pendingCustomPath check. The fix reorders
// the guards so the pending-path branch runs BEFORE the slash-command filter.

test("newpath: callback sets pendingCustomPath state and prompts for input", async () => {
  resetMocks()
  const chatId = 2001
  const ctx = createCallbackCtx({ chatId, data: "newpath:" })
  await callbackHandler(ctx)

  assert.ok(
    ctx.replies.some((r) => r.text === "Type the workspace path:"),
    "expected the 'Type the workspace path:' prompt",
  )
  assert.equal(ctx.callbackAnswers.length, 1, "newpath: must answer the callback exactly once")

  // Consume the pendingCustomPath state we just set so it does not leak into
  // any later test that might reuse this chatId. The cleanup is asserted by
  // the follow-up "no bound session" reply, which proves the state was drained.
  const drain = createMockCtx({ chatId, text: "/tmp/drain-after-newpath" })
  await textHandler(drain)
  assert.ok(
    drain.replies.some((r) => r.text.includes("Pick a CLI")),
    "drain step should consume pendingCustomPath and surface the picker",
  )
})

test("pendingCustomPath accepts a path starting with / (the custom-path-as-slash-command bug)", async () => {
  // Reproduces the production bug where a user typed
  // "/Users/testuser/projects/telegram" after clicking "Custom path..."
  // and the bridge silently dropped the message because of the slash-command filter.
  resetMocks()
  const chatId = 2002

  // Step 1: trigger the "Custom path..." callback to enter pendingCustomPath state
  await callbackHandler(createCallbackCtx({ chatId, data: "newpath:" }))

  // Step 2: send a Unix absolute path as a normal text message
  const textCtx = createMockCtx({ chatId, text: "/Users/testuser/projects/telegram" })
  await textHandler(textCtx)

  // The handler must surface a "Pick a CLI for ..." follow-up because two CLIs
  // are mocked (claude, kilo) — see supportedClis() mock at the top of this file.
  assert.ok(
    textCtx.replies.some((r) => r.text.includes("Pick a CLI")),
    "expected a 'Pick a CLI' follow-up reply for the typed custom path",
  )
  assert.equal(
    mockBackend.sendMessageCalls.length,
    0,
    "the path must NOT be routed to the backend as a chat message",
  )
})

test("pendingCustomPath registers the typed path for the multi-CLI picker flow", async () => {
  // With the default mock (supportedClis returns ["claude", "kilo"]), the
  // handler takes the multi-CLI branch and registers the typed path via
  // registerPath() for the follow-up "Pick a CLI" picker.
  resetMocks()
  pathRegistry.clear()
  const chatId = 2003

  await callbackHandler(createCallbackCtx({ chatId, data: "newpath:" }))
  await textHandler(createMockCtx({ chatId, text: "/tmp/some/workspace" }))

  // The path should have been registered and surfaced in the picker reply.
  // The pathRegistry mock captures it via registerPath() — verify it landed there.
  const registered = Array.from(pathRegistry.values())
  assert.ok(
    registered.includes("/tmp/some/workspace"),
    `expected '/tmp/some/workspace' in pathRegistry, got: ${JSON.stringify(registered)}`,
  )
})

test("pendingCustomPath dispatches to createNewSession on the single-CLI fast path", async () => {
  // When only one CLI is supported, the handler skips the picker and goes
  // straight to createNewSession with the typed directory. Override
  // mockSupportedClis.result to a single-element array to exercise this branch.
  resetMocks()
  pathRegistry.clear()
  mockSupportedClis.result = ["claude"]
  const chatId = 2010

  await callbackHandler(createCallbackCtx({ chatId, data: "newpath:" }))
  await textHandler(createMockCtx({ chatId, text: "/tmp/single-cli/workspace" }))

  assert.equal(
    mockCreateNewSessionCalls.length,
    1,
    "createNewSession must be called exactly once on the single-CLI fast path",
  )
  // createNewSession signature: (ctx, cli, directory, agentRegistryPromise)
  const [, cli, directory] = mockCreateNewSessionCalls[0]
  assert.equal(cli, "claude")
  assert.equal(directory, "/tmp/single-cli/workspace")
  // No path should have been registered — the picker flow is skipped entirely
  assert.equal(pathRegistry.size, 0, "single-CLI branch must not register a path for the picker")
})

test("pendingCustomPath state is cleared after a single text message", async () => {
  // After the user provides a path, the state must be consumed so a subsequent
  // text message goes through the normal routing (not treated as another path).
  resetMocks()
  const chatId = 2004

  await callbackHandler(createCallbackCtx({ chatId, data: "newpath:" }))
  await textHandler(createMockCtx({ chatId, text: "/tmp/first" }))

  // Now send another text message. With no bound session it should hit the
  // "No session bound" branch — proving the state was cleared and the message
  // is being routed as a normal chat input.
  const followup = createMockCtx({ chatId, text: "hello after path" })
  await textHandler(followup)

  assert.ok(
    followup.replies.some((r) => r.text.includes("No session bound")),
    "second text message must hit the no-bound-session branch (state cleared)",
  )
})

test("slash command (e.g. /sessions) is still ignored when pendingCustomPath is NOT set", async () => {
  // The original "/start is ignored" test guards the same behavior, but this
  // explicit test makes the intent obvious next to the pendingCustomPath cases.
  resetMocks()
  const ctx = createMockCtx({ chatId: 2005, text: "/sessions" })
  await textHandler(ctx)
  assert.equal(ctx.replies.length, 0, "no reply for slash command without pendingCustomPath")
  assert.equal(mockBackend.sendMessageCalls.length, 0)
})

test("pendingCustomPath surfaces parser error and does NOT create session", async () => {
  // When parseUserPath rejects (e.g. relative path, ~user/, empty), the handler
  // must reply with a clear error message and stop — no session creation, no
  // pathRegistry insertion.
  resetMocks()
  pathRegistry.clear()
  const chatId = 2006

  await callbackHandler(createCallbackCtx({ chatId, data: "newpath:" }))

  // Force the parser to reject the next input
  mockPathParser.result = {
    ok: false,
    error: "Relative paths are not supported here. Type an absolute path or use ~/ shorthand.",
  }

  const ctx = createMockCtx({ chatId, text: "projects/telegram" })
  await textHandler(ctx)

  // The error reply must be surfaced verbatim (with the standard prefix)
  assert.ok(
    ctx.replies.some((r) => r.text.includes("Relative paths are not supported")),
    `expected parser error in reply, got: ${JSON.stringify(ctx.replies.map((r) => r.text))}`,
  )
  assert.ok(
    ctx.replies.some((r) => r.text.includes("/new")),
    "expected reply to suggest /new for retry",
  )
  // No session created, no path registered
  assert.equal(mockCreateNewSessionCalls.length, 0, "createNewSession must not run on parser reject")
  assert.equal(pathRegistry.size, 0, "pathRegistry must remain empty on parser reject")
})

test("pendingCustomPath surfaces validator error for non-existent paths", async () => {
  // When validateWorkspaceDirectory rejects (typo, deleted dir, no permission),
  // the handler must reply with the validator error and stop — same behavior
  // as the parser reject branch.
  resetMocks()
  pathRegistry.clear()
  const chatId = 2007

  await callbackHandler(createCallbackCtx({ chatId, data: "newpath:" }))

  // Parser passes (looks like a valid absolute path), but validator rejects
  mockPathValidator.result = {
    ok: false,
    error: "Path does not exist: /Users/typoo/repo",
  }

  const ctx = createMockCtx({ chatId, text: "/Users/typoo/repo" })
  await textHandler(ctx)

  assert.ok(
    ctx.replies.some((r) => r.text.includes("Path does not exist")),
    `expected validator error in reply, got: ${JSON.stringify(ctx.replies.map((r) => r.text))}`,
  )
  assert.equal(mockCreateNewSessionCalls.length, 0, "createNewSession must not run on validator reject")
  assert.equal(pathRegistry.size, 0, "pathRegistry must remain empty on validator reject")
})

test("pendingCustomPath state is cleared even when parser rejects", async () => {
  // Important invariant: a rejected input still consumes the pendingCustomPath
  // state. Otherwise the user would be stuck in "Type the workspace path" mode
  // forever and a follow-up message could be misinterpreted.
  resetMocks()
  const chatId = 2008

  await callbackHandler(createCallbackCtx({ chatId, data: "newpath:" }))

  // First message: parser rejects
  mockPathParser.result = { ok: false, error: "Relative paths are not supported." }
  await textHandler(createMockCtx({ chatId, text: "bad/relative/path" }))

  // Second message: parser would now accept (state reset), but pendingCustomPath
  // should already be cleared, so the handler treats it as normal text routing.
  mockPathParser.result = null
  const followup = createMockCtx({ chatId, text: "hello" })
  await textHandler(followup)

  assert.ok(
    followup.replies.some((r) => r.text.includes("No session bound")),
    "second text must hit the no-bound-session branch (state cleared)",
  )
})

test("pendingCustomPath state is cleared even when validator rejects", async () => {
  // Same invariant as above, for the validator reject branch.
  resetMocks()
  const chatId = 2009

  await callbackHandler(createCallbackCtx({ chatId, data: "newpath:" }))

  mockPathValidator.result = { ok: false, error: "Path does not exist: /nope" }
  await textHandler(createMockCtx({ chatId, text: "/nope" }))

  // Second message: validator would now accept (state reset)
  mockPathValidator.result = { ok: true }
  const followup = createMockCtx({ chatId, text: "hello" })
  await textHandler(followup)

  assert.ok(
    followup.replies.some((r) => r.text.includes("No session bound")),
    "second text must hit the no-bound-session branch (state cleared)",
  )
})

test("pendingCustomPath drops state and routes through when user types a bot command", async () => {
  // Regression: when pendingCustomPath is set and the user types a slash command
  // like /sessions, the bridge must NOT try to validate it as a filesystem path.
  // Instead it should silently clear the pending state and return, letting grammy
  // route the command to the appropriate bot.command(...) handler.
  resetMocks()
  const chatId = 2011

  // Enter the pendingCustomPath state
  await callbackHandler(createCallbackCtx({ chatId, data: "newpath:" }))

  // User types a bot command — Telegram marks it with a bot_command entity at offset 0
  const ctx = createMockCtx({
    chatId,
    text: "/sessions",
    entities: [{ type: "bot_command", offset: 0, length: 9 }],
  })
  await textHandler(ctx)

  // No error reply (must not surface "Path does not exist: /sessions")
  assert.equal(ctx.replies.length, 0, "bot command must not produce any reply from the text handler")
  // No session creation
  assert.equal(mockCreateNewSessionCalls.length, 0, "createNewSession must not be called for a bot command")
  // State must be cleared so the user is not stuck
  const followup = createMockCtx({ chatId, text: "hello" })
  await textHandler(followup)
  assert.ok(
    followup.replies.some((r) => r.text.includes("No session bound")),
    "state must be cleared after bot command so next text is routed normally",
  )
})

test("pendingCustomPath still accepts /Users/... paths when no bot_command entity is present", async () => {
  // Unix absolute paths start with "/" but are NOT tagged with a bot_command entity.
  // The fix must not break this case — the parser/validator chain must still run.
  resetMocks()
  pathRegistry.clear()
  const chatId = 2012

  await callbackHandler(createCallbackCtx({ chatId, data: "newpath:" }))

  // No entities array (or empty) — this is a real path, not a command
  const ctx = createMockCtx({ chatId, text: "/Users/foo/repo", entities: [] })
  await textHandler(ctx)

  // Should reach the multi-CLI picker (registerPath + "Pick a CLI" reply)
  assert.ok(
    ctx.replies.some((r) => r.text.includes("Pick a CLI")),
    "real Unix path must still reach the picker flow",
  )
})

test("rate limiting is enforced inside processTextMessage after coalescing", async () => {
  resetMocks()
  // Rate limiting is now applied inside processTextMessage (after fragment coalescing)
  // so that multi-fragment messages count as a single slot, not N slots.
  mockRateLimit.result = { allowed: false, retryAfterMs: 5000 }
  mockDb.binding = { cli: "claude", session_id: "sess-rl", agent: null, directory: "/tmp" }
  const ctx = createMockCtx({ chatId: 1003, text: "hello" })
  await textHandler(ctx)
  // The handler now blocks the message and replies with a rate-limit error.
  assert.equal(mockBackend.sendMessageCalls.length, 0, "backend must not be called when rate-limited")
  assert.equal(ctx.replies.length, 1, "handler must reply with rate-limit error")
  assert.ok(ctx.replies[0].text.includes("Rate limit exceeded"), "reply must mention rate limit")
})

test("text message with bound session calls backend.sendMessage with correct args", async () => {
  resetMocks()
  mockDb.binding = { cli: "claude", session_id: "sess-1", agent: null, directory: "/tmp" }
  mockBackend._sendResult = { text: "AI response" }
  const ctx = createMockCtx({ chatId: 1004, text: "what is 2+2" })
  await textHandler(ctx)
  assert.equal(mockBackend.sendMessageCalls.length, 1)
  const call = mockBackend.sendMessageCalls[0]
  assert.equal(call.sessionId, "sess-1")
  assert.equal(call.text, "what is 2+2")
  assert.equal(call.agent, "default-agent")
  assert.ok(ctx.replies.some((r) => r.text.includes("AI response")))
})

test("inFlightChats guard prevents concurrent turns for the same chat", async () => {
  resetMocks()
  mockDb.binding = { cli: "claude", session_id: "sess-inflight", agent: null, directory: "/tmp" }

  let resolveFirst
  mockBackend._sendResult = () => new Promise((resolve) => { resolveFirst = resolve })

  const ctx1 = createMockCtx({ chatId: 1005, text: "first message" })
  const ctx2 = createMockCtx({ chatId: 1005, text: "second message" })

  // Start handler1 (it will block at backend.sendMessage)
  const p1 = textHandler(ctx1)

  // Drain all pending microtasks so handler1 advances to inFlightChats.add()
  // before we start handler2. setImmediate fires after the current microtask queue drains.
  await new Promise((resolve) => setImmediate(resolve))

  // handler1 is now blocked inside backend.sendMessage; inFlightChats has chatId 1005
  const p2 = textHandler(ctx2)
  await p2  // handler2 should resolve quickly with the in-flight guard message

  assert.ok(
    ctx2.replies.some((r) => r.text.includes("still waiting")),
    "expected an in-flight guard reply for the second concurrent message",
  )
  assert.equal(mockBackend.sendMessageCalls.length, 1, "only one backend call should have been made")

  // Unblock handler1 and let it finish cleanly
  resolveFirst({ text: "done" })
  await p1
})

// ── Tests: backend result routing ─────────────────────────────────────────────

test("backend returns {text} → replyChunks called with the response text", async () => {
  resetMocks()
  mockDb.binding = { cli: "claude", session_id: "sess-txt", agent: null, directory: "/tmp" }
  mockBackend._sendResult = { text: "The answer is 42" }
  const ctx = createMockCtx({ chatId: 1006, text: "deep question" })
  await textHandler(ctx)
  assert.ok(ctx.replies.some((r) => r.text.includes("The answer is 42")))
})

test("backend returns {question} → surfaces question text and keyboard", async () => {
  resetMocks()
  mockDb.binding = { cli: "kilo", session_id: "sess-kq", agent: "default-agent", directory: "/tmp" }
  mockBackend._sendResult = {
    question: {
      questions: [{
        header: "Confirmation",
        question: "Are you sure?",
        options: [{ label: "Yes" }, { label: "No" }],
      }],
    },
  }
  const ctx = createMockCtx({ chatId: 1007, text: "do risky thing" })
  await textHandler(ctx)
  assert.ok(
    ctx.replies.some((r) => r.text.includes("Are you sure?")),
    "expected question text to be surfaced",
  )
  assert.ok(
    ctx.replies.some((r) => r.text === "Choose an option:" && r.opts?.reply_markup),
    "expected inline keyboard to be sent",
  )
})

test("backend returns {error} → replies with error message and does not update binding", async () => {
  resetMocks()
  mockDb.binding = { cli: "claude", session_id: "sess-err", agent: null, directory: "/tmp" }
  mockBackend._sendResult = { error: "execution failed" }
  const ctx = createMockCtx({ chatId: 1008, text: "run command" })
  await textHandler(ctx)
  assert.ok(
    ctx.replies.some((r) => r.text.includes("execution failed")),
    "expected error text in reply",
  )
  assert.equal(mockDb.setChatBindingCalls.length, 0, "binding must not be updated on error")
})

// ── Tests: callback query routing ─────────────────────────────────────────────

test("callback bind:cli:sessionId binds the session and calls setChatBinding", async () => {
  resetMocks()
  mockDb.sessions["claude:sess-bind"] = {
    cli: "claude",
    session_id: "sess-bind",
    workspace: "/tmp/project",
    resume_cmd: null,
  }
  const ctx = createCallbackCtx({ chatId: 1009, data: "bind:claude:sess-bind" })
  await callbackHandler(ctx)

  assert.equal(mockDb.setChatBindingCalls.length, 1)
  const { chatId, binding } = mockDb.setChatBindingCalls[0]
  assert.equal(chatId, 1009)
  assert.equal(binding.cli, "claude")
  assert.equal(binding.session_id, "sess-bind")
  assert.equal(binding.model, null)
  assert.ok(
    ctx.callbackAnswers.some((a) => typeof a === "string" && a.includes("claude")),
    "answerCallbackQuery should confirm the bound CLI",
  )
})

test("callback bind: with unknown session answers with a not-found alert", async () => {
  resetMocks()
  const ctx = createCallbackCtx({ chatId: 1010, data: "bind:claude:nonexistent-id" })
  await callbackHandler(ctx)

  assert.equal(mockDb.setChatBindingCalls.length, 0, "setChatBinding must not be called")
  assert.ok(
    ctx.callbackAnswers.some((a) => a?.show_alert === true),
    "expected a show_alert answer for unknown session",
  )
})

test("callback bind: rejects sessions with sentinel /unknown workspace", async () => {
  // Defense-in-depth check for the /sessions rebind bug: even if a row with
  // workspace='/unknown' somehow slips into the DB (legacy data before the
  // cleanup migration runs, forged callback, future scanner regression), the
  // bind handler must refuse it with a clear user-facing alert instead of
  // letting the chat bind to a directory that will later explode at exec.
  resetMocks()
  mockDb.sessions["gemini:legacy-sess"] = {
    cli: "gemini",
    session_id: "legacy-sess",
    workspace: "/unknown",
    resume_cmd: null,
  }
  const ctx = createCallbackCtx({ chatId: 1018, data: "bind:gemini:legacy-sess" })
  await callbackHandler(ctx)

  assert.equal(
    mockDb.setChatBindingCalls.length,
    0,
    "setChatBinding must not be called for sentinel-workspace sessions",
  )
  assert.ok(
    ctx.callbackAnswers.some(
      (a) => a?.show_alert === true && typeof a?.text === "string" && a.text.includes("legacy format"),
    ),
    "expected a 'legacy format' show_alert for sentinel workspace",
  )
})

test("callback bind: rejects sessions with sentinel '.' workspace", async () => {
  resetMocks()
  mockDb.sessions["qwen:dot-sess"] = {
    cli: "qwen",
    session_id: "dot-sess",
    workspace: ".",
    resume_cmd: null,
  }
  const ctx = createCallbackCtx({ chatId: 1019, data: "bind:qwen:dot-sess" })
  await callbackHandler(ctx)

  assert.equal(mockDb.setChatBindingCalls.length, 0)
  assert.ok(
    ctx.callbackAnswers.some((a) => a?.show_alert === true),
    "expected a show_alert for '.' workspace",
  )
})

test("callback bind: sends last-turn follow-up reply when readLastTurn returns text", async () => {
  resetMocks()
  mockLastTurn.result = "Here is the last thing I said."
  mockDb.sessions["claude:sess-with-history"] = {
    cli: "claude",
    session_id: "sess-with-history",
    workspace: "/tmp/project",
    resume_cmd: null,
  }
  const ctx = createCallbackCtx({ chatId: 1020, data: "bind:claude:sess-with-history" })
  await callbackHandler(ctx)

  assert.equal(mockDb.setChatBindingCalls.length, 1, "session must be bound")
  assert.ok(
    ctx.replies.some((r) => r.text.includes("Last message") && r.text.includes("Here is the last thing I said.")),
    "expected a follow-up reply containing the last assistant message",
  )
})

test("callback bind: no extra reply when readLastTurn returns null", async () => {
  resetMocks()
  mockLastTurn.result = null
  mockDb.sessions["claude:sess-no-history"] = {
    cli: "claude",
    session_id: "sess-no-history",
    workspace: "/tmp/project",
    resume_cmd: null,
  }
  const ctx = createCallbackCtx({ chatId: 1021, data: "bind:claude:sess-no-history" })
  await callbackHandler(ctx)

  assert.equal(mockDb.setChatBindingCalls.length, 1, "session must be bound")
  assert.equal(ctx.replies.length, 0, "no follow-up reply when readLastTurn returns null")
})

test("callback newcli:cli:hash dispatches to createNewSession", async () => {
  resetMocks()
  pathRegistry.clear()
  const hash = "h-newcli-test"
  pathRegistry.set(hash, "/tmp/myproject")
  const ctx = createCallbackCtx({ chatId: 1011, data: `newcli:claude:${hash}` })
  await callbackHandler(ctx)

  assert.equal(mockCreateNewSessionCalls.length, 1)
  const [, cli, directory] = mockCreateNewSessionCalls[0]
  assert.equal(cli, "claude")
  assert.equal(directory, "/tmp/myproject")
})

test("callback newws:hash shows CLI picker when multiple CLIs are available", async () => {
  resetMocks()
  pathRegistry.clear()
  const hash = "h-newws-test"
  pathRegistry.set(hash, "/tmp/workspace")
  const ctx = createCallbackCtx({ chatId: 1012, data: `newws:${hash}` })
  await callbackHandler(ctx)

  assert.ok(
    ctx.editedMessages.some((e) => e.text.includes("Pick a CLI")),
    "expected CLI picker message",
  )
  // answerCallbackQuery is called with no text (just acknowledges the query)
  assert.equal(ctx.callbackAnswers.length, 1, "answerCallbackQuery must be called exactly once")
})

test("callback q:N selects the chosen option and submits it to the backend", async () => {
  resetMocks()
  const chatId = 1013

  // Step 1: surface a question by routing a text message to a question result
  mockDb.binding = { cli: "claude", session_id: "sess-q", agent: null, directory: "/tmp" }
  mockBackend._sendResult = {
    question: {
      questions: [{
        question: "Which option do you prefer?",
        options: [{ label: "Option A" }, { label: "Option B" }],
      }],
    },
  }
  const textCtx = createMockCtx({ chatId, text: "trigger question" })
  await textHandler(textCtx)

  assert.ok(
    textCtx.replies.some((r) => r.text.includes("Which option do you prefer?")),
    "question text should have been surfaced",
  )

  // Step 2: send q:0 callback to select Option A
  mockBackend._sendResult = { text: "You chose Option A" }
  mockBackend.sendMessageCalls = []
  const callbackCtx = createCallbackCtx({ chatId, data: "q:0" })
  await callbackHandler(callbackCtx)

  assert.equal(mockBackend.sendMessageCalls.length, 1, "backend must be called once for the answer")
  assert.equal(mockBackend.sendMessageCalls[0].text, "Option A")
  assert.ok(
    callbackCtx.callbackAnswers.some((a) => typeof a === "string" && a.includes("Option A")),
    "answerCallbackQuery should confirm the chosen option",
  )
})

test("callback q:N inFlight guard fires before consuming pending or answering", async () => {
  resetMocks()
  const chatId = 1017

  // Step 1: surface a question by routing a text message
  mockDb.binding = { cli: "claude", session_id: "sess-q-guard", agent: null, directory: "/tmp" }
  mockBackend._sendResult = {
    question: {
      questions: [{
        question: "Pick one",
        options: [{ label: "A" }, { label: "B" }],
      }],
    },
  }
  await textHandler(createMockCtx({ chatId, text: "trigger question" }))

  // Step 2: first q:0 tap — backend hangs so the chat stays in inFlightChats
  let resolveFirst
  mockBackend._sendResult = () => new Promise((resolve) => { resolveFirst = resolve })
  mockBackend.sendMessageCalls = []

  const callbackCtx1 = createCallbackCtx({ chatId, data: "q:0" })
  const p1 = callbackHandler(callbackCtx1)

  // Yield to setImmediate so handler1 advances past its awaited Telegram calls
  // and reaches inFlightChats.add() before the second tap is handled.
  // (setImmediate fires after the current microtask queue drains.)
  await new Promise((resolve) => setImmediate(resolve))

  // Step 3: second q:0 tap — should hit the inFlight guard
  const callbackCtx2 = createCallbackCtx({ chatId, data: "q:0" })
  await callbackHandler(callbackCtx2)

  // Guard must answer with the "in progress" alert and NOTHING else
  assert.ok(
    callbackCtx2.callbackAnswers.some((a) => a?.show_alert === true && a?.text?.includes("in progress")),
    "second tap should receive an in-progress alert",
  )
  assert.equal(
    callbackCtx2.editedMessages.length,
    0,
    "second tap must not edit the keyboard message",
  )
  assert.equal(
    mockBackend.sendMessageCalls.length,
    1,
    "backend must only be called once (from the first tap)",
  )

  // Cleanup: unblock the first turn so the test does not hang
  resolveFirst({ text: "done" })
  await p1
})

test("callback q:N with no pending question answers with a no-pending alert", async () => {
  resetMocks()
  const ctx = createCallbackCtx({ chatId: 1014, data: "q:0" })
  await callbackHandler(ctx)

  assert.ok(
    ctx.callbackAnswers.some((a) => a?.show_alert === true),
    "expected a show_alert answer when no pending question exists",
  )
  assert.equal(mockBackend.sendMessageCalls.length, 0)
})

test("callback setmodel:slug updates model in binding for claude", async () => {
  resetMocks()
  mockDb.binding = { cli: "claude", session_id: "sess-model", agent: null, directory: "/tmp", model: null }
  const ctx = createCallbackCtx({ chatId: 1015, data: "setmodel:claude-opus-4" })
  await callbackHandler(ctx)

  assert.equal(mockDb.setChatBindingCalls.length, 1)
  assert.equal(mockDb.setChatBindingCalls[0].binding.model, "claude-opus-4")
  assert.ok(
    ctx.callbackAnswers.some((a) => typeof a === "string" && a.includes("claude-opus-4")),
    "answerCallbackQuery should confirm the model slug",
  )
})

test("callback setmodel: on unsupported CLI answers with not-supported alert", async () => {
  resetMocks()
  mockDb.binding = { cli: "kilo", session_id: "sess-km", agent: null, directory: "/tmp", model: null }
  const ctx = createCallbackCtx({ chatId: 1016, data: "setmodel:some-model" })
  await callbackHandler(ctx)

  assert.equal(mockDb.setChatBindingCalls.length, 0, "setChatBinding must not be called")
  assert.ok(
    ctx.callbackAnswers.some((a) => a?.show_alert === true),
    "expected a show_alert for unsupported CLI",
  )
})
