import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

function makeFakeBin(lines) {
  const script = join(tmpdir(), `fake-gemini-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
  const output = lines.map((l) => `printf '%s\\n' '${l}'`).join("\n")
  writeFileSync(script, `#!/bin/sh\n${output}\n`)
  chmodSync(script, 0o755)
  return script
}

test("GeminiBackend captures session_id from text-field format (line-by-line parse)", async () => {
  // Two-line NDJSON causes the single-object parse to fail, exercising the line-by-line branch.
  // The text-field line must carry session_id through that branch.
  const fakeBin = makeFakeBin([
    '{"progress":"thinking"}',
    '{"text":"Hello from gemini","session_id":"sid-text-123"}',
  ])
  process.env.BIN_GEMINI = fakeBin

  const { GeminiBackend } = await import("../src/backends.js")
  const backend = new GeminiBackend()
  const result = await backend.sendMessage({
    sessionId: null,
    directory: tmpdir(),
    text: "hello",
  })

  assert.deepEqual(result, { text: "Hello from gemini", threadId: "sid-text-123" })
})
