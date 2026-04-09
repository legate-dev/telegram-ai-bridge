import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Mock dependencies before importing telegram-utils ──

const mockDb = { binding: null, sessions: [] }
const mockConfig = {
  telegramAllowedUserId: "12345",
  defaultDirectory: process.cwd(),
  logLevel: "error",
}

await mock.module("../src/db.js", {
  namedExports: {
    getChatBinding: () => mockDb.binding,
    recentSessions: () => mockDb.sessions,
    getCliSessionById: () => null,
  },
})

await mock.module("../src/config.js", {
  namedExports: { config: mockConfig },
})

const capturedMessages = []
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

await mock.module("../src/log.js", {
  namedExports: {
    log: mockLog,
    redactString: (s) => (typeof s === "string" ? s.replace(/secret/gi, "<REDACTED>") : s),
  },
})

// Capture what replyChunks sends so tests can inspect the message text.
const { explainBackendFailure, replyChunks } = await import("../src/telegram-utils.js")

// ── Helpers ──

function makeCtx() {
  const replies = []
  return {
    replies,
    reply: async (text, _opts) => { replies.push(text) },
  }
}

// ── explainBackendFailure ──

test("explainBackendFailure sends 'unreachable' message on ECONNREFUSED", async () => {
  const ctx = makeCtx()
  const binding = { cli: "kilo", session_id: "sess-1", directory: "/tmp" }
  const error = new Error("connect ECONNREFUSED 127.0.0.1:4096")
  error.cause = { code: "ECONNREFUSED" }

  await explainBackendFailure(ctx, binding, error, undefined)

  assert.equal(ctx.replies.length, 1)
  assert.ok(
    ctx.replies[0].includes("unreachable"),
    `expected 'unreachable' in message, got: "${ctx.replies[0]}"`,
  )
})

test("explainBackendFailure uses binding.cli name in the ECONNREFUSED message", async () => {
  const ctx = makeCtx()
  const binding = { cli: "codex", session_id: "sess-1", directory: "/tmp" }
  const error = new Error("connect ECONNREFUSED")
  error.cause = { code: "ECONNREFUSED" }

  await explainBackendFailure(ctx, binding, error, undefined)

  assert.equal(ctx.replies.length, 1)
  assert.ok(ctx.replies[0].includes("codex"), "message should include the CLI name")
})

test("explainBackendFailure sends 'still processing' message when session is busy", async () => {
  const ctx = makeCtx()
  const binding = { cli: "kilo", session_id: "sess-busy", directory: "/tmp" }
  const error = new Error("submit failed")
  const fakeKilo = {
    getSessionStatus: async () => ({ type: "busy" }),
  }

  await explainBackendFailure(ctx, binding, error, fakeKilo)

  assert.equal(ctx.replies.length, 1)
  assert.ok(
    ctx.replies[0].toLowerCase().includes("processing") ||
    ctx.replies[0].toLowerCase().includes("busy"),
    `expected busy/processing message, got: "${ctx.replies[0]}"`,
  )
})

test("explainBackendFailure sends retry status detail when session is in retry state", async () => {
  const ctx = makeCtx()
  const binding = { cli: "kilo", session_id: "sess-retry", directory: "/tmp" }
  const error = new Error("submit failed")
  const fakeKilo = {
    getSessionStatus: async () => ({ type: "retry", message: "Kilo is retrying this request." }),
  }

  await explainBackendFailure(ctx, binding, error, fakeKilo)

  assert.equal(ctx.replies.length, 1)
  assert.ok(
    ctx.replies[0].includes("retrying") || ctx.replies[0].includes("Kilo"),
    `expected retry detail in message, got: "${ctx.replies[0]}"`,
  )
})

test("explainBackendFailure sends a generic error message when session status is null", async () => {
  const ctx = makeCtx()
  const binding = { cli: "kilo", session_id: "sess-generic", directory: "/tmp" }
  const error = new Error("request failed: 500 Internal Server Error")
  const fakeKilo = {
    getSessionStatus: async () => null,
  }

  await explainBackendFailure(ctx, binding, error, fakeKilo)

  assert.equal(ctx.replies.length, 1)
  assert.ok(
    ctx.replies[0].toLowerCase().includes("failed") ||
    ctx.replies[0].includes("request"),
    `expected generic error message, got: "${ctx.replies[0]}"`,
  )
})

test("explainBackendFailure sends a generic error message when kilo is undefined", async () => {
  const ctx = makeCtx()
  const binding = { cli: "kilo", session_id: "sess-no-kilo", directory: "/tmp" }
  const error = new Error("network error")

  // Pass undefined as kilo — no status check should be attempted
  await explainBackendFailure(ctx, binding, error, undefined)

  // Should either send an unreachable, busy, or generic error — but NOT throw
  assert.equal(ctx.replies.length, 1)
})

test("explainBackendFailure handles kilo.getSessionStatus throwing without propagating the error", async () => {
  const ctx = makeCtx()
  const binding = { cli: "kilo", session_id: "sess-throw", directory: "/tmp" }
  const error = new Error("original error")
  const fakeKilo = {
    getSessionStatus: async () => { throw new Error("status check failed") },
  }

  // Should not throw — status errors are swallowed
  await assert.doesNotReject(() => explainBackendFailure(ctx, binding, error, fakeKilo))
  assert.equal(ctx.replies.length, 1, "should still send a reply even when status check fails")
})

test("explainBackendFailure uses 'the backend' as cli name when binding is null", async () => {
  const ctx = makeCtx()
  const error = new Error("something failed")
  error.cause = { code: "ECONNREFUSED" }

  await explainBackendFailure(ctx, null, error, undefined)

  assert.equal(ctx.replies.length, 1)
  assert.ok(
    ctx.replies[0].includes("the backend") || ctx.replies[0].includes("unreachable"),
    `expected fallback cli name, got: "${ctx.replies[0]}"`,
  )
})
