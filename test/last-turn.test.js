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
const codexBase = path.join(tmpDir, "codex")
const homeEncoded = os.homedir().split("/").filter(Boolean).join("-")
const claudeFolder = "-" + homeEncoded + "-myproject"
const claudeFolderPath = path.join(claudeBase, claudeFolder)
fs.mkdirSync(claudeFolderPath, { recursive: true })

// ── Mock dependencies before importing last-turn ──

await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  },
})

const copilotBaseMock = path.join(tmpDir, "copilot-mock")
const geminiBaseMock = path.join(tmpDir, "gemini-mock")
fs.mkdirSync(copilotBaseMock, { recursive: true })
fs.mkdirSync(geminiBaseMock, { recursive: true })

const mockConfig = {
  scanPathClaude: claudeBase,
  scanPathCodex: codexBase,
  scanPathCopilot: copilotBaseMock,
  scanPathGemini: geminiBaseMock,
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

// ── Codex helpers ──

function codexFile(dateStr, filename) {
  // dateStr: "2024/03/15"
  const filePath = path.join(codexBase, ...dateStr.split("/"), filename)
  return filePath
}

function codexLines(sessionId, events) {
  const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/project", timestamp: "2024-03-15T10:00:00.000Z" } })
  return [meta, ...events.map((e) => JSON.stringify(e))].join("\n")
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

// ── Codex tests ──

test("codex: returns last assistant message text (payload.content)", async () => {
  const file = codexFile("2024/03/15", "sess-codex-a.jsonl")
  writeFixture(file, codexLines("codex-sess-a", [
    { type: "response_item", payload: { role: "user", content: "Hello" } },
    { type: "response_item", payload: { role: "assistant", content: "First reply" } },
    { type: "response_item", payload: { role: "user", content: "Follow up" } },
    { type: "response_item", payload: { role: "assistant", content: "Last reply" } },
  ]))

  const result = await readLastTurn("codex", "codex-sess-a", "/any/workspace")
  assert.equal(result, "Last reply")
})

test("codex: returns last assistant message text (payload.text fallback)", async () => {
  const file = codexFile("2024/03/15", "sess-codex-b.jsonl")
  writeFixture(file, codexLines("codex-sess-b", [
    { type: "response_item", payload: { role: "assistant", text: "Text field reply" } },
  ]))

  const result = await readLastTurn("codex", "codex-sess-b", "/any/workspace")
  assert.equal(result, "Text field reply")
})

test("codex: returns last assistant message text (payload.output fallback)", async () => {
  const file = codexFile("2024/03/15", "sess-codex-c.jsonl")
  writeFixture(file, codexLines("codex-sess-c", [
    { type: "response_item", payload: { role: "assistant", output: "Output field reply" } },
  ]))

  const result = await readLastTurn("codex", "codex-sess-c", "/any/workspace")
  assert.equal(result, "Output field reply")
})

test("codex: returns last assistant message text from message content blocks", async () => {
  const file = codexFile("2024/03/15", "sess-codex-c2.jsonl")
  writeFixture(file, codexLines("codex-sess-c2", [
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Block reply line 1" },
          { type: "output_text", text: "Block reply line 2" },
        ],
      },
    },
  ]))

  const result = await readLastTurn("codex", "codex-sess-c2", "/any/workspace")
  assert.equal(result, "Block reply line 1\n\nBlock reply line 2")
})

test("codex: returns null when no assistant messages in session", async () => {
  const file = codexFile("2024/03/16", "sess-codex-d.jsonl")
  writeFixture(file, codexLines("codex-sess-d", [
    { type: "response_item", payload: { role: "user", content: "Hello" } },
  ]))

  const result = await readLastTurn("codex", "codex-sess-d", "/any/workspace")
  assert.equal(result, null)
})

test("codex: returns null when session ID not found in tree", async () => {
  const result = await readLastTurn("codex", "codex-nonexistent-xyz", "/any/workspace")
  assert.equal(result, null)
})

test("codex: returns null when scanPathCodex does not exist", async () => {
  const original = mockConfig.scanPathCodex
  mockConfig.scanPathCodex = path.join(tmpDir, "codex-does-not-exist")
  try {
    const result = await readLastTurn("codex", "codex-sess-any", "/any/workspace")
    assert.equal(result, null)
  } finally {
    mockConfig.scanPathCodex = original
  }
})

test("codex: skips malformed JSON lines without throwing", async () => {
  const file = codexFile("2024/03/17", "sess-codex-e.jsonl")
  const meta = JSON.stringify({ type: "session_meta", payload: { id: "codex-sess-e", cwd: "/project" } })
  writeFixture(file, [
    meta,
    "not valid json",
    JSON.stringify({ type: "response_item", payload: { role: "assistant", content: "Valid reply" } }),
  ].join("\n"))

  const result = await readLastTurn("codex", "codex-sess-e", "/any/workspace")
  assert.equal(result, "Valid reply")
})

test("codex: returns null when assistant payload has no text field", async () => {
  const file = codexFile("2024/03/18", "sess-codex-f.jsonl")
  writeFixture(file, codexLines("codex-sess-f", [
    { type: "response_item", payload: { role: "assistant" } },
  ]))

  const result = await readLastTurn("codex", "codex-sess-f", "/any/workspace")
  assert.equal(result, null)
})

test("codex: returns assistant text when session_meta appears after response_item lines", async () => {
  const file = codexFile("2024/03/19", "sess-codex-g.jsonl")
  // session_meta is appended after the conversation events
  writeFixture(file, [
    JSON.stringify({ type: "response_item", payload: { role: "user", content: "Hello" } }),
    JSON.stringify({ type: "response_item", payload: { role: "assistant", content: "Late meta reply" } }),
    JSON.stringify({ type: "session_meta", payload: { id: "codex-sess-g", cwd: "/project" } }),
  ].join("\n"))

  const result = await readLastTurn("codex", "codex-sess-g", "/any/workspace")
  assert.equal(result, "Late meta reply")
})

test("codex: falls back to event_msg agent_message when response_item text is unavailable", async () => {
  const file = codexFile("2024/03/20", "sess-codex-h.jsonl")
  writeFixture(file, codexLines("codex-sess-h", [
    { type: "event_msg", payload: { type: "agent_message", message: "Event fallback reply" } },
    { type: "response_item", payload: { type: "reasoning", summary: [] } },
  ]))

  const result = await readLastTurn("codex", "codex-sess-h", "/any/workspace")
  assert.equal(result, "Event fallback reply")
})

// ── Copilot ──

function copilotFile(sessionId) {
  const dir = path.join(copilotBaseMock, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "events.jsonl")
}

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

test("copilot: returns null when session dir does not exist", async () => {
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

// ── Gemini ──

function geminiFile(sessionId) {
  const dir = path.join(geminiBaseMock, `fixture-${sessionId}`)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "logs.json")
}

test("gemini: returns last assistant message content from logs.json", async () => {
  writeFixture(geminiFile("gm-sess-a"), JSON.stringify([
    { sessionId: "gm-sess-a", role: "user", content: "Hello" },
    { sessionId: "gm-sess-a", role: "assistant", content: "First reply" },
    { sessionId: "gm-sess-a", role: "user", content: "Follow up" },
    { sessionId: "gm-sess-a", role: "assistant", content: "Second reply" },
  ]))

  const result = await readLastTurn("gemini", "gm-sess-a", "/any/workspace")
  assert.equal(result, "Second reply")
})

test("gemini: falls back to text field when content is absent", async () => {
  writeFixture(geminiFile("gm-sess-b"), JSON.stringify([
    { sessionId: "gm-sess-b", role: "assistant", text: "Text fallback" },
  ]))

  const result = await readLastTurn("gemini", "gm-sess-b", "/any/workspace")
  assert.equal(result, "Text fallback")
})

test("gemini: returns null when no assistant messages for sessionId", async () => {
  writeFixture(geminiFile("gm-sess-c"), JSON.stringify([
    { sessionId: "gm-sess-c", role: "user", content: "Hello" },
  ]))

  const result = await readLastTurn("gemini", "gm-sess-c", "/any/workspace")
  assert.equal(result, null)
})

test("gemini: returns null when sessionId not found in any workspace", async () => {
  const result = await readLastTurn("gemini", "gm-nonexistent-xyz", "/any/workspace")
  assert.equal(result, null)
})

test("gemini: ignores messages from other sessions in same logs.json", async () => {
  writeFixture(geminiFile("gm-sess-d"), JSON.stringify([
    { sessionId: "other-sess", role: "assistant", content: "Not mine" },
    { sessionId: "gm-sess-d", role: "assistant", content: "Mine" },
  ]))

  const result = await readLastTurn("gemini", "gm-sess-d", "/any/workspace")
  assert.equal(result, "Mine")
})

// ── Unsupported CLIs ──

test("returns null for unsupported CLI without throwing", async () => {
  const result = await readLastTurn("xai", "some-id", "/workspace")
  assert.equal(result, null)
})
