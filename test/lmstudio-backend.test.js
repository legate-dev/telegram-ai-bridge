import { mock, test, after } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Mock state ──

const mockResponseIds = {}
let mockFetchImpl = null

await mock.module("../src/db.js", {
  namedExports: {
    sessionCountsByCli: () => [],
    getLmStudioResponseId: (sid) => mockResponseIds[sid] ?? null,
    setLmStudioResponseId: (sid, rid) => { mockResponseIds[sid] = rid },
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
      lmstudioDetectTimeoutMs: 1000,
      lmstudioApiToken: "",
    },
  },
})

// Intercept global fetch — restored after all tests via after() hook
const originalFetch = global.fetch
global.fetch = (...args) => {
  if (mockFetchImpl) return mockFetchImpl(...args)
  return originalFetch(...args)
}
after(() => { global.fetch = originalFetch })

const { LmStudioBackend } = await import("../src/backends.js")

// ── Helpers ──

function resetMocks() {
  for (const k of Object.keys(mockResponseIds)) delete mockResponseIds[k]
  mockFetchImpl = null
}

/**
 * Build a fake SSE stream from named events.
 * Each entry is { event: "type", data: object|string }.
 */
function makeSSEStream(events) {
  const encoder = new TextEncoder()
  const lines = []
  for (const ev of events) {
    lines.push(`event: ${ev.event}`)
    const payload = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data)
    lines.push(`data: ${payload}`)
    lines.push("") // blank line separates events
  }
  const chunk = encoder.encode(lines.join("\n") + "\n")
  let sent = false
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        controller.enqueue(chunk)
        sent = true
      } else {
        controller.close()
      }
    },
  })
}

function makeResponse(events, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: makeSSEStream(events),
    text: async () => "",
  }
}

// ── Tests ──

test("LmStudioBackend yields text chunks and result on successful stream", async (t) => {
  resetMocks()
  t.after(() => { mockFetchImpl = null })
  mockFetchImpl = () => makeResponse([
    { event: "chat.start", data: { type: "chat.start", model_instance_id: "test-model" } },
    { event: "message.start", data: { type: "message.start" } },
    { event: "message.delta", data: { type: "message.delta", content: "Hello" } },
    { event: "message.delta", data: { type: "message.delta", content: " world" } },
    { event: "message.end", data: { type: "message.end" } },
    { event: "chat.end", data: { type: "chat.end", result: {
      model_instance_id: "test-model",
      output: [{ type: "message", content: "Hello world" }],
      stats: { input_tokens: 10, total_output_tokens: 5, tokens_per_second: 42 },
      response_id: "resp_abc123",
    }}},
  ])

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s1", directory: "/tmp", text: "hi" })) {
    events.push(ev)
  }

  const texts = events.filter((e) => e.type === "text").map((e) => e.text)
  assert.deepEqual(texts, ["Hello", " world"])
  const result = events.find((e) => e.type === "result")
  assert.equal(result.sessionId, "s1")
  assert.equal(result.inputTokens, 10)
  assert.equal(result.outputTokens, 5)
  assert.equal(result.tokensPerSecond, 42)
})

test("LmStudioBackend stores response_id for session continuity", async (t) => {
  resetMocks()
  t.after(() => { mockFetchImpl = null })
  mockFetchImpl = () => makeResponse([
    { event: "chat.start", data: { type: "chat.start", model_instance_id: "test-model" } },
    { event: "message.delta", data: { type: "message.delta", content: "ok" } },
    { event: "chat.end", data: { type: "chat.end", result: {
      output: [{ type: "message", content: "ok" }],
      stats: { input_tokens: 1, total_output_tokens: 1 },
      response_id: "resp_xyz789",
    }}},
  ])

  const backend = new LmStudioBackend()
  for await (const _ of backend.sendMessage({ sessionId: "s2", directory: "/tmp", text: "hi" })) {}

  assert.equal(mockResponseIds["s2"], "resp_xyz789")
})

test("LmStudioBackend passes previous_response_id when resuming", async (t) => {
  resetMocks()
  mockResponseIds["s3"] = "resp_previous123"
  t.after(() => { mockFetchImpl = null })

  let capturedBody = null
  mockFetchImpl = (url, opts) => {
    capturedBody = JSON.parse(opts.body)
    return makeResponse([
      { event: "chat.start", data: { type: "chat.start", model_instance_id: "test-model" } },
      { event: "message.delta", data: { type: "message.delta", content: "resumed" } },
      { event: "chat.end", data: { type: "chat.end", result: {
        output: [{ type: "message", content: "resumed" }],
        stats: {},
        response_id: "resp_new456",
      }}},
    ])
  }

  const backend = new LmStudioBackend()
  for await (const _ of backend.sendMessage({ sessionId: "s3", directory: "/tmp", text: "continue" })) {}

  assert.equal(capturedBody.previous_response_id, "resp_previous123")
  assert.equal(capturedBody.input, "continue")
  assert.equal(mockResponseIds["s3"], "resp_new456")
})

test("LmStudioBackend skips reasoning events", async (t) => {
  resetMocks()
  t.after(() => { mockFetchImpl = null })
  mockFetchImpl = () => makeResponse([
    { event: "chat.start", data: { type: "chat.start", model_instance_id: "test-model" } },
    { event: "reasoning.start", data: { type: "reasoning.start" } },
    { event: "reasoning.delta", data: { type: "reasoning.delta", content: "thinking..." } },
    { event: "reasoning.end", data: { type: "reasoning.end" } },
    { event: "message.delta", data: { type: "message.delta", content: "final answer" } },
    { event: "chat.end", data: { type: "chat.end", result: {
      output: [{ type: "reasoning", content: "thinking..." }, { type: "message", content: "final answer" }],
      stats: {},
      response_id: "resp_r1",
    }}},
  ])

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s4", directory: "/tmp", text: "think" })) {
    events.push(ev)
  }

  const texts = events.filter((e) => e.type === "text").map((e) => e.text)
  assert.deepEqual(texts, ["final answer"], "reasoning events should not produce text yields")
})

test("LmStudioBackend yields error on non-200 response", async (t) => {
  resetMocks()
  t.after(() => { mockFetchImpl = null })
  mockFetchImpl = () => ({
    ok: false,
    status: 503,
    body: makeSSEStream([]),
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

test("LmStudioBackend yields error when fetch throws (unreachable)", async (t) => {
  resetMocks()
  t.after(() => { mockFetchImpl = null })
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

test("LmStudioBackend yields error on null response body", async (t) => {
  resetMocks()
  t.after(() => { mockFetchImpl = null })
  mockFetchImpl = () => ({ ok: true, status: 200, body: null })

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s7", directory: "/tmp", text: "hi" })) {
    events.push(ev)
  }

  assert.equal(events.length, 1)
  assert.equal(events[0].type, "error")
  assert.ok(events[0].message.includes("no body"))
})

test("LmStudioBackend yields error when chat.end has no message content", async (t) => {
  resetMocks()
  t.after(() => { mockFetchImpl = null })
  mockFetchImpl = () => makeResponse([
    { event: "chat.start", data: { type: "chat.start", model_instance_id: "test-model" } },
    { event: "chat.end", data: { type: "chat.end", result: {
      output: [{ type: "reasoning", content: "only thinking" }],
      stats: {},
      response_id: "resp_empty",
    }}},
  ])

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s8", directory: "/tmp", text: "hi" })) {
    events.push(ev)
  }

  assert.equal(events.at(-1).type, "error")
  assert.ok(events.at(-1).message.includes("no text content"))
})

test("LmStudioBackend does not persist response_id on error", async (t) => {
  resetMocks()
  t.after(() => { mockFetchImpl = null })
  mockFetchImpl = () => ({
    ok: false,
    status: 500,
    body: makeSSEStream([]),
    text: async () => "{}",
  })

  const backend = new LmStudioBackend()
  for await (const _ of backend.sendMessage({ sessionId: "s9", directory: "/tmp", text: "hi" })) {}

  assert.equal(mockResponseIds["s9"], undefined, "no response_id should be stored on error")
})

test("LmStudioBackend yields tool_use events for tool calls", async (t) => {
  resetMocks()
  t.after(() => { mockFetchImpl = null })
  mockFetchImpl = () => makeResponse([
    { event: "chat.start", data: { type: "chat.start", model_instance_id: "test-model" } },
    { event: "tool_call.start", data: { type: "tool_call.start", tool: "web_search", provider_info: { type: "ephemeral_mcp" } } },
    { event: "tool_call.success", data: { type: "tool_call.success", tool: "web_search", output: "result data" } },
    { event: "message.delta", data: { type: "message.delta", content: "Based on the search..." } },
    { event: "chat.end", data: { type: "chat.end", result: {
      output: [
        { type: "tool_call", tool: "web_search", output: "result data" },
        { type: "message", content: "Based on the search..." },
      ],
      stats: {},
      response_id: "resp_tool1",
    }}},
  ])

  const backend = new LmStudioBackend()
  const events = []
  for await (const ev of backend.sendMessage({ sessionId: "s10", directory: "/tmp", text: "search" })) {
    events.push(ev)
  }

  const toolEvents = events.filter((e) => e.type === "tool_use")
  assert.equal(toolEvents.length, 2)
  assert.equal(toolEvents[0].status, "start")
  assert.equal(toolEvents[0].toolName, "web_search")
  assert.equal(typeof toolEvents[0].toolInput, "string")
  assert.equal(toolEvents[1].status, "success")
  assert.equal(toolEvents[1].toolName, "web_search")
  assert.equal(toolEvents[1].output, "result data")
})

test("LmStudioBackend sends auth header when API token is configured", async (t) => {
  resetMocks()
  t.after(() => { mockFetchImpl = null })

  // Temporarily set the token in our mock config
  const { config } = await import("../src/config.js")
  const originalToken = config.lmstudioApiToken
  config.lmstudioApiToken = "test-token-123"
  t.after(() => { config.lmstudioApiToken = originalToken })

  let capturedHeaders = null
  mockFetchImpl = (url, opts) => {
    capturedHeaders = opts.headers
    return makeResponse([
      { event: "chat.start", data: { type: "chat.start", model_instance_id: "test-model" } },
      { event: "message.delta", data: { type: "message.delta", content: "authed" } },
      { event: "chat.end", data: { type: "chat.end", result: {
        output: [{ type: "message", content: "authed" }],
        stats: {},
        response_id: "resp_auth1",
      }}},
    ])
  }

  const backend = new LmStudioBackend()
  for await (const _ of backend.sendMessage({ sessionId: "s11", directory: "/tmp", text: "hi" })) {}

  assert.equal(capturedHeaders["Authorization"], "Bearer test-token-123")
})
