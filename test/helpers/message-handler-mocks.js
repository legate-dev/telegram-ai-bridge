/**
 * Reusable mock builders for message-handler tests.
 * Used by test/message-handler.test.js and follow-up test files (B3, B4, R1, R2).
 */

/**
 * Creates a mock Grammy context for text-message handlers.
 *
 * When `entities` is not explicitly provided and `text` begins with "/" followed
 * by alphanumerics (e.g. "/start", "/new foo"), this mock automatically synthesizes
 * a `bot_command` entity at offset 0 — mirroring what Telegram's real API does so
 * the handler can rely on the authoritative classifier (not `text.startsWith("/")`).
 * Pass `entities: []` explicitly to simulate a raw slash-like payload without the
 * entity tag (e.g. for pendingCustomPath path inputs that start with "/Users/...").
 *
 * @param {{ chatId?: number, text?: string, from?: object, entities?: any[] }} opts
 */
export function createMockCtx({ chatId = 123, text = "hello", from = { id: 1 }, entities } = {}) {
  // Auto-synthesize bot_command entity when entities is omitted (undefined) AND
  // the text looks like a real slash command — meaning a single alphanumeric
  // word after the slash, followed by whitespace OR end of string. This
  // mirrors what Telegram actually tags: "/start" and "/new foo" get the
  // bot_command entity, but "/tmp/some/workspace" and "/Users/foo/repo" do
  // NOT (they have a slash inside, so they're not bot commands).
  //
  // Caller can pass entities:[] to opt out entirely (e.g. path inputs), or
  // pass explicit entities:[...] to simulate any Telegram entity layout.
  if (entities === undefined) {
    const match = typeof text === "string" ? text.match(/^\/([a-zA-Z0-9_]+)(?:\s|$)/) : null
    entities = match ? [{ type: "bot_command", offset: 0, length: match[0].trimEnd().length }] : []
  }
  return {
    chat: { id: chatId },
    from,
    message: { text, entities },
    replies: [],
    callbackAnswers: [],
    editedMessages: [],
    reply: async function (replyText, opts) {
      this.replies.push({ text: replyText, opts })
      return { message_id: this.replies.length }
    },
    // Grammy signature: answerCallbackQuery(text?, other?)
    // The handler also passes plain objects {text, show_alert} as the first arg
    // (a pattern Grammy supports), so this mock accepts whatever is passed.
    answerCallbackQuery: async function (text, _other) {
      this.callbackAnswers.push(text ?? {})
      return true
    },
    editMessageText: async function (editText, opts) {
      this.editedMessages.push({ text: editText, opts })
      return true
    },
    api: {
      sendChatAction: async () => true,
    },
  }
}

/**
 * Creates a mock Grammy context for callback-query handlers.
 *
 * @param {{ chatId?: number, data?: string, from?: object }} opts
 */
export function createCallbackCtx({ chatId = 123, data = "", from = { id: 1 } } = {}) {
  const ctx = createMockCtx({ chatId, from })
  ctx.callbackQuery = { data }
  return ctx
}

/**
 * Creates a mock backend object compatible with the ClaudeBackend / KiloBackend interface.
 *
 * @param {{ supported?: boolean }} opts
 */
export function createMockBackend({ supported = true } = {}) {
  return {
    supported,
    sendMessageCalls: [],
    /** Override this to change what sendMessage returns (object or function returning object). */
    _sendResult: { text: "ok" },
    async sendMessage(args) {
      this.sendMessageCalls.push({ ...args })
      if (typeof this._sendResult === "function") return this._sendResult(args)
      return this._sendResult
    },
  }
}

/**
 * Creates an AsyncGenerator mock backend that yields typed events, mirroring
 * the Claude streaming backend interface.
 *
 * Event shapes (must match what claude.js actually yields):
 *   { type: "text",       text: string }
 *   { type: "result",     sessionId: string }
 *   { type: "permission", requestId: string, toolName: string, toolInput: string, toolInputRaw: object }
 *   { type: "question",   requestId: string, questions: Array }
 *   { type: "error",      message: string }
 *
 * @param {Array<object>} events - Sequence of events to yield.
 */
export function createMockGeneratorBackend(events) {
  return {
    name: "claude",
    supported: true,
    /** Tracks all calls to replyPermission — inspectable in tests. */
    replyPermissionCalls: [],
    replyPermission(requestId, behavior) {
      this.replyPermissionCalls.push({ requestId, behavior })
      return Promise.resolve()
    },
    async *sendMessage() {
      for (const event of events) yield event
    },
    createSession: async () => ({ id: "claude-mock-1" }),
    abortSession: async () => {},
    getSessionStatus: async () => null,
  }
}

/**
 * Creates a minimal mock Grammy bot that captures `on()` handlers.
 * Access captured handlers via `bot.handlers["event:name"]`.
 */
export function makeMockBot() {
  const handlers = {}
  return {
    on(event, handler) { handlers[event] = handler },
    handlers,
  }
}
