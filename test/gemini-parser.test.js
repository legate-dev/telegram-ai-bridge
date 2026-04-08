import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Dynamic import so config picks up env vars set above
const { config } = await import("../src/config.js")
const { GeminiBackend } = await import("../src/backends.js")

/**
 * Write a small shell script to a temp file, make it executable, and return its path.
 * Each element of `lines` is passed to printf so special characters are safe.
 */
function makeFakeBin(lines) {
  const script = join(
    tmpdir(),
    `fake-gemini-parser-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
  )
  const output = lines.map((l) => `printf '%s\\n' '${l}'`).join("\n")
  writeFileSync(script, `#!/bin/sh\n${output}\n`)
  chmodSync(script, 0o755)
  return script
}

// ── Full JSON with `response` field ──

test("GeminiBackend parses full JSON with response field", async () => {
  config.binGemini = makeFakeBin(['{"response":"Hello from gemini","session_id":"sid-resp-1"}'])

  const backend = new GeminiBackend()
  const result = await backend.sendMessage({
    sessionId: null,
    directory: tmpdir(),
    text: "hello",
  })

  assert.deepEqual(result, { text: "Hello from gemini", threadId: "sid-resp-1" })
})

// ── Full JSON with `text` field + session_id capture ──

test("GeminiBackend parses full JSON with text field and captures session_id", async () => {
  config.binGemini = makeFakeBin(['{"text":"Hi there","session_id":"sid-text-42"}'])

  const backend = new GeminiBackend()
  const result = await backend.sendMessage({
    sessionId: null,
    directory: tmpdir(),
    text: "hello",
  })

  assert.deepEqual(result, { text: "Hi there", threadId: "sid-text-42" })
})

// ── JSONL line-by-line parse ──

test("GeminiBackend falls back to line-by-line JSONL parsing when full JSON parse fails", async () => {
  // Two separate JSON objects — concatenated they are NOT valid JSON, forcing line-by-line parse
  config.binGemini = makeFakeBin([
    '{"progress":"thinking"}',
    '{"response":"JSONL reply","session_id":"sid-jsonl-7"}',
  ])

  const backend = new GeminiBackend()
  const result = await backend.sendMessage({
    sessionId: null,
    directory: tmpdir(),
    text: "hello",
  })

  assert.deepEqual(result, { text: "JSONL reply", threadId: "sid-jsonl-7" })
})

// ── Raw stdout fallback ──

test("GeminiBackend falls back to raw stdout when no JSON can be parsed", async () => {
  config.binGemini = makeFakeBin(["This is plain text output"])

  const backend = new GeminiBackend()
  const result = await backend.sendMessage({
    sessionId: null,
    directory: tmpdir(),
    text: "hello",
  })

  assert.deepEqual(result, { text: "This is plain text output", threadId: null })
})
