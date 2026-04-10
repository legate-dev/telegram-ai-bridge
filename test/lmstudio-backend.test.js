import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Mock state ──

const mockHistory = []
const appendedMessages = []
let mockFetchImpl = null

await mock.module("../src/db.js", {
  namedExports: {
    sessionCountsByCli: () => [],
    getLmStudioMessages: () => [...mockHistory],
    appendLmStudioMessage: (sid, role, content) => appendedMessages.push({ sid, role, content }),
  },
})

await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    redactString: (s) => s,
  },
})

await mock.module("../src/config.js", {
  namedExports: {
    config: {
      lmstudioBaseUrl: "http://127.0.0.1:1234",
      lmstudioModel: "test-model",
      lmstudioTimeoutMs: 5000,
      lmstudioMaxTokens: 512,
    },
  },
})

// Intercept global fetch
const originalFetch = global.fetch
global.fetch = (...args) => {
  if (mockFetchImpl) return mockFetchImpl(...args)
  return originalFetch(...args)
}

const { LmStudioBackend } = await import("../src/backends.js")

// ── Helpers ──

function resetMocks() {
  mockHistory.length = 0
  appendedMessages.length = 0
  mockFetchImpl = null
}

/**
 * Build a fake SSE ReadableStream from an array of SSE lines.
 * Each string is sent as a complete line followed by "\n".
 */
function makeStream(lines) {
  const encoder = new TextEncoder()
  const chunks = lines.map((l) => encoder.encode(l + "\n"))
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
      } else {
        controller.close()
      }
    },
  })
}

function makeResponse(lines, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: makeStream(lines),
    text: async () => lines.join("\n"),
    json: async () => JSON.parse(lines.join("")),
  }
}

// ── Tests ──

test("LmStudioBackend yields text chunks and result on successful stream", async () => {
  resetMocks()
  mockFetchImpl = () => makeResponse([
    `data: {"choices":[{"delta":{"content":"Hello"}}]}`,
    `data: {"choices":[{"delta":{"content":" world"}}]}`,
    `data: [DONE]`,
  ])

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s1", directory: "/tmp", text: "hi" })) {
    events.push(ev)
  }

  const texts = events.filter((e) => e.type === "text").map((e) => e.text)
  assert.deepEqual(texts, ["Hello", " world"])
  assert.equal(events.at(-1).type, "result")
  assert.equal(events.at(-1).sessionId, "s1")
})

test("LmStudioBackend persists user + assistant messages to DB on success", async () => {
  resetMocks()
  mockFetchImpl = () => makeResponse([
    `data: {"choices":[{"delta":{"content":"Hi there"}}]}`,
    `data: [DONE]`,
  ])

  const backend = new LmStudioBackend()
  for await (const _ of backend.sendMessage({ sessionId: "s2", directory: "/tmp", text: "hello" })) {}

  const user = appendedMessages.find((m) => m.role === "user")
  const assistant = appendedMessages.find((m) => m.role === "assistant")
  assert.ok(user, "user message should be persisted")
  assert.equal(user.content, "hello")
  assert.ok(assistant, "assistant message should be persisted")
  assert.equal(assistant.content, "Hi there")
})

test("LmStudioBackend includes history in request body", async () => {
  resetMocks()
  mockHistory.push({ role: "user", content: "previous" })
  mockHistory.push({ role: "assistant", content: "response" })

  let capturedBody = null
  mockFetchImpl = (url, opts) => {
    capturedBody = JSON.parse(opts.body)
    return makeResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}`, `data: [DONE]`])
  }

  const backend = new LmStudioBackend()
  for await (const _ of backend.sendMessage({ sessionId: "s3", directory: "/tmp", text: "new" })) {}

  assert.equal(capturedBody.messages.length, 3)
  assert.equal(capturedBody.messages[0].role, "user")
  assert.equal(capturedBody.messages[0].content, "previous")
  assert.equal(capturedBody.messages[2].content, "new")
})

test("LmStudioBackend skips reasoning_content-only chunks", async () => {
  resetMocks()
  mockFetchImpl = () => makeResponse([
    `data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}`,
    `data: {"choices":[{"delta":{"reasoning_content":"more thinking"}}]}`,
    `data: {"choices":[{"delta":{"content":"final answer"}}]}`,
    `data: [DONE]`,
  ])

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s4", directory: "/tmp", text: "hi" })) {
    events.push(ev)
  }

  const texts = events.filter((e) => e.type === "text").map((e) => e.text)
  assert.deepEqual(texts, ["final answer"], "reasoning chunks should be filtered out")
})

test("LmStudioBackend yields error on non-200 response", async () => {
  resetMocks()
  mockFetchImpl = () => ({
    ok: false,
    status: 503,
    body: makeStream([]),
    text: async () => JSON.stringify({ error: { message: "No models loaded" } }),
  })

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s5", directory: "/tmp", text: "hi" })) {
    events.push(ev)
  }

  assert.equal(events.length, 1)
  assert.equal(events[0].type, "error")
  assert.ok(events[0].message.includes("No models loaded"))
})

test("LmStudioBackend yields error when fetch throws (unreachable)", async () => {
  resetMocks()
  mockFetchImpl = () => Promise.reject(new Error("ECONNREFUSED"))

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s6", directory: "/tmp", text: "hi" })) {
    events.push(ev)
  }

  assert.equal(events.length, 1)
  assert.equal(events[0].type, "error")
  assert.ok(events[0].message.includes("unreachable"))
})

test("LmStudioBackend yields error on EOF without [DONE] and no content", async () => {
  resetMocks()
  mockFetchImpl = () => makeResponse([
    `data: {"choices":[{"delta":{"reasoning_content":"thinking only"}}]}`,
    // no [DONE], stream ends
  ])

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s7", directory: "/tmp", text: "hi" })) {
    events.push(ev)
  }

  assert.equal(events.at(-1).type, "error")
})

test("LmStudioBackend does not persist messages on error response", async () => {
  resetMocks()
  mockFetchImpl = () => ({
    ok: false,
    status: 500,
    body: makeStream([]),
    text: async () => "{}",
  })

  const backend = new LmStudioBackend()
  for await (const _ of backend.sendMessage({ sessionId: "s8", directory: "/tmp", text: "hi" })) {}

  assert.equal(appendedMessages.length, 0, "no messages should be persisted on error")
})

test("LmStudioBackend captures token counts from usage field", async () => {
  resetMocks()
  mockFetchImpl = () => makeResponse([
    `data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
    `data: [DONE]`,
  ])

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s9", directory: "/tmp", text: "hi" })) {
    events.push(ev)
  }

  const result = events.find((e) => e.type === "result")
  assert.equal(result.inputTokens, 10)
  assert.equal(result.outputTokens, 5)
})
