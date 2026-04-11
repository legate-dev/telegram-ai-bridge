import { mock, test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Captured state ──

let capturedOptions = null

await mock.module("node:child_process", {
  namedExports: {
    execFile: (_file, _args, options, callback) => {
      capturedOptions = options
      setImmediate(() => callback(null, JSON.stringify({ text: "ok", session_id: "s1" }), ""))
      return { pid: 12345 }
    },
    execFileSync: () => "",
    // ClaudeBackend uses spawn (not execFile) — provide a no-op so the import succeeds
    spawn: () => ({ stdin: { write: () => {}, end: () => {} }, stdout: { on: () => {} }, stderr: { on: () => {} }, kill: () => {}, killed: false }),
  },
})

await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    redactString: (s) => s,
  },
})

await mock.module("../src/db.js", {
  namedExports: {
    sessionCountsByCli: () => [],
    getLmStudioResponseId: () => null,
    setLmStudioResponseId: () => {},
  },
})

await mock.module("../src/config.js", {
  namedExports: {
    config: {
      binCodex: "codex",
      binCopilot: "copilot",
      binGemini: "gemini",
      binClaude: "claude",
      codexTimeoutMs: 10000,
      copilotTimeoutMs: 10000,
      geminiTimeoutMs: 10000,
      claudeTimeoutMs: 10000,
      copilotAllowAllTools: false,
      geminiModel: null,
      claudePermissionMode: "bypassPermissions",
    },
  },
})

const { CodexBackend, CopilotBackend, GeminiBackend, ClaudeBackend } = await import("../src/backends.js")

// ── Tests ──

test("CodexBackend passes stdio: ['ignore','pipe','pipe'] to execFile", async () => {
  capturedOptions = null
  const backend = new CodexBackend()
  await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(capturedOptions !== null, "execFile should have been called")
  assert.deepEqual(capturedOptions.stdio, ["ignore", "pipe", "pipe"])
})

test("CopilotBackend passes stdio: ['ignore','pipe','pipe'] to execFile", async () => {
  capturedOptions = null
  const backend = new CopilotBackend()
  await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(capturedOptions !== null, "execFile should have been called")
  assert.deepEqual(capturedOptions.stdio, ["ignore", "pipe", "pipe"])
})

// GeminiBackend now uses spawn (not execFile) with stdio: ["ignore","pipe","pipe"].
// Spawn-level behavior is covered by integration tests in gemini-parser.test.js.

// ClaudeBackend now uses spawn (not execFile) with stdio: ["pipe","pipe","pipe"].
// Spawn-level behavior is covered by integration tests in claude-parser.test.js.
