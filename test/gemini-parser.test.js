import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

const { config } = await import("../src/config.js")
const { GeminiBackend } = await import("../src/backends.js")

/**
 * Write a shell script to a temp file, make it executable, return path.
 * `lines` is an array of raw strings emitted one per stdout line.
 */
function makeFakeBin(lines) {
  const script = join(
    tmpdir(),
    `fake-gemini-parser-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
  )
  const output = lines.map((l) => `printf '%s\\n' '${l.replace(/'/g, "'\\''")}'`).join("\n")
  writeFileSync(script, `#!/bin/sh\n${output}\n`)
  chmodSync(script, 0o755)
  return script
}

/** Collect all events yielded by GeminiBackend.sendMessage. */
async function collectEvents(opts) {
  const events = []
  const backend = new GeminiBackend()
  for await (const event of backend.sendMessage(opts)) {
    events.push(event)
  }
  return events
}

// ── delta:true messages → text events ──

test("GeminiBackend yields text event for each delta:true message", async () => {
  config.binGemini = makeFakeBin([
    '{"type":"init","session_id":"sid-g1"}',
    '{"type":"message","role":"assistant","content":"Hello ","delta":true}',
    '{"type":"message","role":"assistant","content":"world!","delta":true}',
    '{"type":"result","session_id":"sid-g1","status":"ok","stats":{"input_token_count":5,"output_token_count":3}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })

  const textEvents = events.filter((e) => e.type === "text")
  assert.equal(textEvents.length, 2)
  assert.equal(textEvents[0].text, "Hello ")
  assert.equal(textEvents[1].text, "world!")
})

// ── delta:false messages → buffered, flushed at result ──

test("GeminiBackend buffers non-delta messages and flushes them at result", async () => {
  config.binGemini = makeFakeBin([
    '{"type":"message","role":"assistant","content":"Complete response","delta":false}',
    '{"type":"result","session_id":"sid-g2","status":"ok","stats":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })

  const textEvents = events.filter((e) => e.type === "text")
  assert.equal(textEvents.length, 1)
  assert.equal(textEvents[0].text, "Complete response")
  assert.ok(events.some((e) => e.type === "result"))
})

// ── session_id captured from init and result ──

test("GeminiBackend captures session_id and token counts from result event", async () => {
  config.binGemini = makeFakeBin([
    '{"type":"init","session_id":"from-init"}',
    '{"type":"message","role":"assistant","content":"ok","delta":true}',
    '{"type":"result","session_id":"from-result","status":"ok","stats":{"input_token_count":2,"output_token_count":1}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  const resultEvent = events.find((e) => e.type === "result")
  assert.equal(resultEvent?.sessionId, "from-result")
  assert.equal(resultEvent?.inputTokens, 2)
  assert.equal(resultEvent?.outputTokens, 1)
})

// ── tool_use event ──

test("GeminiBackend yields tool_use event with toolName and toolInput", async () => {
  config.binGemini = makeFakeBin([
    '{"type":"tool_use","tool_name":"read_file","tool_id":"t1","parameters":{"file_path":"/tmp/x.js"}}',
    '{"type":"tool_result","tool_id":"t1","status":"ok","output":"contents"}',
    '{"type":"message","role":"assistant","content":"Done","delta":true}',
    '{"type":"result","session_id":"sid-g3","status":"ok","stats":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "read" })

  const toolEvent = events.find((e) => e.type === "tool_use")
  assert.ok(toolEvent, "should have a tool_use event")
  assert.equal(toolEvent.toolName, "read_file")
  assert.equal(toolEvent.toolInput, "/tmp/x.js")
})

// ── pre-tool non-delta messages discarded ──

test("GeminiBackend discards non-delta messages preceding tool_use (planning/reasoning)", async () => {
  config.binGemini = makeFakeBin([
    '{"type":"message","role":"assistant","content":"Let me think...","delta":false}',
    '{"type":"tool_use","tool_name":"shell","tool_id":"t2","parameters":{"command":"ls"}}',
    '{"type":"tool_result","tool_id":"t2","status":"ok","output":"file.txt"}',
    '{"type":"message","role":"assistant","content":"Found it","delta":true}',
    '{"type":"result","session_id":"sid-g4","status":"ok","stats":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "ls" })

  const textEvents = events.filter((e) => e.type === "text")
  // "Let me think..." must be discarded; only "Found it" (delta) survives
  assert.equal(textEvents.length, 1)
  assert.equal(textEvents[0].text, "Found it")
})

// ── error event in stream ──

test("GeminiBackend yields error event on stream error event", async () => {
  config.binGemini = makeFakeBin([
    '{"type":"error","severity":"ERROR","message":"Model overloaded"}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  const errorEvent = events.find((e) => e.type === "error")
  assert.ok(errorEvent, "should have an error event")
  assert.ok(errorEvent.message.includes("Model overloaded"))
})

// ── result with status:error ──

test("GeminiBackend yields error event on result with status:error", async () => {
  config.binGemini = makeFakeBin([
    '{"type":"result","status":"error","error":{"message":"Turn failed"},"stats":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  const errorEvent = events.find((e) => e.type === "error")
  assert.ok(errorEvent, "should have an error event")
  assert.ok(errorEvent.message.includes("Turn failed"))
})

// ── exit without result ──

test("GeminiBackend yields error when process exits without a result event", async () => {
  config.binGemini = makeFakeBin([
    '{"type":"message","role":"assistant","content":"partial","delta":true}',
    // No result event
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  assert.ok(events.some((e) => e.type === "error"), "should yield an error when no result")
})

// ── timeout ──

test("GeminiBackend yields error when process exceeds geminiTimeoutMs", async () => {
  const script = join(tmpdir(), `fake-gemini-slow-${Date.now()}.sh`)
  writeFileSync(script, "#!/bin/sh\nsleep 30\n")
  chmodSync(script, 0o755)

  const savedTimeout = config.geminiTimeoutMs
  config.binGemini = script
  config.geminiTimeoutMs = 150

  try {
    const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
    assert.ok(events.some((e) => e.type === "error"), "should yield an error on timeout")
  } finally {
    config.geminiTimeoutMs = savedTimeout
  }
})

// ── quota error in stderr ──

test("GeminiBackend surfaces quota error when stderr mentions capacity", async () => {
  const script = join(tmpdir(), `fake-gemini-quota-${Date.now()}.sh`)
  writeFileSync(script, "#!/bin/sh\necho 'exhausted your capacity' >&2\nexit 1\n")
  chmodSync(script, 0o755)
  config.binGemini = script

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  const errorEvent = events.find((e) => e.type === "error")
  assert.ok(errorEvent, "should yield an error event")
  assert.ok(
    errorEvent.message.includes("quota exhausted"),
    `expected quota message, got: ${errorEvent.message}`,
  )
})

// ── CWD validation ──

test("GeminiBackend yields error when workspace no longer exists", async () => {
  const missingDir = join(
    mkdtempSync(join(tmpdir(), "gemini-missing-cwd-")),
    "deleted-workspace",
  )
  rmSync(join(missingDir, ".."), { recursive: true, force: true })

  const events = await collectEvents({ sessionId: null, directory: missingDir, text: "hi" })
  const errorEvent = events.find((e) => e.type === "error")
  assert.ok(errorEvent, "should yield an error event")
  assert.ok(
    errorEvent.message.includes("Workspace path is missing"),
    `got: ${errorEvent.message}`,
  )
})

// ── non-JSON lines skipped ──

test("GeminiBackend skips non-JSON lines without throwing", async () => {
  config.binGemini = makeFakeBin([
    "not json at all",
    '{"type":"message","role":"assistant","content":"still works","delta":true}',
    '{"type":"result","session_id":"sid-skip","status":"ok","stats":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  const textEvents = events.filter((e) => e.type === "text")
  assert.equal(textEvents.length, 1)
  assert.equal(textEvents[0].text, "still works")
})

// ── user-role messages ignored ──

test("GeminiBackend ignores messages with role:user", async () => {
  config.binGemini = makeFakeBin([
    '{"type":"message","role":"user","content":"echo back","delta":true}',
    '{"type":"message","role":"assistant","content":"response","delta":true}',
    '{"type":"result","session_id":"sid-u","status":"ok","stats":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  const textEvents = events.filter((e) => e.type === "text")
  assert.equal(textEvents.length, 1)
  assert.equal(textEvents[0].text, "response")
})

// ── R3: multiple non-delta messages joined correctly ──

test("GeminiBackend joins multiple non-delta messages without separator at result flush", async () => {
  // Two consecutive non-delta messages — join("") is intentional (cc-connect semantics).
  // Each fragment is expected to carry natural word boundaries (trailing space if needed).
  config.binGemini = makeFakeBin([
    '{"type":"message","role":"assistant","content":"Hello ","delta":false}',
    '{"type":"message","role":"assistant","content":"world!","delta":false}',
    '{"type":"result","session_id":"sid-join","status":"ok","stats":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  const textEvents = events.filter((e) => e.type === "text")
  assert.equal(textEvents.length, 1, "multiple non-delta messages must be flushed as one text event")
  assert.equal(textEvents[0].text, "Hello world!", "fragments joined without extra separator")
})

// ── R4: session resume -r flag ──

test("GeminiBackend passes -r flag when sessionId is a real (non-placeholder) ID", async () => {
  // Script checks explicitly for the -r flag followed by the session ID in argv.
  const script = join(tmpdir(), `fake-gemini-args-${Date.now()}.sh`)
  writeFileSync(script, [
    "#!/bin/sh",
    "prev=''",
    "for arg in \"$@\"; do",
    // Check for the two-arg sequence: prev="-r" && arg=sessionId
    "  if [ \"$prev\" = \"-r\" ] && [ \"$arg\" = \"real-session-abc\" ]; then",
    "    printf '%s\\n' '{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"resumed\",\"delta\":true}'",
    "    printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"real-session-abc\",\"status\":\"ok\",\"stats\":{}}'",
    "    exit 0",
    "  fi",
    "  prev=\"$arg\"",
    "done",
    "printf '%s\\n' '{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"new\",\"delta\":true}'",
    "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"new-sess\",\"status\":\"ok\",\"stats\":{}}'",
  ].join("\n"))
  chmodSync(script, 0o755)
  config.binGemini = script

  const events = await collectEvents({ sessionId: "real-session-abc", directory: tmpdir(), text: "hi" })
  const textEvent = events.find((e) => e.type === "text")
  assert.equal(textEvent?.text, "resumed", "-r <sessionId> must be in args for non-placeholder sessionId")
})

test("GeminiBackend omits -r flag for placeholder sessionId (gemini-<timestamp>)", async () => {
  const script = join(tmpdir(), `fake-gemini-args-noR-${Date.now()}.sh`)
  writeFileSync(script, [
    "#!/bin/sh",
    "prev=''",
    "for arg in \"$@\"; do",
    "  if [ \"$prev\" = \"-r\" ] && [ \"$arg\" = \"gemini-1234567890\" ]; then",
    "    printf '%s\\n' '{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"got-placeholder\",\"delta\":true}'",
    "    printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"x\",\"status\":\"ok\",\"stats\":{}}'",
    "    exit 0",
    "  fi",
    "  prev=\"$arg\"",
    "done",
    "printf '%s\\n' '{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"no-placeholder\",\"delta\":true}'",
    "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"x\",\"status\":\"ok\",\"stats\":{}}'",
  ].join("\n"))
  chmodSync(script, 0o755)
  config.binGemini = script

  const events = await collectEvents({ sessionId: "gemini-1234567890", directory: tmpdir(), text: "hi" })
  const textEvent = events.find((e) => e.type === "text")
  assert.equal(textEvent?.text, "no-placeholder", "placeholder sessionId must not appear after -r")
})
