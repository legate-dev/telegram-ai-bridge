import { mock, test } from "node:test"
import assert from "node:assert/strict"
import {
  createMockCtx,
  createCallbackCtx,
  makeMockBot,
} from "./helpers/message-handler-mocks.js"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"
process.env.BRIDGE_MESSAGE_DEBOUNCE_MS = "0"

// ── KiloClient unit tests ────────────────────────────────────────────────────

const mockConfig = {
  kiloStatusTimeoutMs: 5000,
  kiloAbortTimeoutMs: 10000,
  kiloSubmitTimeoutMs: 15000,
  kiloTurnTimeoutMs: 900000,
  kiloStaleTimeoutMs: 120000,
  kiloPollIntervalMs: 3000,
  kiloPollInitialDelayMs: 5000,
  kiloTimeoutMs: 120000,
  kiloRetries: 2,
  kiloVariant: "high",
  bridgePendingPermissionTtlMs: 300000,
  bridgePendingQuestionTtlMs: 600000,
  bridgeMessageDebounceMs: 0,
}

await mock.module("../src/config.js", {
  namedExports: {
    config: mockConfig,
  },
})

const mockLog = {
  debugCalls: [],
  infoCalls: [],
  debug(...args) { this.debugCalls.push(args) },
  info(...args) { this.infoCalls.push(args) },
  warn() {},
  error() {},
}

await mock.module("../src/log.js", {
  namedExports: {
    log: mockLog,
    redactString: (v) => v,
  },
})

const { KiloClient } = await import("../src/kilo-client.js")

function makeKiloClient(opts = {}) {
  return new KiloClient({
    baseUrl: "http://localhost:4096",
    username: opts.username ?? "user",
    password: opts.password ?? "",
  })
}

// ── Test 1: _checkForPendingPermission returns null when queue is empty ───────

test("_checkForPendingPermission returns null when the permission queue is empty", async () => {
  const client = makeKiloClient()
  client.listPendingPermissions = async () => []

  const result = await client._checkForPendingPermission("sess-abc")
  assert.equal(result, null)
})

// ── Test 2: _checkForPendingPermission returns matching request ───────────────

test("_checkForPendingPermission returns the matching request when one entry matches sessionID", async () => {
  const client = makeKiloClient()
  const req = {
    id: "req-1",
    sessionID: "sess-abc",
    permission: "bash",
    patterns: ["rm -rf /tmp"],
    metadata: {},
    always: [],
  }
  client.listPendingPermissions = async () => [req]

  const result = await client._checkForPendingPermission("sess-abc")
  assert.deepEqual(result, req)
})

// ── Test 3: _checkForPendingPermission filters by sessionID ──────────────────

test("_checkForPendingPermission returns null when pending exists but ALL entries have a different sessionID", async () => {
  const client = makeKiloClient()
  const req = {
    id: "req-2",
    sessionID: "sess-other",
    permission: "edit",
    patterns: ["~/secrets/*"],
    metadata: {},
    always: [],
  }
  client.listPendingPermissions = async () => [req]

  const result = await client._checkForPendingPermission("sess-mine")
  assert.equal(result, null)
})

// ── Test 4: _checkForPendingPermission does not throw on network error ────────

test("_checkForPendingPermission returns null and logs debug on network error", async () => {
  const client = makeKiloClient()
  mockLog.debugCalls.length = 0

  client.listPendingPermissions = async () => { throw new Error("ECONNREFUSED") }

  const result = await client._checkForPendingPermission("sess-err")
  assert.equal(result, null, "should return null on error, not throw")

  const logged = mockLog.debugCalls.find(
    (c) => c[1] === "permission_check_failed" && c[2]?.session_id === "sess-err",
  )
  assert.ok(logged, "should log a debug event for the failure")
})

// ── Test 5: replyToPermission POSTs to the correct endpoint ──────────────────

test("replyToPermission POSTs to /permission/<id>/reply with the correct body", async () => {
  const client = makeKiloClient()
  let capturedUrl
  let capturedBody

  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url.toString()
    capturedBody = JSON.parse(opts.body)
    return { ok: true, status: 200, statusText: "OK", async text() { return '{"ok":true}' } }
  }

  try {
    await client.replyToPermission("req-xyz", "once")
  } finally {
    globalThis.fetch = original
  }

  assert.ok(capturedUrl.includes("/permission/req-xyz/reply"), `expected /permission/req-xyz/reply, got: ${capturedUrl}`)
  assert.deepEqual(capturedBody, { reply: "once" })
})

// ── Test 6: replyToPermission with "reject" reply ────────────────────────────

test("replyToPermission sends reply='reject' when called with 'reject'", async () => {
  const client = makeKiloClient()
  let capturedBody

  const original = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body)
    return { ok: true, status: 200, statusText: "OK", async text() { return '{}' } }
  }

  try {
    await client.replyToPermission("req-deny", "reject")
  } finally {
    globalThis.fetch = original
  }

  assert.deepEqual(capturedBody, { reply: "reject" })
})

// ── Test 7: allowEverything POSTs to /allow-everything ───────────────────────

test("allowEverything POSTs to /allow-everything with enable and requestID (global)", async () => {
  const client = makeKiloClient()
  let capturedUrl
  let capturedBody

  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url.toString()
    capturedBody = JSON.parse(opts.body)
    return { ok: true, status: 200, statusText: "OK", async text() { return '{}' } }
  }

  try {
    await client.allowEverything({ enable: true, requestID: "req-global" })
  } finally {
    globalThis.fetch = original
  }

  assert.ok(capturedUrl.includes("/allow-everything"), `expected /allow-everything, got: ${capturedUrl}`)
  assert.deepEqual(capturedBody, { enable: true, requestID: "req-global" })
})

test("allowEverything includes sessionID in body for session-scoped call", async () => {
  const client = makeKiloClient()
  let capturedBody

  const original = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body)
    return { ok: true, status: 200, statusText: "OK", async text() { return '{}' } }
  }

  try {
    await client.allowEverything({ enable: true, sessionID: "sess-abc", requestID: "req-sess" })
  } finally {
    globalThis.fetch = original
  }

  assert.deepEqual(capturedBody, { enable: true, sessionID: "sess-abc", requestID: "req-sess" })
})

// ── Message-handler tests ────────────────────────────────────────────────────

// These tests require the full message-handler module with all its dependencies mocked.

const mockDb = { binding: null, setChatBindingCalls: [] }
const mockRateLimit = { result: { allowed: true } }

const mockBackend = {
  name: "kilo",
  supported: true,
  sendMessageCalls: [],
  resumeTurnCalls: [],
  _sendResult: { text: "ok" },
  _resumeResult: { text: "response after permission" },
  kilo: {
    replyToPermissionCalls: [],
    async replyToPermission(requestId, reply) {
      this.replyToPermissionCalls.push({ requestId, reply })
    },
    allowEverythingCalls: [],
    async allowEverything(opts) {
      this.allowEverythingCalls.push({ ...opts })
    },
  },
  async sendMessage(args) {
    this.sendMessageCalls.push({ ...args })
    if (typeof this._sendResult === "function") return this._sendResult(args)
    return this._sendResult
  },
  async resumeTurn(sessionId, directory, messageCountBefore) {
    this.resumeTurnCalls.push({ sessionId, directory, messageCountBefore })
    return this._resumeResult
  },
}

function resetHandlerMocks() {
  mockDb.binding = null
  mockDb.setChatBindingCalls = []
  mockBackend.sendMessageCalls = []
  mockBackend.resumeTurnCalls = []
  mockBackend._sendResult = { text: "ok" }
  mockBackend._resumeResult = { text: "response after permission" }
  mockBackend.supported = true
  mockRateLimit.result = { allowed: true }
  mockBackend.kilo.replyToPermissionCalls = []
  mockBackend.kilo.allowEverythingCalls = []
}

await mock.module("../src/db.js", {
  namedExports: {
    getChatBinding: () => mockDb.binding,
    setChatBinding: (chatId, binding) => {
      mockDb.setChatBindingCalls.push({ chatId, binding })
      mockDb.binding = binding
    },
    getCliSessionById: () => null,
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
    supportedClis: () => ["claude", "kilo"],
  },
})

await mock.module("../src/commands.js", {
  namedExports: {
    createNewSession: async () => {},
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
    parseUserPath: (p) => ({ ok: true, path: p }),
    validateWorkspaceDirectory: () => ({ ok: true }),
    resolveSessionLabel: (binding) => binding?.session_id?.slice(0, 12) ?? "unknown",
  },
})

await mock.module("grammy", {
  namedExports: {
    InlineKeyboard: class {
      constructor() { this._buttons = [] }
      text(label, data) { this._buttons.push({ label, data }); return this }
      row() { return this }
    },
  },
})

const {
  setupHandlers,
  setPendingPermission,
  hasPendingPermission,
  getPendingPermission,
  clearPendingPermission,
} = await import("../src/message-handler.js")

const fakeRegistry = Promise.resolve({
  bridgeDefault: "default-agent",
  primaryAgents: ["default-agent"],
  bridgeAgentFallbacks: [],
})

const bot = makeMockBot()
setupHandlers(bot, null, fakeRegistry)

const textHandler = bot.handlers["message:text"]
const callbackHandler = bot.handlers["callback_query:data"]

// ── Test 7: KiloBackend.sendMessage returns { permission } on permission_pending

test("processTextMessage surfaces permission when backend returns { permission }", async () => {
  resetHandlerMocks()
  const permissionData = {
    id: "req-surface",
    sessionID: "sess-1",
    permission: "bash",
    patterns: ["echo hello"],
    metadata: {},
    always: [],
  }
  mockDb.binding = { cli: "kilo", session_id: "sess-1", agent: null, directory: "/tmp" }
  mockBackend._sendResult = { permission: permissionData }

  const ctx = createMockCtx({ chatId: 8001, text: "do something" })
  await textHandler(ctx)

  // Should have replied with permission prompt
  assert.ok(
    ctx.replies.some((r) => r.text.includes("Permission required")),
    `expected 'Permission required' in replies, got: ${JSON.stringify(ctx.replies.map((r) => r.text))}`,
  )
  // Should show inline keyboard prompt
  assert.ok(
    ctx.replies.some((r) => r.text === "Choose an action:"),
    "expected 'Choose an action:' prompt",
  )
})

// ── Test 8: perm:once callback calls replyToPermission and edits message ─────

test("perm:once callback calls replyToPermission with 'once' and edits message with label", async () => {
  resetHandlerMocks()
  const chatKey = "8002"
  const requestId = "req-8002"

  // Set up pending permission state as surfacePermission would (includes resume context)
  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-2", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId,
    text: "🔐 Permission required\n\nTool: bash\nPatterns: echo hello",
    sessionId: "sess-2",
    directory: "/tmp",
    messageCountBefore: 3,
  })

  const ctx = createCallbackCtx({ chatId: 8002, data: `perm:once:${requestId}` })
  await callbackHandler(ctx)

  // Should call replyToPermission with "once"
  assert.equal(mockBackend.kilo.replyToPermissionCalls.length, 1, "replyToPermission should be called once")
  assert.equal(mockBackend.kilo.replyToPermissionCalls[0].requestId, requestId)
  assert.equal(mockBackend.kilo.replyToPermissionCalls[0].reply, "once")

  // Should edit the original message to show the outcome
  assert.ok(
    ctx.editedMessages.some((m) => m.text.includes("Allowed once")),
    `expected 'Allowed once' in editedMessages, got: ${JSON.stringify(ctx.editedMessages)}`,
  )

  // Should answer the callback query immediately (before the POST) with the label
  assert.equal(ctx.callbackAnswers.length, 1)
  const answer = ctx.callbackAnswers[0]
  assert.ok(
    typeof answer === "object" && String(answer.text).includes("Allowed once"),
    `expected callback answer with 'Allowed once', got: ${JSON.stringify(ctx.callbackAnswers)}`,
  )

  // Should resume the paused Kilo turn after the permission reply
  assert.equal(mockBackend.resumeTurnCalls.length, 1, "resumeTurn should be called once")
  assert.deepEqual(mockBackend.resumeTurnCalls[0], { sessionId: "sess-2", directory: "/tmp", messageCountBefore: 3 })

  // Should deliver the resumed response to the user
  assert.ok(
    ctx.replies.some((r) => r.text === "response after permission"),
    `expected resumed response in replies, got: ${JSON.stringify(ctx.replies.map((r) => r.text))}`,
  )

  // Pending permission should be consumed after a successful reply
  assert.ok(!hasPendingPermission(chatKey), "pendingPermission should be cleared after successful reply")
})

// ── Test 9: stale perm: callback shows alert ──────────────────────────────────

test("perm: callback with wrong requestId shows 'No pending permission' alert", async () => {
  resetHandlerMocks()
  const chatKey = "8003"

  // Set a pending permission with one request ID
  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-3", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId: "correct-id",
    text: "🔐 Permission required",
  })

  // But callback arrives with a DIFFERENT request ID (stale button)
  const ctx = createCallbackCtx({ chatId: 8003, data: "perm:once:stale-id" })
  await callbackHandler(ctx)

  // Should answer with alert
  assert.ok(
    ctx.callbackAnswers.some((a) => typeof a === "object" && a.show_alert === true),
    "expected show_alert callback answer for stale request",
  )
  assert.ok(
    ctx.callbackAnswers.some((a) => typeof a === "object" && String(a.text).includes("No pending permission")),
    `expected 'No pending permission' text, got: ${JSON.stringify(ctx.callbackAnswers)}`,
  )

  // Should NOT call replyToPermission
  assert.equal(mockBackend.kilo.replyToPermissionCalls.length, 0, "replyToPermission must not be called for stale request")
})

// ── Test for invalid reply value ──────────────────────────────────────────────

test("perm: callback with invalid reply value shows 'Invalid action' alert without calling replyToPermission", async () => {
  resetHandlerMocks()
  const chatKey = "8004"
  const requestId = "req-8004"

  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-4", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId,
    text: "🔐 Permission required",
  })

  // Forged callback with an unknown reply value
  const ctx = createCallbackCtx({ chatId: 8004, data: `perm:hack:${requestId}` })
  await callbackHandler(ctx)

  assert.ok(
    ctx.callbackAnswers.some((a) => typeof a === "object" && a.show_alert === true),
    "expected show_alert for invalid reply",
  )
  assert.ok(
    ctx.callbackAnswers.some((a) => typeof a === "object" && String(a.text).includes("Invalid action")),
    `expected 'Invalid action', got: ${JSON.stringify(ctx.callbackAnswers)}`,
  )
  assert.equal(mockBackend.kilo.replyToPermissionCalls.length, 0, "replyToPermission must not be called for invalid reply")
  // Pending entry must remain (user can retry with a valid tap)
  assert.ok(hasPendingPermission(chatKey), "pending entry must survive an invalid reply attempt")
})

// ── Test: pending entry survives a failed replyToPermission (retry allowed) ───

test("pending permission entry is NOT cleared when replyToPermission throws", async () => {
  resetHandlerMocks()
  const chatKey = "8005"
  const requestId = "req-8005"
  const originalReplyToPermission = mockBackend.kilo.replyToPermission

  try {
    // Make replyToPermission throw
    mockBackend.kilo.replyToPermission = async () => { throw new Error("network error") }

    setPendingPermission(chatKey, {
      binding: { cli: "kilo", session_id: "sess-5", agent: null, directory: "/tmp" },
      agent: "default-agent",
      backend: mockBackend,
      requestId,
      text: "🔐 Permission required",
    })

    const ctx = createCallbackCtx({ chatId: 8005, data: `perm:once:${requestId}` })
    await callbackHandler(ctx)

    // Pending entry must survive so the user can retry
    assert.ok(hasPendingPermission(chatKey), "pending entry must survive a failed replyToPermission so the user can retry")
  } finally {
    mockBackend.kilo.replyToPermission = originalReplyToPermission
  }
})

// ── Test: processTextMessage blocks new turns while permission is pending ─────

test("processTextMessage blocks new turns when a permission prompt is pending", async () => {
  resetHandlerMocks()
  const chatKey = "8006"

  mockDb.binding = { cli: "kilo", session_id: "sess-6", agent: null, directory: "/tmp" }

  // Manually set a pending permission for this chat (simulates a previous turn that returned { permission })
  setPendingPermission(chatKey, {
    binding: mockDb.binding,
    agent: "default-agent",
    backend: mockBackend,
    requestId: "req-pending",
    text: "🔐 Permission required",
    sessionId: "sess-6",
    directory: "/tmp",
    messageCountBefore: 2,
  })

  const ctx = createMockCtx({ chatId: 8006, text: "another message" })
  await textHandler(ctx)

  // Should NOT call sendMessage — new turn was blocked
  assert.equal(mockBackend.sendMessageCalls.length, 0, "sendMessage must not be called while permission is pending")

  // Should reply with the pending-permission message
  assert.ok(
    ctx.replies.some((r) => r.text.includes("permission request is still pending")),
    `expected pending-permission message, got: ${JSON.stringify(ctx.replies.map((r) => r.text))}`,
  )
})

// ── Test: perm: callback skips resume when no sessionId is stored ─────────────

test("perm: callback skips resumeTurn when the pending entry has no sessionId", async () => {
  resetHandlerMocks()
  const chatKey = "8007"
  const requestId = "req-8007"

  // Emulate an entry set without resume context (e.g., legacy or direct test)
  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-7", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId,
    text: "🔐 Permission required",
    // no sessionId — resume should be skipped
  })

  const ctx = createCallbackCtx({ chatId: 8007, data: `perm:once:${requestId}` })
  await callbackHandler(ctx)

  assert.equal(mockBackend.kilo.replyToPermissionCalls.length, 1, "replyToPermission should still be called")
  assert.equal(mockBackend.resumeTurnCalls.length, 0, "resumeTurn must not be called when sessionId is absent")
  assert.ok(!hasPendingPermission(chatKey), "pending entry should be cleared after successful reply")
})

// ── Test 10: pendingPermissions TTL ──────────────────────────────────────────

test("pendingPermissions entry auto-expires after bridgePendingPermissionTtlMs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })

  const chatKey = "ttl-perm-1"
  setPendingPermission(chatKey, {
    binding: {},
    agent: null,
    backend: null,
    requestId: "req-ttl",
    text: "🔐 Permission required",
  })

  assert.ok(hasPendingPermission(chatKey), "entry should exist immediately after setPendingPermission")
  assert.ok(getPendingPermission(chatKey)?.timeoutId, "entry should have a scheduled timeoutId")

  t.mock.timers.tick(mockConfig.bridgePendingPermissionTtlMs + 1)

  assert.ok(!hasPendingPermission(chatKey), "entry should be removed after TTL has elapsed")
})

// ── Test: concurrent perm: taps are blocked while the first is in flight ──────

test("perm: concurrent tap while first is in flight shows 'Already processing' alert", async () => {
  resetHandlerMocks()
  const chatKey = "8008"
  const requestId = "req-8008"

  // Simulate a first tap already in flight by pre-setting replying=true
  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-8", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId,
    text: "🔐 Permission required",
    sessionId: "sess-8",
    directory: "/tmp",
    messageCountBefore: 0,
  })
  getPendingPermission(chatKey).replying = true

  const ctx = createCallbackCtx({ chatId: 8008, data: `perm:once:${requestId}` })
  await callbackHandler(ctx)

  // Should return an alert without calling replyToPermission
  assert.ok(
    ctx.callbackAnswers.some((a) => typeof a === "object" && a.show_alert === true),
    "expected show_alert for concurrent tap",
  )
  assert.ok(
    ctx.callbackAnswers.some((a) => typeof a === "object" && String(a.text).includes("Already processing")),
    `expected 'Already processing' text, got: ${JSON.stringify(ctx.callbackAnswers)}`,
  )
  assert.equal(mockBackend.kilo.replyToPermissionCalls.length, 0, "replyToPermission must not be called for concurrent tap")

  // Pending entry must survive (so the first tap can still complete)
  assert.ok(hasPendingPermission(chatKey), "pending entry must remain while in-flight")
})

// ── Test: failed replyToPermission clears replying flag so user can retry ─────

test("perm: callback clears replying flag on replyToPermission failure so user can retry", async () => {
  resetHandlerMocks()
  const chatKey = "8009"
  const requestId = "req-8009"

  const originalReply = mockBackend.kilo.replyToPermission
  try {
    mockBackend.kilo.replyToPermission = async () => { throw new Error("network error") }

    setPendingPermission(chatKey, {
      binding: { cli: "kilo", session_id: "sess-9", agent: null, directory: "/tmp" },
      agent: "default-agent",
      backend: mockBackend,
      requestId,
      text: "🔐 Permission required",
      sessionId: "sess-9",
      directory: "/tmp",
      messageCountBefore: 0,
    })

    const ctx = createCallbackCtx({ chatId: 8009, data: `perm:once:${requestId}` })
    await callbackHandler(ctx)

    // Pending entry must survive so the user can retry
    assert.ok(hasPendingPermission(chatKey), "pending entry must survive a failed replyToPermission")
    // replying flag must be cleared so the next tap can proceed
    assert.ok(!getPendingPermission(chatKey).replying, "replying flag must be cleared after failure so user can retry")
  } finally {
    mockBackend.kilo.replyToPermission = originalReply
  }
})

// ── Test: resumeResult.question is surfaced after resumeTurn ──────────────────

test("perm: callback surfaces question when resumeTurn returns { question }", async () => {
  resetHandlerMocks()
  const chatKey = "8010"
  const requestId = "req-8010"

  mockBackend._resumeResult = {
    question: {
      questions: [{ question: "Overwrite existing file?", options: [{ label: "Yes" }, { label: "No" }] }],
    },
  }

  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-10", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId,
    text: "🔐 Permission required",
    sessionId: "sess-10",
    directory: "/tmp",
    messageCountBefore: 2,
  })

  const ctx = createCallbackCtx({ chatId: 8010, data: `perm:once:${requestId}` })
  await callbackHandler(ctx)

  // resumeTurn should have been called
  assert.equal(mockBackend.resumeTurnCalls.length, 1, "resumeTurn must be called once")

  // The question text must be surfaced to the user
  assert.ok(
    ctx.replies.some((r) => r.text?.includes("Overwrite existing file?")),
    `expected question text in replies, got: ${JSON.stringify(ctx.replies.map((r) => r.text))}`,
  )

  // Pending permission should be consumed
  assert.ok(!hasPendingPermission(chatKey), "pendingPermission should be cleared after successful reply")
})

// ── Test: perm: callback surfaces nested permission when resumeTurn returns { permission } ──

test("perm: callback surfaces nested permission when resumeTurn returns { permission }", async () => {
  resetHandlerMocks()
  const chatKey = "8011"
  const requestId = "req-8011"

  // resumeTurn returns another permission — the recursive path
  mockBackend._resumeResult = {
    permission: {
      id: "nested-perm-id",
      toolName: "bash",
      description: "run another command",
    },
    messageCountBefore: 3,
  }

  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-11", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId,
    text: "🔐 Permission required",
    sessionId: "sess-11",
    directory: "/tmp",
    messageCountBefore: 2,
  })

  const ctx = createCallbackCtx({ chatId: 8011, data: `perm:once:${requestId}` })
  await callbackHandler(ctx)

  // resumeTurn must have been called
  assert.equal(mockBackend.resumeTurnCalls.length, 1, "resumeTurn must be called once")

  // A new pending permission must exist for the nested permission
  assert.ok(hasPendingPermission(chatKey), "nested permission must be stored as pending")
  const nested = getPendingPermission(chatKey)
  assert.equal(nested?.requestId, "nested-perm-id", "nested requestId must match")
})

// ── Test: perm: callback surfaces error when resumeTurn returns { error } ──────

test("perm: callback surfaces backend error when resumeTurn returns { error }", async () => {
  resetHandlerMocks()
  const chatKey = "8012"
  const requestId = "req-8012"

  mockBackend._resumeResult = { error: "kilo session crashed" }

  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-12", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId,
    text: "🔐 Permission required",
    sessionId: "sess-12",
    directory: "/tmp",
    messageCountBefore: 4,
  })

  const ctx = createCallbackCtx({ chatId: 8012, data: `perm:once:${requestId}` })
  await callbackHandler(ctx)

  // resumeTurn must have been called
  assert.equal(mockBackend.resumeTurnCalls.length, 1, "resumeTurn must be called once")

  // Error text must reach the user
  assert.ok(
    ctx.replies.some((r) => r.text?.includes("kilo error")),
    `expected kilo error in replies, got: ${JSON.stringify(ctx.replies.map((r) => r.text))}`,
  )

  // Pending permission must be cleared (reply succeeded)
  assert.ok(!hasPendingPermission(chatKey), "pendingPermission must be cleared after successful reply")
})

// ── Test: clearPendingPermission removes a stale pending entry ────────────────

test("clearPendingPermission removes pending entry (simulates /abort or /detach)", () => {
  const chatKey = "8013"

  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-13", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId: "req-8013",
    text: "🔐 Permission required",
  })

  assert.ok(hasPendingPermission(chatKey), "pending entry must exist before clear")
  clearPendingPermission(chatKey)
  assert.ok(!hasPendingPermission(chatKey), "pending entry must be removed after clearPendingPermission")
})

// ── ae: callback tests (allow everything) ────────────────────────────────────

test("ae:session callback calls allowEverything with sessionID+requestID and delivers resumed response", async () => {
  resetHandlerMocks()
  const chatKey = "8020"
  const requestId = "req-ae-session"

  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-ae", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId,
    text: "🔐 Permission required\n\nTool: bash",
    sessionId: "sess-ae",
    directory: "/tmp",
    messageCountBefore: 2,
  })

  const ctx = createCallbackCtx({ chatId: 8020, data: `ae:session:${requestId}` })
  await callbackHandler(ctx)

  assert.equal(mockBackend.kilo.allowEverythingCalls.length, 1, "allowEverything should be called once")
  const call = mockBackend.kilo.allowEverythingCalls[0]
  assert.equal(call.enable, true)
  assert.equal(call.sessionID, "sess-ae", "session-scoped: must include sessionID")
  assert.equal(call.requestID, requestId)

  assert.ok(!hasPendingPermission(chatKey), "pending permission must be cleared")
  assert.ok(
    ctx.replies.some((r) => r.text === "response after permission"),
    "expected resumed response delivered to user",
  )
})

test("ae:global callback calls allowEverything without sessionID", async () => {
  resetHandlerMocks()
  const chatKey = "8021"
  const requestId = "req-ae-global"

  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-ae2", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId,
    text: "🔐 Permission required",
    sessionId: "sess-ae2",
    directory: "/tmp",
    messageCountBefore: 1,
  })

  const ctx = createCallbackCtx({ chatId: 8021, data: `ae:global:${requestId}` })
  await callbackHandler(ctx)

  const call = mockBackend.kilo.allowEverythingCalls[0]
  assert.equal(call.enable, true)
  assert.equal(call.sessionID, undefined, "global: must NOT include sessionID")
  assert.equal(call.requestID, requestId)
  assert.ok(!hasPendingPermission(chatKey), "pending permission must be cleared")
})

test("ae: callback with invalid scope is rejected without touching state", async () => {
  resetHandlerMocks()
  const chatKey = "8022"
  const requestId = "req-ae-invalid"

  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-ae3", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId,
    text: "🔐 Permission required",
    sessionId: "sess-ae3",
    directory: "/tmp",
    messageCountBefore: 1,
  })

  const ctx = createCallbackCtx({ chatId: 8022, data: `ae:everything:${requestId}` })
  await callbackHandler(ctx)

  assert.equal(mockBackend.kilo.allowEverythingCalls.length, 0, "allowEverything must not be called for invalid scope")
  assert.ok(hasPendingPermission(chatKey), "pending permission must remain after rejected scope")
  assert.ok(
    ctx.callbackAnswers.some((a) => a?.show_alert === true),
    "expected a show_alert for invalid scope",
  )
  clearPendingPermission(chatKey)
})

test("ae: callback with stale requestId is rejected", async () => {
  resetHandlerMocks()
  const chatKey = "8023"

  setPendingPermission(chatKey, {
    binding: { cli: "kilo", session_id: "sess-ae4", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: mockBackend,
    requestId: "req-current",
    text: "🔐 Permission required",
    sessionId: "sess-ae4",
    directory: "/tmp",
    messageCountBefore: 1,
  })

  const ctx = createCallbackCtx({ chatId: 8023, data: "ae:session:req-stale" })
  await callbackHandler(ctx)

  assert.equal(mockBackend.kilo.allowEverythingCalls.length, 0, "allowEverything must not be called for stale requestId")
  assert.ok(hasPendingPermission(chatKey), "pending permission must remain")
  clearPendingPermission(chatKey)
})

test("ae: callback is rejected when backend has no allowEverything (e.g. Claude permission)", async () => {
  resetHandlerMocks()
  const chatKey = "8024"
  const requestId = "req-ae-noop"

  // Backend without kilo.allowEverything (simulates a Claude permission being pending)
  const claudeLikeBackend = {
    name: "claude",
    supported: true,
    kilo: null,
    replyPermission: () => {},
  }

  setPendingPermission(chatKey, {
    binding: { cli: "claude", session_id: "sess-claude", agent: null, directory: "/tmp" },
    agent: "default-agent",
    backend: claudeLikeBackend,
    requestId,
    text: "🔐 Permission required",
    sessionId: "sess-claude",
    directory: "/tmp",
    messageCountBefore: 1,
  })

  const ctx = createCallbackCtx({ chatId: 8024, data: `ae:session:${requestId}` })
  await callbackHandler(ctx)

  assert.ok(
    ctx.callbackAnswers.some((a) => a?.show_alert === true),
    "expected show_alert for unsupported backend",
  )
  clearPendingPermission(chatKey)
})
