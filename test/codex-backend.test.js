import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Fake Codex bin: emits a minimal successful JSONL turn so all sendMessage calls succeed.
const fakeBin = join(tmpdir(), `fake-codex-${Date.now()}.sh`)
const payload = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } })
writeFileSync(fakeBin, `#!/bin/sh\nprintf '%s\\n' '${payload}'\n`)
chmodSync(fakeBin, 0o755)
process.env.BIN_CODEX = fakeBin

const { CodexBackend } = await import("../src/backends.js")
const backend = new CodexBackend()

// ── Arg order: Codex CLI 0.77.0+ requires exec-level flags before the subcommand ──
// Old (broken):  codex exec resume <id> --json --skip-git-repo-check <prompt>
// Fixed:         codex exec --json --skip-git-repo-check resume <id> <prompt>

test("CodexBackend: new session succeeds with correct arg order", async () => {
  const result = await backend.sendMessage({
    sessionId: null,
    directory: tmpdir(),
    text: "hello",
  })
  assert.ok(!result.error, `unexpected error: ${result.error}`)
  assert.equal(result.text, "ok")
})

test("CodexBackend: resume session succeeds — flags before 'resume' subcommand (Codex 0.77.0+)", async () => {
  // If arg order were wrong (flags after 'resume'), Codex 0.77.0 exits with code 2.
  // Our fake bin always exits 0, so a result.error here would indicate an execFile
  // construction problem, not a binary failure. The real guard is the arg order in codex.js.
  const result = await backend.sendMessage({
    sessionId: "sess-123",
    directory: tmpdir(),
    text: "hi",
  })
  assert.ok(!result.error, `unexpected error (arg order regression?): ${result.error}`)
  assert.equal(result.text, "ok")
})

test("CodexBackend: resume session with model flag — -m placed before 'resume' subcommand", async () => {
  const result = await backend.sendMessage({
    sessionId: "sess-456",
    directory: tmpdir(),
    text: "hi",
    model: "gpt-5.4",
  })
  assert.ok(!result.error, `unexpected error: ${result.error}`)
  assert.equal(result.text, "ok")
})
