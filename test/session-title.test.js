import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

const { generateSessionTitle } = await import("../src/session-title.js")

// ── generateSessionTitle ──

test("generateSessionTitle returns {basename} — {MonDD-HHmm} for a real directory", () => {
  const result = generateSessionTitle("/home/user/h-forge")
  assert.match(result, /^h-forge — [A-Z][a-z]{2}\d{2}-\d{4}$/)
})

test("generateSessionTitle uses session fallback for bridge cwd", () => {
  const result = generateSessionTitle(process.cwd())
  assert.match(result, /^session — [A-Z][a-z]{2}\d{2}-\d{4}$/)
})

test("generateSessionTitle uses session fallback for null/undefined directory", () => {
  const result = generateSessionTitle(null)
  assert.match(result, /^session — [A-Z][a-z]{2}\d{2}-\d{4}$/)
  const result2 = generateSessionTitle(undefined)
  assert.match(result2, /^session — [A-Z][a-z]{2}\d{2}-\d{4}$/)
})

test("generateSessionTitle uses basename of nested path", () => {
  const result = generateSessionTitle("/home/user/projects/telegram-ai-bridge")
  assert.match(result, /^telegram-ai-bridge — [A-Z][a-z]{2}\d{2}-\d{4}$/)
})

test("generateSessionTitle em dash separator is correct unicode", () => {
  const result = generateSessionTitle("/home/user/my-project")
  assert.ok(result.includes(" \u2014 "), "should use em dash (—)")
})

test("isBridgeSessionTitle is not exported because bridge ownership is not title-based", async () => {
  // Regression lock: bridge ownership is determined exclusively by the
  // deterministic source='bridge' flag on cli_sessions. Reintroducing a
  // title-based heuristic export would re-enable a class of false
  // positives this test is designed to prevent.
  const mod = await import("../src/session-title.js")
  assert.equal(
    mod.isBridgeSessionTitle,
    undefined,
    "isBridgeSessionTitle must NOT be exported from session-title.js",
  )
})
