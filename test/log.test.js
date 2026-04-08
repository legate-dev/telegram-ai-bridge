import test from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

const { redactString } = await import("../src/log.js")

// ── redactString ──

test("redactString redacts bot token in URL path", () => {
  const result = redactString("/bot123456:TESTTOKEN/sendMessage")
  assert.equal(result, "/bot<REDACTED>/sendMessage")
})

test("redactString redacts sk-* API keys", () => {
  const key = "sk-" + "a".repeat(24)
  const result = redactString(`Authorization: ${key}`)
  assert.equal(result, "Authorization: sk-<REDACTED>")
})

test("redactString redacts Basic auth header", () => {
  const result = redactString("Authorization: Basic dXNlcjpwYXNz")
  assert.equal(result, "Authorization: Basic <REDACTED>")
})

test("redactString redacts Basic auth in JSON string", () => {
  const result = redactString('"Authorization":"Basic dXNlcjpwYXNz"')
  assert.equal(result, '"Authorization":"Basic <REDACTED>"')
})

test("redactString redacts gh[pusro]_* GitHub tokens (unified pattern)", () => {
  const token = "ghp_" + "A".repeat(36)
  const result = redactString(`token=${token}`)
  // Unified pattern: all gh[pusro]_ variants collapse to a single placeholder
  assert.equal(result, "token=gh_<REDACTED>")
})

test("redactString redacts the configured bot token by exact match", () => {
  // config.telegramBotToken is "123456:TESTTOKEN" from the env var set above
  const result = redactString("token=123456:TESTTOKEN")
  assert.equal(result, "token=<REDACTED>")
})

test("redactString returns non-string values unchanged", () => {
  assert.equal(redactString(42), 42)
  assert.equal(redactString(null), null)
  assert.equal(redactString(undefined), undefined)
  assert.deepEqual(redactString({ key: "value" }), { key: "value" })
  assert.deepEqual(redactString([1, 2, 3]), [1, 2, 3])
})

test("redactString leaves clean strings unchanged", () => {
  const clean = "Hello, world! Nothing sensitive here."
  assert.equal(redactString(clean), clean)
})
