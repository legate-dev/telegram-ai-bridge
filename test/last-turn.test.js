import { mock, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Fixture root ──

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "last-turn-test-"))

process.on("exit", () => {
  try { fs.rmSync(tmpDir, { recursive: true }) } catch {}
})

const claudeBase = path.join(tmpDir, "claude")
const homeEncoded = os.homedir().split("/").filter(Boolean).join("-")
const claudeFolder = "-" + homeEncoded + "-myproject"
const claudeFolderPath = path.join(claudeBase, claudeFolder)
fs.mkdirSync(claudeFolderPath, { recursive: true })

const copilotBase = path.join(tmpDir, "copilot")
fs.mkdirSync(copilotBase, { recursive: true })

const geminiBase = path.join(tmpDir, "gemini")
fs.mkdirSync(geminiBase, { recursive: true })

// ── Mock dependencies before importing last-turn ──

await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  },
})

const mockConfig = {
  scanPathClaude: claudeBase,
  scanPathCopilot: copilotBase,
  scanPathGemini: geminiBase,
  kiloStatusTimeoutMs: 5000,
}

await mock.module("../src/config.js", {
  namedExports: { config: mockConfig },
})

const { readLastTurn } = await import("../src/last-turn.js")

// ── Helpers ──

function writeFixture(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf8")
}

function claudeFile(sessionId) {
  return path.join(claudeFolderPath, `${sessionId}.jsonl`)
}

function copilotFile(sessionId) {
  return path.join(copilotBase, `${sessionId}.jsonl`)
}

function geminiFile(sessionId) {
  return path.join(geminiBase, `${sessionId}.json`)
}

// ── Claude tests ──

test("claude: returns last assistant text-content message", async () => {
  writeFixture(claudeFile("sess-a"), [
    JSON.stringify({ type: "user", message: { content: "Hello" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi there!" }] } }),
    JSON.stringify({ type: "user", message: { content: "Follow up" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Second reply" }] } }),
  ].join("\n"))

  const result = await readLastTurn("claude", "sess-a", "/any/workspace")
  assert.equal(result, "Second reply")
})

test("claude: returns last assistant message when content is a plain string", async () => {
  writeFixture(claudeFile("sess-b"), [
    JSON.stringify({ type: "user", message: { content: "Prompt" } }),
    JSON.stringify({ type: "assistant", message: { content: "Plain text response" } }),
  ].join("\n"))

  const result = await readLastTurn("claude", "sess-b", "/any/workspace")
  assert.equal(result, "Plain text response")
})

test("claude: returns null when no assistant messages present", async () => {
  writeFixture(claudeFile("sess-c"), [
    JSON.stringify({ type: "user", message: { content: "Hello" } }),
  ].join("\n"))

  const result = await readLastTurn("claude", "sess-c", "/any/workspace")
  assert.equal(result, null)
})

test("claude: returns null when session file does not exist", async () => {
  const result = await readLastTurn("claude", "nonexistent-session-xyz", "/any/workspace")
  assert.equal(result, null)
})

test("claude: returns null when scanPathClaude does not exist", async () => {
  const original = mockConfig.scanPathClaude
  mockConfig.scanPathClaude = path.join(tmpDir, "does-not-exist")
  try {
    const result = await readLastTurn("claude", "sess-any", "/any/workspace")
    assert.equal(result, null)
  } finally {
    mockConfig.scanPathClaude = original
  }
})

test("claude: skips malformed JSON lines without throwing", async () => {
  writeFixture(claudeFile("sess-d"), [
    "not valid json",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Valid reply" }] } }),
  ].join("\n"))

  const result = await readLastTurn("claude", "sess-d", "/any/workspace")
  assert.equal(result, "Valid reply")
})

test("claude: returns null when assistant content array has no text blocks", async () => {
  writeFixture(claudeFile("sess-e"), [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1" }] } }),
  ].join("\n"))

  const result = await readLastTurn("claude", "sess-e", "/any/workspace")
  assert.equal(result, null)
})

// ── Kilo tests ──

test("kilo: returns last assistant message text", async () => {
  const mockKilo = {
    async getMessages() {
      return [
        { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "How can I help?" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "Do X" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Done!" }] },
      ]
    },
  }

  const result = await readLastTurn("kilo", "kilo-sess-1", "/workspace", { kiloClient: mockKilo })
  assert.equal(result, "Done!")
})

test("kilo: returns null when no assistant messages in history", async () => {
  const mockKilo = {
    async getMessages() {
      return [
        { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
      ]
    },
  }

  const result = await readLastTurn("kilo", "kilo-sess-2", "/workspace", { kiloClient: mockKilo })
  assert.equal(result, null)
})

test("kilo: returns null when getMessages returns an empty array", async () => {
  const mockKilo = { async getMessages() { return [] } }

  const result = await readLastTurn("kilo", "kilo-sess-3", "/workspace", { kiloClient: mockKilo })
  assert.equal(result, null)
})

test("kilo: returns null when kiloClient is not provided", async () => {
  const result = await readLastTurn("kilo", "kilo-sess-4", "/workspace")
  assert.equal(result, null)
})

test("kilo: returns null when getMessages throws", async () => {
  const mockKilo = {
    async getMessages() { throw new Error("network error") },
  }

  const result = await readLastTurn("kilo", "kilo-sess-5", "/workspace", { kiloClient: mockKilo })
  assert.equal(result, null)
})

test("kilo: skips assistant messages with only tool parts and returns text from earlier assistant", async () => {
  const mockKilo = {
    async getMessages() {
      return [
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Earlier text" }] },
        { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash" }] },
      ]
    },
  }

  const result = await readLastTurn("kilo", "kilo-sess-6", "/workspace", { kiloClient: mockKilo })
  assert.equal(result, "Earlier text")
})

// ── Unsupported CLIs ──

test("returns null for codex without throwing", async () => {
  const result = await readLastTurn("codex", "some-id", "/workspace")
  assert.equal(result, null)
})

// ── Copilot tests ──

test("copilot: returns last assistant.message content from JSONL", async () => {
  writeFixture(copilotFile("cp-sess-a"), [
    JSON.stringify({ type: "user.message", data: { content: "Hello" } }),
    JSON.stringify({ type: "assistant.message", data: { content: "First reply" } }),
    JSON.stringify({ type: "user.message", data: { content: "Follow up" } }),
    JSON.stringify({ type: "assistant.message", data: { content: "Second reply" } }),
  ].join("\n"))

  const result = await readLastTurn("copilot", "cp-sess-a", "/any/workspace")
  assert.equal(result, "Second reply")
})

test("copilot: returns null when no assistant messages present", async () => {
  writeFixture(copilotFile("cp-sess-b"), [
    JSON.stringify({ type: "user.message", data: { content: "Hello" } }),
  ].join("\n"))

  const result = await readLastTurn("copilot", "cp-sess-b", "/any/workspace")
  assert.equal(result, null)
})

test("copilot: returns null when session file does not exist", async () => {
  const result = await readLastTurn("copilot", "cp-nonexistent-xyz", "/any/workspace")
  assert.equal(result, null)
})

test("copilot: skips malformed lines without throwing", async () => {
  writeFixture(copilotFile("cp-sess-c"), [
    "not valid json",
    JSON.stringify({ type: "assistant.message", data: { content: "Valid reply" } }),
    "also bad json",
  ].join("\n"))

  const result = await readLastTurn("copilot", "cp-sess-c", "/any/workspace")
  assert.equal(result, "Valid reply")
})

// ── Gemini tests ──

test("gemini: returns response field from JSON file", async () => {
  writeFixture(geminiFile("gm-sess-a"), JSON.stringify({
    response: "The assistant reply",
    session_id: "gm-sess-a",
    stats: {},
  }))

  const result = await readLastTurn("gemini", "gm-sess-a", "/any/workspace")
  assert.equal(result, "The assistant reply")
})

test("gemini: falls back to content field when response is absent", async () => {
  writeFixture(geminiFile("gm-sess-b"), JSON.stringify({
    content: "Content fallback",
    session_id: "gm-sess-b",
  }))

  const result = await readLastTurn("gemini", "gm-sess-b", "/any/workspace")
  assert.equal(result, "Content fallback")
})

test("gemini: falls back to text field when response and content are absent", async () => {
  writeFixture(geminiFile("gm-sess-c"), JSON.stringify({
    text: "Text fallback",
    session_id: "gm-sess-c",
  }))

  const result = await readLastTurn("gemini", "gm-sess-c", "/any/workspace")
  assert.equal(result, "Text fallback")
})

test("gemini: returns null when file does not exist", async () => {
  const result = await readLastTurn("gemini", "gm-nonexistent-xyz", "/any/workspace")
  assert.equal(result, null)
})

test("gemini: returns null when JSON has no text field", async () => {
  writeFixture(geminiFile("gm-sess-d"), JSON.stringify({
    session_id: "gm-sess-d",
    stats: {},
  }))

  const result = await readLastTurn("gemini", "gm-sess-d", "/any/workspace")
  assert.equal(result, null)
})
