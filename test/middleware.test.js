import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Mutable mock state ──────────────────────────────────────────────────────

const mockRateLimit = {
  result: { allowed: true },
}

const mockLog = {
  warns: [],
  debugs: [],
  warn(...args) { this.warns.push(args) },
  debug(...args) { this.debugs.push(args) },
}

// ── Module mocks (must be set up before importing the middleware) ────────────

await mock.module("../src/rate-limit.js", {
  namedExports: {
    checkRateLimit: (userId) => mockRateLimit.result,
  },
})

await mock.module("../src/log.js", {
  namedExports: {
    log: mockLog,
  },
})

const { rateLimitMiddleware } = await import("../src/rate-limit-middleware.js")

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTextCtx({ userId = 1, text = "hello" } = {}) {
  return {
    from: { id: userId },
    message: { text },
    callbackQuery: undefined,
    replies: [],
    callbackAnswers: [],
    reply: async function (msg) { this.replies.push(msg) },
    answerCallbackQuery: async function (data) { this.callbackAnswers.push(data) },
  }
}

function makeCommandCtx({ userId = 1, text = "/start" } = {}) {
  const ctx = makeTextCtx({ userId, text })
  // Real Telegram bot commands have a bot_command entity at offset 0.
  ctx.message.entities = [{ type: "bot_command", offset: 0, length: text.indexOf(" ") > 0 ? text.indexOf(" ") : text.length }]
  return ctx
}

function makeCallbackCtx({ userId = 1, data = "bind:abc" } = {}) {
  return {
    from: { id: userId },
    message: undefined,
    callbackQuery: { data },
    replies: [],
    callbackAnswers: [],
    reply: async function (msg) { this.replies.push(msg) },
    answerCallbackQuery: async function (data) { this.callbackAnswers.push(data) },
  }
}

function makeNoFromCtx() {
  return {
    from: undefined,
    message: { text: "channel post" },
    callbackQuery: undefined,
    replies: [],
    callbackAnswers: [],
    reply: async function (msg) { this.replies.push(msg) },
    answerCallbackQuery: async function (data) { this.callbackAnswers.push(data) },
  }
}

function resetMocks() {
  mockRateLimit.result = { allowed: true }
  mockLog.warns = []
  mockLog.debugs = []
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("middleware allows text message when user is under the limit", async () => {
  resetMocks()
  mockRateLimit.result = { allowed: true }

  const ctx = makeTextCtx()
  let nextCalled = false
  await rateLimitMiddleware(ctx, () => { nextCalled = true })

  assert.ok(nextCalled, "next() should be called when allowed")
  assert.equal(ctx.replies.length, 0)
  assert.equal(ctx.callbackAnswers.length, 0)
})

test("middleware passes plain text through to next() even when user is over the limit", async () => {
  resetMocks()
  mockRateLimit.result = { allowed: false, retryAfterMs: 5000 }

  const ctx = makeTextCtx({ text: "hello" })
  let nextCalled = false
  await rateLimitMiddleware(ctx, () => { nextCalled = true })

  assert.ok(nextCalled, "next() should be called for plain text — rate-limit is enforced after coalescing")
  assert.equal(ctx.replies.length, 0, "middleware must not reply for plain text messages")
  assert.equal(ctx.callbackAnswers.length, 0)
})

test("middleware blocks slash command when user is over the limit", async () => {
  resetMocks()
  mockRateLimit.result = { allowed: false, retryAfterMs: 10000 }

  const ctx = makeCommandCtx({ text: "/cleanup" })
  let nextCalled = false
  await rateLimitMiddleware(ctx, () => { nextCalled = true })

  assert.ok(!nextCalled, "next() should NOT be called for blocked command")
  assert.equal(ctx.replies.length, 1)
  assert.ok(ctx.replies[0].includes("Rate limit exceeded"))
  assert.ok(ctx.replies[0].includes("10s"))
})

test("middleware blocks callback query when user is over the limit and uses answerCallbackQuery", async () => {
  resetMocks()
  mockRateLimit.result = { allowed: false, retryAfterMs: 3000 }

  const ctx = makeCallbackCtx({ data: "bind:some-session" })
  let nextCalled = false
  await rateLimitMiddleware(ctx, () => { nextCalled = true })

  assert.ok(!nextCalled, "next() should NOT be called for blocked callback")
  assert.equal(ctx.callbackAnswers.length, 1, "answerCallbackQuery should be called")
  assert.equal(ctx.callbackAnswers[0].show_alert, true)
  assert.ok(ctx.callbackAnswers[0].text.includes("Rate limit exceeded"))
  assert.ok(ctx.callbackAnswers[0].text.includes("3s"))
  assert.equal(ctx.replies.length, 0, "ctx.reply should NOT be called for callback queries")
})

test("middleware passes through updates with no ctx.from without consuming a bucket", async () => {
  resetMocks()
  // If rate limit were checked, the mock is set to block — but it shouldn't be called
  mockRateLimit.result = { allowed: false, retryAfterMs: 999 }

  const ctx = makeNoFromCtx()
  let nextCalled = false
  await rateLimitMiddleware(ctx, () => { nextCalled = true })

  assert.ok(nextCalled, "next() should be called for updates with no ctx.from")
  assert.equal(ctx.replies.length, 0)
})

test("middleware does not log a warn and does not consume a slot for plain text messages", async () => {
  resetMocks()
  mockRateLimit.result = { allowed: false, retryAfterMs: 7500 }

  const ctx = makeTextCtx({ userId: 42, text: "hello" })
  let nextCalled = false
  await rateLimitMiddleware(ctx, () => { nextCalled = true })

  assert.ok(nextCalled, "next() must be called — rate-limit for text is deferred to processTextMessage")
  assert.equal(mockLog.warns.length, 0, "no warn should be logged in middleware for plain text")
})

test("middleware logs a warn with kind=command when blocking a slash command", async () => {
  resetMocks()
  mockRateLimit.result = { allowed: false, retryAfterMs: 2000 }

  const ctx = makeCommandCtx({ userId: 99, text: "/sessions" })
  await rateLimitMiddleware(ctx, () => {})

  assert.equal(mockLog.warns.length, 1)
  const [, , meta] = mockLog.warns[0]
  assert.equal(meta.kind, "command")
})

test("middleware logs a warn with kind=callback when blocking a callback query", async () => {
  resetMocks()
  mockRateLimit.result = { allowed: false, retryAfterMs: 1500 }

  const ctx = makeCallbackCtx({ userId: 55 })
  await rateLimitMiddleware(ctx, () => {})

  assert.equal(mockLog.warns.length, 1)
  const [, , meta] = mockLog.warns[0]
  assert.equal(meta.kind, "callback")
})

test("middleware logs debug and does not throw when answerCallbackQuery fails", async () => {
  resetMocks()
  mockRateLimit.result = { allowed: false, retryAfterMs: 1000 }

  const ctx = makeCallbackCtx()
  ctx.answerCallbackQuery = async () => { throw new Error("stale message") }

  let nextCalled = false
  // Should not throw
  await rateLimitMiddleware(ctx, () => { nextCalled = true })

  assert.ok(!nextCalled)
  assert.ok(mockLog.debugs.length >= 1, "debug should be logged on answerCallbackQuery failure")
})

test("middleware logs debug and does not throw when ctx.reply fails for a command", async () => {
  resetMocks()
  mockRateLimit.result = { allowed: false, retryAfterMs: 1000 }

  const ctx = makeCommandCtx({ text: "/start" })
  ctx.reply = async () => { throw new Error("message too long") }

  let nextCalled = false
  // Should not throw
  await rateLimitMiddleware(ctx, () => { nextCalled = true })

  assert.ok(!nextCalled)
  assert.ok(mockLog.debugs.length >= 1, "debug should be logged on reply failure")
})

test("middleware uses at least 1 second for retrySec even if retryAfterMs is tiny", async () => {
  resetMocks()
  mockRateLimit.result = { allowed: false, retryAfterMs: 50 }

  const ctx = makeCommandCtx({ text: "/start" })
  await rateLimitMiddleware(ctx, () => {})

  assert.equal(ctx.replies.length, 1)
  assert.ok(ctx.replies[0].includes("1s"), "should report at least 1s retry time")
  // Raw retryAfterMs should still be logged as-is (not clamped)
  assert.equal(mockLog.warns.length, 1)
  assert.equal(mockLog.warns[0][2].retry_after_ms, 50)
})
