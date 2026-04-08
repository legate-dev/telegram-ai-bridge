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

test("GeminiBackend passes stdio: ['ignore','pipe','pipe'] to execFile", async () => {
  capturedOptions = null
  const backend = new GeminiBackend()
  await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(capturedOptions !== null, "execFile should have been called")
  assert.deepEqual(capturedOptions.stdio, ["ignore", "pipe", "pipe"])
})

test("ClaudeBackend passes stdio: ['ignore','pipe','pipe'] to execFile", async () => {
  capturedOptions = null
  const backend = new ClaudeBackend()
  await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(capturedOptions !== null, "execFile should have been called")
  assert.deepEqual(capturedOptions.stdio, ["ignore", "pipe", "pipe"])
})
