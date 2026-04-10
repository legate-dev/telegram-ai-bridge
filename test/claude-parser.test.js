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
 * `lines` is an array of raw strings — each is printed as a single stdout line.
 */
function makeFakeBin(lines) {
  const script = join(
    tmpdir(),
    `fake-claude-parser-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
  )
  const output = lines.map((l) => `printf '%s\\n' '${l.replace(/'/g, "'\\''")}'`).join("\n")
  writeFileSync(script, `#!/bin/sh\n${output}\n`)
  chmodSync(script, 0o755)
  return script
}

/**
 * Collect all events yielded by ClaudeBackend.sendMessage.
 */
async function collectEvents(opts) {
  const events = []
  const backend = new ClaudeBackend()
  for await (const event of backend.sendMessage(opts)) {
    events.push(event)
  }
  return events
}

// ── Text + result ──

test("ClaudeBackend yields text and result events from stream-json output", async () => {
  config.binClaude = makeFakeBin([
    '{"type":"system","session_id":"sid-1"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello from claude"}]}}',
    '{"type":"result","session_id":"sid-1","usage":{"input_tokens":10,"output_tokens":5}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })

  const textEvents = events.filter((e) => e.type === "text")
  assert.equal(textEvents.length, 1)
  assert.equal(textEvents[0].content, "Hello from claude")

  const resultEvent = events.find((e) => e.type === "result")
  assert.ok(resultEvent, "should have a result event")
  assert.equal(resultEvent.sessionId, "sid-1")
  assert.equal(resultEvent.inputTokens, 10)
  assert.equal(resultEvent.outputTokens, 5)
})

// ── Multiple text blocks ──

test("ClaudeBackend yields one text event per text block in an assistant message", async () => {
  config.binClaude = makeFakeBin([
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Part 1"},{"type":"text","text":"Part 2"}]}}',
    '{"type":"result","session_id":"sid-2","usage":{"input_tokens":3,"output_tokens":4}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })

  const textParts = events.filter((e) => e.type === "text").map((e) => e.content)
  assert.deepEqual(textParts, ["Part 1", "Part 2"])
})

// ── session_id from result event ──

test("ClaudeBackend captures session_id from the result event", async () => {
  config.binClaude = makeFakeBin([
    '{"type":"system","session_id":"system-sid"}',
    '{"type":"result","session_id":"result-sid","usage":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  const resultEvent = events.find((e) => e.type === "result")
  assert.equal(resultEvent?.sessionId, "result-sid")
})

// ── tool_use event ──

test("ClaudeBackend yields tool_use event with toolName and toolInput", async () => {
  config.binClaude = makeFakeBin([
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/test.js"}}]}}',
    '{"type":"result","session_id":"sid-3","usage":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "read" })
  const toolEvent = events.find((e) => e.type === "tool_use")
  assert.ok(toolEvent, "should have a tool_use event")
  assert.equal(toolEvent.toolName, "Read")
  assert.equal(toolEvent.toolInput, "/tmp/test.js")
})

test("ClaudeBackend does not yield tool_use for AskUserQuestion (surfaced as question event instead)", async () => {
  config.binClaude = makeFakeBin([
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"question":"How?","options":[]}]}}]}}',
    '{"type":"result","session_id":"sid-4","usage":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "ask" })
  assert.ok(
    !events.some((e) => e.type === "tool_use"),
    "AskUserQuestion should not yield a tool_use event",
  )
})

// ── thinking event ──

test("ClaudeBackend yields thinking event for thinking blocks", async () => {
  config.binClaude = makeFakeBin([
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me think..."},{"type":"text","text":"Answer"}]}}',
    '{"type":"result","session_id":"sid-5","usage":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "think" })
  const thinkEvent = events.find((e) => e.type === "thinking")
  assert.ok(thinkEvent, "should have a thinking event")
  assert.equal(thinkEvent.content, "Let me think...")
})

// ── permission event (control_request round-trip) ──

test("ClaudeBackend yields permission event on control_request and resumes after replyPermission", async () => {
  // Fake binary: emit control_request, wait for a control_response on stdin, then emit result.
  const script = join(tmpdir(), `fake-claude-perm-${Date.now()}.sh`)
  writeFileSync(script, [
    "#!/bin/sh",
    // Consume the initial user message written to stdin by sendMessage()
    "read -r _user_msg",
    // Emit permission request
    "printf '%s\\n' '{\"type\":\"control_request\",\"request_id\":\"req-1\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"Bash\",\"input\":{\"command\":\"echo hi\"}}}'",
    // Wait for the control_response written by replyPermission()
    "read -r _control_response",
    // Emit result after reply received
    "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"sid-perm\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}'",
  ].join("\n"))
  chmodSync(script, 0o755)
  config.binClaude = script

  const backend = new ClaudeBackend()
  const events = []

  for await (const event of backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "run" })) {
    events.push(event)
    if (event.type === "permission") {
      // Reply immediately; the generator is suspended here waiting for next stdout event.
      // Writing to stdin unblocks the shell script which then emits the result line.
      backend.replyPermission(event.requestId, "deny")
    }
  }

  const permEvent = events.find((e) => e.type === "permission")
  assert.ok(permEvent, "should have a permission event")
  assert.equal(permEvent.toolName, "Bash")
  assert.equal(permEvent.requestId, "req-1")
  assert.ok(permEvent.toolInput.includes("echo hi"), `toolInput should contain command, got: ${permEvent.toolInput}`)
  assert.ok(events.some((e) => e.type === "result"), "should eventually receive a result event")
})

// ── question event (AskUserQuestion control_request) ──

test("ClaudeBackend yields question event on AskUserQuestion control_request", async () => {
  const controlReq = JSON.stringify({
    type: "control_request",
    request_id: "q-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: {
        questions: [{ question: "Which approach?", header: "Design", multiSelect: false, options: [{ label: "A", description: "Option A" }] }],
      },
    },
  })
  const script = join(tmpdir(), `fake-claude-q-${Date.now()}.sh`)
  writeFileSync(script, [
    "#!/bin/sh",
    // Consume the initial user message written to stdin by sendMessage()
    "read -r _user_msg",
    `printf '%s\\n' '${controlReq.replace(/'/g, "'\\''")}'`,
    // Wait for the control_response written by replyPermission()
    "read -r _control_response",
    "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"sid-q\",\"usage\":{}}'",
  ].join("\n"))
  chmodSync(script, 0o755)
  config.binClaude = script

  const backend = new ClaudeBackend()
  const events = []
  for await (const event of backend.sendMessage({ sessionId: null, directory: tmpdir(), text: "ask" })) {
    events.push(event)
    if (event.type === "question") {
      backend.replyPermission(event.requestId, "deny")
    }
  }

  const qEvent = events.find((e) => e.type === "question")
  assert.ok(qEvent, "should have a question event")
  assert.equal(qEvent.requestId, "q-1")
  assert.ok(Array.isArray(qEvent.questions), "questions should be an array")
  assert.equal(qEvent.questions[0].question, "Which approach?")
  assert.equal(qEvent.questions[0].options[0].label, "A")
})

// ── error when no result event ──

test("ClaudeBackend yields error when process exits without a result event", async () => {
  config.binClaude = makeFakeBin([
    '{"type":"system","session_id":"sid-no-result"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}',
    // No result event — process exits
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  const errorEvent = events.find((e) => e.type === "error")
  assert.ok(errorEvent, "should yield an error event when process exits without result")
})

// ── timeout ──

test("ClaudeBackend yields error when process exceeds claudeTimeoutMs", async () => {
  const script = join(tmpdir(), `fake-claude-slow-${Date.now()}.sh`)
  writeFileSync(script, "#!/bin/sh\nsleep 30\n")
  chmodSync(script, 0o755)

  const savedTimeout = config.claudeTimeoutMs
  config.binClaude = script
  config.claudeTimeoutMs = 150  // Very short timeout for the test

  try {
    const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
    const errorEvent = events.find((e) => e.type === "error")
    assert.ok(errorEvent, "should yield an error event on timeout")
  } finally {
    config.claudeTimeoutMs = savedTimeout
  }
})

// ── CWD validation ──

test("ClaudeBackend yields error when bound workspace no longer exists", async () => {
  const missingDir = join(
    mkdtempSync(join(tmpdir(), "claude-missing-cwd-")),
    "deleted-workspace",
  )
  rmSync(join(missingDir, ".."), { recursive: true, force: true })

  const events = await collectEvents({ sessionId: null, directory: missingDir, text: "hi" })
  const errorEvent = events.find((e) => e.type === "error")
  assert.ok(errorEvent, "should yield an error event")
  assert.ok(
    errorEvent.message.includes("Workspace path is missing"),
    `error should mention missing path, got: ${errorEvent.message}`,
  )
  assert.ok(
    errorEvent.message.includes("ENOENT"),
    `error should mention ENOENT, got: ${errorEvent.message}`,
  )
})

test("ClaudeBackend yields error when bound workspace path is a file", async () => {
  const filePath = join(tmpdir(), `claude-not-a-directory-${Date.now()}.txt`)
  writeFileSync(filePath, "not a directory\n")

  const events = await collectEvents({ sessionId: null, directory: filePath, text: "hi" })
  rmSync(filePath, { force: true })

  const errorEvent = events.find((e) => e.type === "error")
  assert.ok(errorEvent, "should yield an error event")
  assert.ok(
    errorEvent.message.includes("Workspace path"),
    `error should mention workspace path, got: ${errorEvent.message}`,
  )
})

// ── replyPermission no-op when no active turn ──

test("ClaudeBackend.replyPermission is a no-op when no turn is active", () => {
  const backend = new ClaudeBackend()
  // Should not throw — just logs a warning
  backend.replyPermission("req-x", "allow")
})

// ── non-JSON lines are skipped gracefully ──

test("ClaudeBackend skips non-JSON lines without throwing", async () => {
  config.binClaude = makeFakeBin([
    "this is not json",
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"still works"}]}}',
    '{"type":"result","session_id":"sid-skip","usage":{}}',
  ])

  const events = await collectEvents({ sessionId: null, directory: tmpdir(), text: "hi" })
  const textEvents = events.filter((e) => e.type === "text")
  assert.equal(textEvents.length, 1)
  assert.equal(textEvents[0].content, "still works")
})
