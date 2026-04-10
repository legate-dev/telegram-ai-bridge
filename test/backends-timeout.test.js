import { mock, test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Simulated timeout error ──

const timeoutError = Object.assign(new Error("Command timed out"), {
  killed: true,
  signal: "SIGTERM",
  code: null,
})

// ── Partial JSONL payloads — one valid event per backend ──

const codexPartialStdout = '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\n'
const copilotPartialStdout = '{"type":"assistant.message","data":{"content":"partial"}}\n'
const geminiPartialStdout = '{"text":"partial","session_id":"sid-1"}\n'
const claudePartialStdout = '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n'

// ── Mock execFile factory ──

let mockExecFileFn = null

await mock.module("node:child_process", {
  namedExports: {
    execFile: (_file, _args, _options, callback) => {
      if (mockExecFileFn) mockExecFileFn(callback)
      return { pid: 99999 }
    },
    execFileSync: () => "",
    // ClaudeBackend uses spawn — provide a no-op so the import succeeds
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

// ── Codex timeout tests ──

test("CodexBackend returns error when killed with partial stdout", async () => {
  mockExecFileFn = (cb) => setImmediate(() => cb(timeoutError, codexPartialStdout, ""))
  const backend = new CodexBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(result.error, "should return an error object")
  assert.ok(/timed out or was killed/i.test(result.error), `error should mention 'timed out or was killed', got: ${result.error}`)
  assert.ok(/Codex/i.test(result.error), `error should mention backend name 'Codex', got: ${result.error}`)
  assert.ok(!result.text, "should not return text from partial stdout")
})

test("CodexBackend error message includes signal when killed", async () => {
  mockExecFileFn = (cb) => setImmediate(() => cb(timeoutError, codexPartialStdout, ""))
  const backend = new CodexBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(result.error.includes("SIGTERM"), `error should include signal name, got: ${result.error}`)
})

// ── Copilot timeout tests ──

test("CopilotBackend returns error when killed with partial stdout", async () => {
  mockExecFileFn = (cb) => setImmediate(() => cb(timeoutError, copilotPartialStdout, ""))
  const backend = new CopilotBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(result.error, "should return an error object")
  assert.ok(/timed out or was killed/i.test(result.error), `error should mention 'timed out or was killed', got: ${result.error}`)
  assert.ok(/Copilot/i.test(result.error), `error should mention backend name 'Copilot', got: ${result.error}`)
  assert.ok(!result.text, "should not return text from partial stdout")
})

test("CopilotBackend error message includes signal when killed", async () => {
  mockExecFileFn = (cb) => setImmediate(() => cb(timeoutError, copilotPartialStdout, ""))
  const backend = new CopilotBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(result.error.includes("SIGTERM"), `error should include signal name, got: ${result.error}`)
})

// ── Gemini timeout tests ──

test("GeminiBackend returns error when killed with partial stdout", async () => {
  mockExecFileFn = (cb) => setImmediate(() => cb(timeoutError, geminiPartialStdout, ""))
  const backend = new GeminiBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(result.error, "should return an error object")
  assert.ok(/timed out or was killed/i.test(result.error), `error should mention 'timed out or was killed', got: ${result.error}`)
  assert.ok(/Gemini/i.test(result.error), `error should mention backend name 'Gemini', got: ${result.error}`)
  assert.ok(!result.text, "should not return text from partial stdout")
})

test("GeminiBackend error message includes signal when killed", async () => {
  mockExecFileFn = (cb) => setImmediate(() => cb(timeoutError, geminiPartialStdout, ""))
  const backend = new GeminiBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(result.error.includes("SIGTERM"), `error should include signal name, got: ${result.error}`)
})

test("GeminiBackend does not report quota error when killed (timeout takes priority)", async () => {
  mockExecFileFn = (cb) => setImmediate(() => cb(timeoutError, geminiPartialStdout, "exhausted your capacity"))
  const backend = new GeminiBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(/timed out or was killed/i.test(result.error), `killed error should take priority over quota error, got: ${result.error}`)
})

// ClaudeBackend now uses spawn + setTimeout-based timeout (not execFile).
// Timeout behavior is covered in claude-parser.test.js using real shell scripts.
