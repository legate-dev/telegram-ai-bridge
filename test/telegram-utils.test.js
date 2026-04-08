import test from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

const { replyChunks } = await import("../src/telegram-utils.js")

// Build a fake ctx that records what was sent
function makeCtx({ failOnMarkdownAt = null } = {}) {
  const sent = []
  let callCount = 0
  return {
    sent,
    reply(text, options) {
      const index = callCount++
      if (
        failOnMarkdownAt !== null &&
        index === failOnMarkdownAt &&
        options?.parse_mode === "MarkdownV2"
      ) {
        return Promise.reject({ description: "Bad Request: can't parse entities" })
      }
      sent.push({ text, options: options ?? null })
      return Promise.resolve()
    },
  }
}

test("replyChunks: short response with markdown succeeds — no fallback", async () => {
  const ctx = makeCtx()
  await replyChunks(ctx, "Hello world")
  assert.equal(ctx.sent.length, 1)
  assert.equal(ctx.sent[0].options?.parse_mode, "MarkdownV2")
})

test("replyChunks: 6000-char response, markdown fails on chunk 2 of 3 — all text delivered once", async () => {
  // Build 3 logical sections separated by newlines so chunkText can split cleanly.
  // Use plain ASCII so formatted == plain (no extra escaping).
  const part1 = "a".repeat(4000)
  const part2 = "b".repeat(4000)
  const part3 = "c".repeat(1000)
  const text = part1 + "\n" + part2 + "\n" + part3

  // Markdown fails on the 3rd plain chunk (index 2)
  const ctx = makeCtx({ failOnMarkdownAt: 2 })
  await replyChunks(ctx, text)

  const markdownSent = ctx.sent.filter((s) => s.options?.parse_mode === "MarkdownV2")
  const plainSent = ctx.sent.filter((s) => s.options === null)

  assert.equal(markdownSent.length, 2, "first two chunks sent as markdown")
  assert.ok(plainSent.length >= 1, "at least one plain chunk sent for remainder")

  // All sent text joined should equal the original (newlines consumed by trim in chunkText)
  // Since plain ASCII has no special chars, formatted == plain, so we can join directly.
  const allSentText = ctx.sent.map((s) => s.text).join("")
  assert.equal(allSentText.replace(/\n/g, ""), text.replace(/\n/g, ""))
})

test("replyChunks: response with literal backslashes outside code blocks — no duplication", async () => {
  // Literal backslashes get escaped in MarkdownV2 but not in the plain fallback.
  // The unescaping step must count original chars correctly so we don't skip/repeat text.
  const text = "Result: C:\\Users\\foo\\bar is the path"
  const ctx = makeCtx({ failOnMarkdownAt: 0 })
  await replyChunks(ctx, text)

  // No markdown chunk was delivered (the only call failed)
  const markdownSent = ctx.sent.filter((s) => s.options?.parse_mode === "MarkdownV2")
  assert.equal(markdownSent.length, 0)

  // Entire original text sent as plain with no modification
  const plainSent = ctx.sent.filter((s) => s.options === null)
  assert.equal(plainSent.length, 1)
  assert.equal(plainSent[0].text, text)
})

test("replyChunks: markdown fails on chunk 0 — full text re-sent as plain (no duplication)", async () => {
  const text = "Full message that fails markdown"
  const ctx = makeCtx({ failOnMarkdownAt: 0 })
  await replyChunks(ctx, text)

  // Nothing delivered as MarkdownV2
  const markdownSent = ctx.sent.filter((s) => s.options?.parse_mode === "MarkdownV2")
  assert.equal(markdownSent.length, 0, "no markdown chunks delivered")

  // Entire text sent as plain
  const plainSent = ctx.sent.filter((s) => s.options === null)
  assert.equal(plainSent.length, 1)
  assert.equal(plainSent[0].text, text)
})

test("replyChunks: heavily escaped text — markdown fail delivers all text exactly once", async () => {
  // 3000 '!' characters: each '!' is escaped to '\!' in MarkdownV2.
  // With chunk-then-format the plain chunk is "!"*3000 and its formatted version
  // is "\!"*3000. If that formatted version fails, the same plain chunk is re-sent.
  const text = "!".repeat(3000)

  // Fail on the first (and only) formatted chunk
  const ctx = makeCtx({ failOnMarkdownAt: 0 })
  await replyChunks(ctx, text)

  const markdownSent = ctx.sent.filter((s) => s.options?.parse_mode === "MarkdownV2")
  const plainSent = ctx.sent.filter((s) => s.options === null)

  assert.equal(markdownSent.length, 0, "no markdown chunks delivered")
  assert.equal(plainSent.length, 1, "plain fallback sends the single chunk")
  assert.equal(plainSent[0].text, text, "plain chunk equals original text exactly")
})

