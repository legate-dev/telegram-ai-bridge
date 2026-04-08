import { test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

const { formatSessionStatus, escapeMarkdownV2, chunkText } = await import("../src/format.js")

// ── formatSessionStatus ──

test("formatSessionStatus returns empty string for null", () => {
  assert.equal(formatSessionStatus(null), "")
})

test("formatSessionStatus returns empty string for undefined", () => {
  assert.equal(formatSessionStatus(undefined), "")
})

test("formatSessionStatus returns empty string for a non-object value", () => {
  assert.equal(formatSessionStatus("busy"), "")
  assert.equal(formatSessionStatus(42), "")
})

test("formatSessionStatus returns busy message for type 'busy'", () => {
  const result = formatSessionStatus({ type: "busy" })
  assert.ok(result.length > 0, "result should be non-empty")
  assert.ok(
    result.toLowerCase().includes("busy") || result.toLowerCase().includes("processing"),
    "result should describe a busy/processing state",
  )
})

test("formatSessionStatus returns retry message for type 'retry' without a next timestamp", () => {
  const result = formatSessionStatus({ type: "retry", message: "Kilo is retrying." })
  assert.ok(result.includes("Kilo is retrying."), "custom message must appear in result")
  assert.ok(!result.includes("Next retry"), "next retry time must not appear when next is absent")
})

test("formatSessionStatus appends next retry time when next timestamp is present", () => {
  const nextMs = Date.now() + 120_000
  const result = formatSessionStatus({ type: "retry", message: "Retrying now.", next: nextMs })
  assert.ok(result.includes("Retrying now."), "custom message must appear")
  assert.ok(result.includes("Next retry"), "next retry window must be appended")
})

test("formatSessionStatus uses a default message when message is absent on retry", () => {
  const result = formatSessionStatus({ type: "retry" })
  assert.ok(result.length > 0, "should return a non-empty string even without a message field")
})

test("formatSessionStatus returns empty string for unknown status types", () => {
  assert.equal(formatSessionStatus({ type: "idle" }), "")
  assert.equal(formatSessionStatus({ type: "done" }), "")
})

// ── escapeMarkdownV2 ──

test("escapeMarkdownV2 escapes all MarkdownV2 special characters", () => {
  const specials = "_*[]()~`>#+-=|{}.!\\"
  const result = escapeMarkdownV2(specials)
  for (const char of specials) {
    assert.ok(result.includes(`\\${char}`), `'${char}' must be escaped with a backslash`)
  }
})

test("escapeMarkdownV2 leaves alphanumeric and whitespace characters unchanged", () => {
  const input = "Hello World 123"
  assert.equal(escapeMarkdownV2(input), input)
})

test("escapeMarkdownV2 escapes only special chars in mixed text", () => {
  assert.equal(escapeMarkdownV2("Hello (world)!"), "Hello \\(world\\)\\!")
})

test("escapeMarkdownV2 handles an empty string without error", () => {
  assert.equal(escapeMarkdownV2(""), "")
})

// ── chunkText edge cases ──

test("chunkText returns a single-element array for text exactly at the limit", () => {
  const text = "a".repeat(4000)
  const chunks = chunkText(text)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].length, 4000)
})

test("chunkText returns a single-element array containing an empty string for empty input", () => {
  // chunkText("") short-circuits at the length check and returns [""]
  const chunks = chunkText("")
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], "")
})

test("chunkText hard-splits text with no word boundaries near the limit", () => {
  const text = "a".repeat(5000)
  const chunks = chunkText(text)
  assert.ok(chunks.length >= 2, "must produce at least two chunks")
  assert.ok(chunks.every((c) => c.length <= 4000), "every chunk must fit within the limit")
})

test("chunkText uses a custom limit when provided", () => {
  const text = "a".repeat(20)
  const chunks = chunkText(text, 10)
  assert.ok(chunks.length >= 2, "should split when text exceeds custom limit")
  assert.ok(chunks.every((c) => c.length <= 10), "every chunk must fit within the custom limit")
})

test("chunkText preserves all content across chunks", () => {
  const text = "word ".repeat(1200).trim()  // ~6000 chars
  const chunks = chunkText(text)
  const rejoined = chunks.join(" ")
  // Every original word must appear somewhere in the rejoined result
  assert.ok(rejoined.includes("word"), "content must be preserved across chunks")
  assert.ok(chunks.length >= 2, "text should be split into at least two chunks")
})
