import test from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

const { KiloBackend } = await import("../src/backends.js")
const { KiloClient } = await import("../src/kilo-client.js")

function withImmediateTimeouts(fn) {
  const originalSetTimeout = global.setTimeout
  const originalDateNow = Date.now
  let now = originalDateNow()

  global.setTimeout = (callback, _delay, ...args) => {
    now += Number(_delay) || 0
    callback(...args)
    return 0
  }
  Date.now = () => now

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.setTimeout = originalSetTimeout
      Date.now = originalDateNow
    })
}

test("KiloBackend waits for delayed assistant text after tool-only messages", async () => {
  await withImmediateTimeouts(async () => {
    let retrievalCall = 0
    const kilo = {
      async getSessionStatus() {
        return { type: "idle" }
      },
      async promptAsync() {
        return null
      },
      async waitForTurn() {
        return { completed: true, reason: "done", elapsed: 1000 }
      },
      async getMessages() {
        retrievalCall += 1

        if (retrievalCall === 1) return []

        if (retrievalCall < 6) {
          return [
            {
              info: { role: "assistant" },
              parts: [{ type: "tool", tool: "task", state: { status: "completed", output: "ok" } }],
            },
          ]
        }

        return [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Done after tool call" }],
          },
        ]
      },
    }

    const backend = new KiloBackend(kilo)
    const result = await backend.sendMessage({
      sessionId: "session-1",
      directory: "/tmp",
      text: "run tool",
      agent: "kilo",
    })

    assert.deepEqual(result, { text: "Done after tool call" })
  })
})

test("KiloBackend surfaces assistant message errors when no text is available", async () => {
  await withImmediateTimeouts(async () => {
    let retrievalCall = 0
    const kilo = {
      async getSessionStatus() {
        return { type: "idle" }
      },
      async promptAsync() {
        return null
      },
      async waitForTurn() {
        return { completed: true, reason: "done", elapsed: 1000 }
      },
      async getMessages() {
        retrievalCall += 1
        if (retrievalCall === 1) return []
        return [
          {
            info: {
              role: "assistant",
              error: { name: "APIError", message: "Tool chain failed upstream" },
            },
            parts: [{ type: "step-finish", reason: "error" }],
          },
        ]
      },
    }

    const backend = new KiloBackend(kilo)
    const result = await backend.sendMessage({
      sessionId: "session-2",
      directory: "/tmp",
      text: "run tool",
      agent: "kilo",
    })

    assert.deepEqual(result, { error: "APIError: Tool chain failed upstream" })
  })
})

test("KiloBackend surfaces a clear error when the turn never appears in the Kilo status map", async () => {
  await withImmediateTimeouts(async () => {
    const kilo = {
      async getSessionStatus() {
        return { type: "idle" }
      },
      async promptAsync() {
        return null
      },
      async waitForTurn() {
        return { completed: false, reason: "missing_status", elapsed: 8000 }
      },
      async getMessages() {
        return []
      },
    }

    const backend = new KiloBackend(kilo)
    const result = await backend.sendMessage({
      sessionId: "session-missing-status",
      directory: "/tmp",
      text: "run tool",
      agent: "kilo",
    })

    assert.deepEqual(result, {
      error: "Turn was submitted but Kilo never exposed session state. The backend may have ignored the turn or lost track of the session. Use /status to check, or /new to start fresh.",
    })
  })
})

test("KiloBackend does not reuse the previous assistant reply when no new assistant message lands", async () => {
  await withImmediateTimeouts(async () => {
    let retrievalCall = 0
    const oldAssistant = {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "Previous answer" }],
    }

    const kilo = {
      async getSessionStatus() {
        return { type: "idle" }
      },
      async promptAsync() {
        return null
      },
      async waitForTurn() {
        return { completed: true, reason: "done", elapsed: 1000 }
      },
      async getMessages() {
        retrievalCall += 1

        if (retrievalCall === 1) {
          return [oldAssistant]
        }

        return [oldAssistant]
      },
    }

    const backend = new KiloBackend(kilo)
    const result = await backend.sendMessage({
      sessionId: "session-3",
      directory: "/tmp",
      text: "new question",
      agent: "kilo",
    })

    assert.deepEqual(result, { error: "Turn completed but no assistant response found." })
  })
})

test("waitForTurn does not sleep before the first status check", async () => {
  await withImmediateTimeouts(async () => {
    const startNow = Date.now()

    const client = new KiloClient({ baseUrl: "http://localhost", username: "", password: "" })
    // Return idle immediately — the turn is already done by the time we first check
    client.getSessionStatus = async () => ({ type: "idle" })

    const result = await client.waitForTurn("session-instant", {
      initialDelayMs: 0,
      pollIntervalMs: 3000,
      absoluteTimeoutMs: 60000,
      staleTimeoutMs: 30000,
    })

    const elapsed = Date.now() - startNow

    assert.equal(result.completed, true)
    assert.equal(result.reason, "done")
    // With the fix the only sleep is the single recheck delay (pollIntervalMs).
    // Without the fix there would be an extra pollIntervalMs sleep before the first check,
    // making elapsed equal to 2 * pollIntervalMs (6000ms).
    assert.equal(elapsed, 3000, "only one poll-interval delay (recheck) should be incurred")
  })
})

test("KiloBackend aborts session and returns question data when waitForTurn detects a mid-turn question", async () => {
  await withImmediateTimeouts(async () => {
    let abortCalled = false
    const questionPayload = {
      questions: [{ question: "Pick one", header: "Choice", options: [{ label: "A" }] }],
      precedingText: "Some context",
    }

    const kilo = {
      async getSessionStatus() { return null },
      async promptAsync() { return null },
      async waitForTurn() {
        return {
          completed: false,
          reason: "question_pending",
          elapsed: 5000,
          question: questionPayload,
        }
      },
      async getMessages() { return [] },
      async abortSession() { abortCalled = true },
    }

    const backend = new KiloBackend(kilo)
    const result = await backend.sendMessage({
      sessionId: "sess-q",
      directory: "/tmp",
      text: "do something",
      agent: "code",
    })

    assert.ok(abortCalled, "abortSession should have been called")
    assert.ok(result.question, "result should contain question")
    assert.equal(result.question.questions[0].header, "Choice")
    assert.equal(result.question.precedingText, "Some context")
    assert.equal(result.text, undefined, "should not have text result")
    assert.equal(result.error, undefined, "should not have error result")
  })
})
