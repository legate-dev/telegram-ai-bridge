import test from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

const { extractAssistantText, extractMessageError, formatForTelegram, chunkText } =
  await import("../src/format.js")

// ── extractAssistantText ──

test("extractAssistantText extracts text parts and joins them", () => {
  const msg = {
    parts: [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ],
  }
  assert.equal(extractAssistantText(msg), "Hello\n\nWorld")
})

test("extractAssistantText returns empty string for non-text parts", () => {
  const msg = {
    parts: [{ type: "tool", tool: "task", state: { status: "completed" } }],
  }
  assert.equal(extractAssistantText(msg), "")
})

test("extractAssistantText returns empty string for null message", () => {
  assert.equal(extractAssistantText(null), "")
})

test("extractAssistantText skips parts with no text", () => {
  const msg = {
    parts: [
      { type: "text", text: "" },
      { type: "text", text: "  " },
      { type: "text", text: "Kept" },
    ],
  }
  assert.equal(extractAssistantText(msg), "Kept")
})

// ── extractMessageError ──

test("extractMessageError extracts error name and message", () => {
  const msg = {
    info: { error: { name: "APIError", message: "Something went wrong" } },
  }
  assert.equal(extractMessageError(msg), "APIError: Something went wrong")
})

test("extractMessageError uses data.message when present", () => {
  const msg = {
    info: { error: { name: "NetworkError", data: { message: "Connection refused" } } },
  }
  assert.equal(extractMessageError(msg), "NetworkError: Connection refused")
})

test("extractMessageError returns null when no error", () => {
  const msg = { info: {} }
  assert.equal(extractMessageError(msg), null)
})

test("extractMessageError returns null for null message", () => {
  assert.equal(extractMessageError(null), null)
})

// ── formatForTelegram ──

test("formatForTelegram escapes special characters outside code blocks", () => {
  const result = formatForTelegram("Hello _world_")
  assert.equal(result, "Hello \\_world\\_")
})

test("formatForTelegram preserves inline code blocks verbatim", () => {
  const result = formatForTelegram("Use `npm install` to install")
  assert.equal(result, "Use `npm install` to install")
})

test("formatForTelegram preserves fenced code blocks verbatim", () => {
  const input = "Run this:\n```bash\necho hello\n```\nDone."
  const result = formatForTelegram(input)
  assert.ok(result.includes("```bash\necho hello\n```"), "fenced block should be preserved")
  assert.ok(result.includes("Done\\."), "text after block should be escaped")
})

test("formatForTelegram returns empty string for empty input", () => {
  assert.equal(formatForTelegram(""), "")
  assert.equal(formatForTelegram(null), "")
})

// ── chunkText ──

test("chunkText returns a single chunk for short text", () => {
  const result = chunkText("Hello, world!")
  assert.deepEqual(result, ["Hello, world!"])
})

test("chunkText splits text that exceeds the limit", () => {
  const long = "word ".repeat(1000) // ~5000 chars
  const chunks = chunkText(long)
  assert.ok(chunks.length > 1, "should produce multiple chunks")
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4000, `chunk too long: ${chunk.length}`)
  }
})

test("chunkText prefers splitting at code block boundaries", () => {
  // Build input with a closing ``` just before the 4000-char limit, then extra content.
  // The algorithm finds the last \n``` before the limit and splits there, so the
  // second chunk should start with the closing fence (```).
  const prefix = "x".repeat(3850)
  const code = "\n```\ncode content\n```\n"
  const suffix = "y".repeat(300)
  const input = prefix + code + suffix // total > 4000

  const chunks = chunkText(input)
  assert.ok(chunks.length >= 2, "should produce multiple chunks")
  // The split preferring the fence means chunk[1] begins with the ``` fence line
  assert.ok(chunks[1].startsWith("```"), "second chunk should start at the code fence boundary")
})
