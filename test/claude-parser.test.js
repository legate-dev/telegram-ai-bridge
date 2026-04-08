import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Dynamic import so config picks up env vars set above
const { config } = await import("../src/config.js")
const { ClaudeBackend } = await import("../src/backends.js")

/**
 * Write a small shell script to a temp file, make it executable, and return its path.
 * `lines` is an array of raw strings — each is echoed as a single line of stdout.
 */
function makeFakeBin(lines) {
  const script = join(
    tmpdir(),
    `fake-claude-parser-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
  )
  // Use printf with %s to avoid shell interpretation of the JSON content
  const output = lines.map((l) => `printf '%s\\n' '${l.replace(/'/g, "'\\''")}'`).join("\n")
  writeFileSync(script, `#!/bin/sh\n${output}\n`)
  chmodSync(script, 0o755)
  return script
}

// ── JSON array with system + assistant + result events ──

test("ClaudeBackend parses JSON array with system, assistant and result events", async () => {
  const events = JSON.stringify([
    { type: "system", session_id: "sid-claude-1" },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello from claude" }] },
    },
    { type: "result", session_id: "sid-claude-1", result: "done", is_error: false },
  ])

  config.binClaude = makeFakeBin([events])

  const backend = new ClaudeBackend()
  const result = await backend.sendMessage({
    sessionId: null,
    directory: tmpdir(),
    text: "hi",
  })

  assert.deepEqual(result, { text: "Hello from claude", threadId: "sid-claude-1" })
})

// ── Result event with is_error ──

test("ClaudeBackend surfaces is_error result and clears assistant text", async () => {
  const events = JSON.stringify([
    { type: "system", session_id: "sid-claude-err" },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Partial response" }] },
    },
    {
      type: "result",
      session_id: "sid-claude-err",
      is_error: true,
      result: "Tool execution failed",
    },
  ])

  config.binClaude = makeFakeBin([events])

  const backend = new ClaudeBackend()
  const result = await backend.sendMessage({
    sessionId: null,
    directory: tmpdir(),
    text: "hi",
  })

  assert.deepEqual(result, { text: "Error: Tool execution failed", threadId: "sid-claude-err" })
})

// ── JSONL fallback ──

test("ClaudeBackend falls back to JSONL parsing when full JSON parse fails", async () => {
  // Output individual JSON objects on separate lines (not wrapped in an array),
  // so the full-parse step fails and line-by-line parsing takes over.
  config.binClaude = makeFakeBin([
    '{"type":"system","session_id":"sid-jsonl-claude"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"JSONL reply"}]}}',
    '{"type":"result","session_id":"sid-jsonl-claude","result":"ok","is_error":false}',
  ])

  const backend = new ClaudeBackend()
  const result = await backend.sendMessage({
    sessionId: null,
    directory: tmpdir(),
    text: "hi",
  })

  assert.deepEqual(result, { text: "JSONL reply", threadId: "sid-jsonl-claude" })
})

test("ClaudeBackend returns a clear error when the bound workspace no longer exists", async () => {
  config.binClaude = makeFakeBin([
    '{"type":"result","session_id":"sid-jsonl-claude","result":"should not run","is_error":false}',
  ])

  const missingDir = join(
    mkdtempSync(join(tmpdir(), "claude-missing-cwd-")),
    "deleted-workspace",
  )
  rmSync(join(missingDir, ".."), { recursive: true, force: true })

  const backend = new ClaudeBackend()
  const result = await backend.sendMessage({
    sessionId: null,
    directory: missingDir,
    text: "hi",
  })

  assert.equal(
    result.error,
    `Workspace path is missing for claude: ${missingDir} (ENOENT). Bind a live session in an existing repo or create a new one with /new.`,
  )
})

test("ClaudeBackend returns a clear error when the bound workspace path is a file", async () => {
  config.binClaude = makeFakeBin([
    '{"type":"result","session_id":"sid-jsonl-claude","result":"should not run","is_error":false}',
  ])

  const filePath = join(tmpdir(), `claude-not-a-directory-${Date.now()}.txt`)
  writeFileSync(filePath, "not a directory\n")

  const backend = new ClaudeBackend()
  const result = await backend.sendMessage({
    sessionId: null,
    directory: filePath,
    text: "hi",
  })

  assert.equal(
    result.error,
    `Workspace path is missing or not a directory for claude: ${filePath}. Bind a live session in an existing repo or create a new one with /new.`,
  )
  rmSync(filePath, { force: true })
})
