import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

const { config } = await import("../src/config.js")
const { CodexBackend, CopilotBackend, registerBackend, getBackend, supportedClis } = await import("../src/backends.js")

/**
 * Write a temporary shell script that prints the given lines to stdout,
 * make it executable, and return its path.
 */
function makeFakeBin(lines) {
  const script = join(
    tmpdir(),
    `fake-bin-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
  )
  const output = lines.map((l) => `printf '%s\\n' '${l.replace(/'/g, "'\\''")}'`).join("\n")
  writeFileSync(script, `#!/bin/sh\n${output}\n`)
  chmodSync(script, 0o755)
  return script
}

// ── Backend registry ──

test("registerBackend registers a backend that getBackend can retrieve", () => {
  const fakeBackend = { name: "test-cli", supported: true }
  registerBackend(fakeBackend)
  assert.equal(getBackend("test-cli"), fakeBackend)
})

test("getBackend returns null for an unregistered CLI name", () => {
  assert.equal(getBackend("nonexistent-cli-xyz"), null)
})

test("supportedClis includes backends registered with supported=true", () => {
  registerBackend({ name: "supported-test", supported: true })
  const clis = supportedClis()
  assert.ok(clis.includes("supported-test"), "supported-test must appear in supported list")
})

test("supportedClis excludes backends registered with supported=false", () => {
  registerBackend({ name: "unsupported-test", supported: false })
  const clis = supportedClis()
  assert.ok(!clis.includes("unsupported-test"), "unsupported-test must not appear in supported list")
})

// ── CodexBackend parsing ──

test("CodexBackend parses JSONL output and extracts agent_message text", async () => {
  config.binCodex = makeFakeBin([
    '{"type":"thread.started","thread_id":"thread-abc"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Hello from codex"}}',
    '{"type":"turn.completed"}',
  ])

  const backend = new CodexBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.deepEqual(result, { text: "Hello from codex", threadId: "thread-abc" })
})

test("CodexBackend captures thread_id from a thread.started event", async () => {
  config.binCodex = makeFakeBin([
    '{"type":"thread.started","thread_id":"my-thread-123"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Response"}}',
  ])

  const backend = new CodexBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.equal(result.threadId, "my-thread-123")
})

test("CodexBackend concatenates multiple agent_message texts with double newlines", async () => {
  config.binCodex = makeFakeBin([
    '{"type":"item.completed","item":{"type":"agent_message","text":"Part 1"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Part 2"}}',
  ])

  const backend = new CodexBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.equal(result.text, "Part 1\n\nPart 2")
})

test("CodexBackend returns an error when a turn.failed event fires and there is no text", async () => {
  config.binCodex = makeFakeBin([
    '{"type":"turn.failed","error":{"message":"API quota exceeded"}}',
  ])

  const backend = new CodexBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.ok(result.error, "should return an error")
  assert.ok(result.error.includes("API quota exceeded"), "error must include the turn.failed message")
})

test("CodexBackend returns an error when no text is found in the output", async () => {
  config.binCodex = makeFakeBin(['{"type":"turn.completed"}'])

  const backend = new CodexBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.ok(result.error, "should return an error when output contains no text")
})

test("CodexBackend skips malformed JSONL lines without throwing", async () => {
  config.binCodex = makeFakeBin([
    "not-valid-json",
    '{"type":"item.completed","item":{"type":"agent_message","text":"Valid reply"}}',
  ])

  const backend = new CodexBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.equal(result.text, "Valid reply")
})

// ── CodexBackend session helpers ──

test("CodexBackend.createSession returns an id prefixed with 'codex-'", async () => {
  const backend = new CodexBackend()
  const result = await backend.createSession({ title: "test", directory: "/tmp" })
  assert.ok(result.id.startsWith("codex-"), "id should start with 'codex-'")
})

test("CodexBackend.abortSession resolves without error", async () => {
  const backend = new CodexBackend()
  await assert.doesNotReject(() => backend.abortSession("any-session"))
})

test("CodexBackend.getSessionStatus always returns null", async () => {
  const backend = new CodexBackend()
  const status = await backend.getSessionStatus("any-session")
  assert.equal(status, null)
})

// ── CopilotBackend parsing ──

test("CopilotBackend parses assistant.message events and captures sessionId from result", async () => {
  config.binCopilot = makeFakeBin([
    '{"type":"assistant.message","data":{"content":"Hello from copilot"}}',
    '{"type":"result","sessionId":"copilot-session-abc"}',
  ])

  const backend = new CopilotBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.deepEqual(result, { text: "Hello from copilot", threadId: "copilot-session-abc" })
})

test("CopilotBackend concatenates multiple assistant.message texts with double newlines", async () => {
  config.binCopilot = makeFakeBin([
    '{"type":"assistant.message","data":{"content":"First"}}',
    '{"type":"assistant.message","data":{"content":"Second"}}',
  ])

  const backend = new CopilotBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.equal(result.text, "First\n\nSecond")
})

test("CopilotBackend returns an error when assistant.turn_end has an error and no text", async () => {
  config.binCopilot = makeFakeBin([
    '{"type":"assistant.turn_end","data":{"error":"Context limit exceeded"}}',
  ])

  const backend = new CopilotBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.ok(result.error, "should return an error")
  assert.ok(result.error.includes("Context limit exceeded"), "error must include the turn_end error message")
})

test("CopilotBackend returns an error when an error event fires and no text was accumulated", async () => {
  config.binCopilot = makeFakeBin([
    '{"type":"error","data":{"message":"Something went wrong"}}',
  ])

  const backend = new CopilotBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.ok(result.error, "should return an error")
})

test("CopilotBackend returns an error when no text is produced", async () => {
  config.binCopilot = makeFakeBin(['{"type":"result"}'])

  const backend = new CopilotBackend()
  const result = await backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "hi" })

  assert.ok(result.error, "should return an error when output produces no text")
})

// ── CopilotBackend session helpers ──

test("CopilotBackend.createSession returns an id prefixed with 'copilot-'", async () => {
  const backend = new CopilotBackend()
  const result = await backend.createSession({ title: "test", directory: "/tmp" })
  assert.ok(result.id.startsWith("copilot-"), "id should start with 'copilot-'")
})

test("CopilotBackend.abortSession resolves without error", async () => {
  const backend = new CopilotBackend()
  await assert.doesNotReject(() => backend.abortSession("any-session"))
})

test("CopilotBackend.getSessionStatus always returns null", async () => {
  const backend = new CopilotBackend()
  const status = await backend.getSessionStatus("any-session")
  assert.equal(status, null)
})
