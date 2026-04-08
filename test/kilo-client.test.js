import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Mock dependencies before importing KiloClient ──

await mock.module("../src/config.js", {
  namedExports: {
    config: {
      kiloStatusTimeoutMs: 5000,
      kiloAbortTimeoutMs: 10000,
      kiloSubmitTimeoutMs: 15000,
      kiloTurnTimeoutMs: 900000,
      kiloStaleTimeoutMs: 120000,
      kiloPollIntervalMs: 3000,
      kiloPollInitialDelayMs: 5000,
      kiloTimeoutMs: 120000,
      kiloRetries: 2,
      kiloVariant: "high",
    },
  },
})

await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  },
})

const { KiloClient } = await import("../src/kilo-client.js")

// ── Helpers ──

/** Create a fetch-compatible response object. */
function makeResponse(body, { status = 200, ok = true, statusText = "OK" } = {}) {
  return { ok, status, statusText, async text() { return body } }
}

/**
 * Run `fn` with setTimeout collapsed to 0ms elapsed time increments
 * so that waitForTurn / sleep calls resolve without real delays.
 */
function withImmediateTimeouts(fn) {
  const originalSetTimeout = globalThis.setTimeout
  const originalDateNow = Date.now
  let now = originalDateNow()

  globalThis.setTimeout = (callback, _delay, ...args) => {
    now += Number(_delay) || 0
    callback(...args)
    return 0
  }
  Date.now = () => now

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.setTimeout = originalSetTimeout
      Date.now = originalDateNow
    })
}

/** Swap out globalThis.fetch for the duration of `fn`. */
async function withMockFetch(mockFn, fn) {
  const original = globalThis.fetch
  globalThis.fetch = mockFn
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function makeClient(opts = {}) {
  return new KiloClient({
    baseUrl: "http://localhost:4096",
    username: opts.username ?? "user",
    password: opts.password ?? "",
  })
}

// ── buildUrl ──

test("buildUrl constructs a URL without a directory query parameter", () => {
  const client = makeClient()
  const url = client.buildUrl("/session")
  assert.equal(url.pathname, "/session")
  assert.equal(url.searchParams.get("directory"), null)
})

test("buildUrl appends the directory as a query parameter when provided", () => {
  const client = makeClient()
  const url = client.buildUrl("/session", "/home/user/project")
  assert.equal(url.searchParams.get("directory"), "/home/user/project")
})

// ── request — auth header ──

test("request includes a Basic Authorization header when a password is set", async () => {
  const client = makeClient({ username: "kilo", password: "secret" })
  let capturedHeaders

  await withMockFetch(async (_url, opts) => {
    capturedHeaders = opts.headers
    return makeResponse('{"ok":true}')
  }, async () => {
    await client.request("/session")
  })

  assert.ok(capturedHeaders.Authorization, "Authorization header should be present")
  assert.ok(
    capturedHeaders.Authorization.startsWith("Basic "),
    "Authorization header should use Basic scheme",
  )
  const encoded = capturedHeaders.Authorization.slice("Basic ".length)
  assert.equal(
    Buffer.from(encoded, "base64").toString(),
    "kilo:secret",
  )
})

test("request omits the Authorization header when no password is set", async () => {
  const client = makeClient({ username: "kilo", password: "" })
  let capturedHeaders

  await withMockFetch(async (_url, opts) => {
    capturedHeaders = opts.headers
    return makeResponse('{"ok":true}')
  }, async () => {
    await client.request("/session")
  })

  assert.equal(capturedHeaders.Authorization, undefined)
})

// ── request — successful response ──

test("request parses and returns a JSON response body", async () => {
  const client = makeClient()

  const result = await withMockFetch(
    async () => makeResponse('{"id":"sess-1","status":"idle"}'),
    () => client.request("/session/sess-1"),
  )

  assert.deepEqual(result, { id: "sess-1", status: "idle" })
})

test("request returns null when the response body is empty", async () => {
  const client = makeClient()

  const result = await withMockFetch(
    async () => makeResponse(""),
    () => client.request("/session/sess-empty"),
  )

  assert.equal(result, null)
})

// ── request — error responses ──

test("request throws when the server returns a non-OK status", async () => {
  const client = makeClient()

  await withMockFetch(
    async () => makeResponse("Not Found", { status: 404, ok: false, statusText: "Not Found" }),
    async () => {
      await assert.rejects(
        () => client.request("/session/missing"),
        /404/,
      )
    },
  )
})

test("request throws when the response body is invalid JSON", async () => {
  const client = makeClient()

  await withMockFetch(
    async () => makeResponse("not-json-at-all"),
    async () => {
      await assert.rejects(
        () => client.request("/session/bad-json"),
        /invalid JSON/i,
      )
    },
  )
})

// ── request — retry on transient network errors ──

test("request retries on a transient ECONNRESET error and succeeds on the second attempt", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    let attempts = 0

    const result = await withMockFetch(async () => {
      attempts++
      if (attempts === 1) {
        const err = new Error("connection reset")
        err.cause = { code: "ECONNRESET" }
        throw err
      }
      return makeResponse('{"data":"ok"}')
    }, () => client.request("/session", { retries: 2 }))

    assert.equal(attempts, 2, "should have made exactly 2 attempts")
    assert.deepEqual(result, { data: "ok" })
  })
})

test("request throws after exhausting all retries on transient errors", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    let attempts = 0

    await withMockFetch(async () => {
      attempts++
      const err = new Error("connection refused")
      err.cause = { code: "ECONNREFUSED" }
      throw err
    }, async () => {
      await assert.rejects(
        () => client.request("/session", { retries: 2 }),
        /connection refused/,
      )
    })

    assert.equal(attempts, 2)
  })
})

// ── request — retry on retryable HTTP status ──

test("request retries on HTTP 503 and succeeds on the second attempt", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    let attempts = 0

    const result = await withMockFetch(async () => {
      attempts++
      if (attempts === 1) return makeResponse("", { status: 503, ok: false, statusText: "Service Unavailable" })
      return makeResponse('{"ready":true}')
    }, () => client.request("/session", { retries: 2 }))

    assert.equal(attempts, 2)
    assert.deepEqual(result, { ready: true })
  })
})

test("request retries on HTTP 429 Too Many Requests", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    let attempts = 0

    await withMockFetch(async () => {
      attempts++
      if (attempts < 2) return makeResponse("", { status: 429, ok: false, statusText: "Too Many Requests" })
      return makeResponse('{"ok":true}')
    }, () => client.request("/session", { retries: 2 }))

    assert.equal(attempts, 2)
  })
})

// ── convenience methods ──

test("getSessionStatus returns the status for the given session ID", async () => {
  const client = makeClient()

  const result = await withMockFetch(
    async () => makeResponse('{"sess-abc":{"type":"busy"},"sess-xyz":{"type":"idle"}}'),
    () => client.getSessionStatus("sess-abc"),
  )

  assert.deepEqual(result, { type: "busy" })
})

test("getSessionStatus returns null when the session is not in the status map", async () => {
  const client = makeClient()

  const result = await withMockFetch(
    async () => makeResponse('{"other-sess":{"type":"idle"}}'),
    () => client.getSessionStatus("missing-sess"),
  )

  assert.equal(result, null)
})

test("getAllStatuses returns an empty object when the server returns null", async () => {
  const client = makeClient()

  const result = await withMockFetch(
    async () => makeResponse(""),
    () => client.getAllStatuses(),
  )

  assert.deepEqual(result, {})
})

// ── waitForTurn ──

test("waitForTurn returns completed=true when session becomes idle then stays idle", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    client.getSessionStatus = async () => ({ type: "idle" })

    const result = await client.waitForTurn("sess-1", {
      initialDelayMs: 0,
      pollIntervalMs: 1000,
      absoluteTimeoutMs: 60000,
      staleTimeoutMs: 30000,
    })

    assert.equal(result.completed, true)
    assert.equal(result.reason, "done")
  })
})

test("waitForTurn returns completed=false with reason 'aborted' when the signal is pre-aborted", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    const controller = new AbortController()
    controller.abort()

    const result = await client.waitForTurn("sess-2", {
      initialDelayMs: 0,
      pollIntervalMs: 1000,
      absoluteTimeoutMs: 60000,
      staleTimeoutMs: 30000,
      signal: controller.signal,
    })

    assert.equal(result.completed, false)
    assert.equal(result.reason, "aborted")
  })
})

test("waitForTurn returns reason 'absolute_timeout' when the wall-clock limit is exceeded", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    // Always busy — never completes
    client.getSessionStatus = async () => ({ type: "busy" })

    const result = await client.waitForTurn("sess-3", {
      initialDelayMs: 100,
      pollIntervalMs: 3000,
      absoluteTimeoutMs: 100, // only room for the initial delay
      staleTimeoutMs: 900000,
    })

    assert.equal(result.completed, false)
    assert.equal(result.reason, "absolute_timeout")
  })
})

test("waitForTurn returns reason 'stale_timeout' when status checks keep failing", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    // Always throws — server unreachable
    client.getSessionStatus = async () => { throw new Error("ECONNREFUSED") }

    const result = await client.waitForTurn("sess-4", {
      initialDelayMs: 0,
      pollIntervalMs: 3000,
      absoluteTimeoutMs: 900000,
      staleTimeoutMs: 3000, // one failed check is enough to reach the stale limit
    })

    assert.equal(result.completed, false)
    assert.equal(result.reason, "stale_timeout")
  })
})

test("waitForTurn returns completed=true when a busy session disappears from the status map", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    let calls = 0

    client.getSessionStatus = async () => {
      calls++
      if (calls === 1) return { type: "busy" }
      return null
    }

    const result = await client.waitForTurn("sess-4b", {
      initialDelayMs: 0,
      pollIntervalMs: 1000,
      absoluteTimeoutMs: 60000,
      staleTimeoutMs: 30000,
    })

    assert.equal(result.completed, true)
    assert.equal(result.reason, "done")
  })
})

test("waitForTurn returns reason 'missing_status' when the turn never appears in the status map", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    client.getSessionStatus = async () => null

    const result = await client.waitForTurn("sess-4c", {
      initialDelayMs: 0,
      pollIntervalMs: 1000,
      absoluteTimeoutMs: 60000,
      staleTimeoutMs: 30000,
    })

    assert.equal(result.completed, false)
    assert.equal(result.reason, "missing_status")
  })
})

test("waitForTurn continues polling when an idle recheck detects 'busy' again", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    let calls = 0

    client.getSessionStatus = async () => {
      calls++
      if (calls === 1) return { type: "idle" }  // first poll: looks idle
      if (calls === 2) return { type: "busy" }  // recheck: still busy — continue!
      if (calls === 3) return { type: "idle" }  // second poll: idle again
      return { type: "idle" }                   // second recheck: idle → done
    }

    const result = await client.waitForTurn("sess-5", {
      initialDelayMs: 0,
      pollIntervalMs: 1000,
      absoluteTimeoutMs: 60000,
      staleTimeoutMs: 30000,
    })

    assert.equal(result.completed, true)
    assert.equal(result.reason, "done")
    assert.ok(calls >= 4, `expected at least 4 status checks, got ${calls}`)
  })
})

test("waitForTurn returns reason 'question_pending' when a mid-turn mcp_question is detected", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    let statusCalls = 0

    client.getSessionStatus = async () => {
      statusCalls++
      return { type: "busy" }
    }

    client.getMessages = async () => [
      // Pre-existing user message (messageCountBefore = 1)
      { info: { role: "user" }, parts: [{ type: "text", text: "help me decide" }] },
      // New assistant message with a pending question tool
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Here are your options:" },
          {
            type: "tool",
            tool: "question",
            state: {
              status: "running",
              input: {
                questions: [{
                  question: "How do you want to proceed?",
                  header: "Next step",
                  options: [
                    { label: "Option A", description: "Do A" },
                    { label: "Option B", description: "Do B" },
                  ],
                }],
              },
            },
          },
        ],
      },
    ]

    const result = await client.waitForTurn("sess-question", {
      initialDelayMs: 0,
      pollIntervalMs: 1000,
      absoluteTimeoutMs: 60000,
      staleTimeoutMs: 30000,
      messageCountBefore: 1,
      questionCheckEveryNPolls: 1, // check on every poll for test speed
    })

    assert.equal(result.completed, false)
    assert.equal(result.reason, "question_pending")
    assert.ok(result.question, "should include question data")
    assert.equal(result.question.questions[0].header, "Next step")
    assert.equal(result.question.precedingText, "Here are your options:")
  })
})

// ── waitForTurn — unlisted-agent (messageCountBefore) paths ──

test("waitForTurn keeps polling while unlisted agent has an incomplete assistant message, then completes when time.completed is set", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    let statusCalls = 0
    let messageCalls = 0

    // Status never shows busy — agent is unlisted
    client.getSessionStatus = async () => {
      statusCalls++
      return null
    }

    // Prevent real network calls from permission polling
    client.listPendingPermissions = async () => []

    client.getMessages = async () => {
      messageCalls++
      // First two message calls: assistant is still streaming (time.completed = false)
      if (messageCalls <= 2) {
        return [
          { info: { role: "user" } },
          { info: { role: "assistant", time: { completed: false } } },
        ]
      }
      // Third call: assistant has finished (time.completed is set)
      return [
        { info: { role: "user" } },
        { info: { role: "assistant", time: { completed: "2026-04-06T12:00:00Z" } } },
      ]
    }

    const result = await client.waitForTurn("sess-unlisted", {
      initialDelayMs: 0,
      pollIntervalMs: 1000,
      absoluteTimeoutMs: 60000,
      staleTimeoutMs: 30000,
      messageCountBefore: 1,
    })

    assert.equal(result.completed, true)
    assert.equal(result.reason, "done")
    assert.ok(messageCalls >= 3, `expected at least 3 getMessages calls, got ${messageCalls}`)
  })
})

test("waitForTurn falls back to status-only logic when getMessages throws, without spinning to absoluteTimeout", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    let statusCalls = 0

    // Status goes busy → idle; without the messages-fallback fix this path
    // would never be reached because the outer catch would consume the loop.
    client.getSessionStatus = async () => {
      statusCalls++
      if (statusCalls === 1) return { type: "busy" }
      return { type: "idle" }
    }

    // getMessages always throws
    client.getMessages = async () => { throw new Error("network error") }

    const result = await client.waitForTurn("sess-msg-err", {
      initialDelayMs: 0,
      pollIntervalMs: 1000,
      absoluteTimeoutMs: 60000,
      staleTimeoutMs: 30000,
      messageCountBefore: 0,
    })

    // Should complete via the status-only recheck path, not timeout
    assert.equal(result.completed, true)
    assert.equal(result.reason, "done")
  })
})

test("waitForTurn keeps polling for unlisted agent when a new message appears during the completion recheck", async () => {
  await withImmediateTimeouts(async () => {
    const client = makeClient()
    let messageCalls = 0

    // Status never shows busy — agent is unlisted
    client.getSessionStatus = async () => null

    client.getMessages = async () => {
      messageCalls++
      // Call 1: initial poll — single completed assistant message (looks done)
      if (messageCalls === 1) {
        return [
          { info: { role: "user" } },
          { info: { role: "assistant", time: { completed: "2026-04-06T12:00:00Z" } } },
        ]
      }
      // Call 2: re-sample after sleep — a new streaming assistant message appeared → resume detected
      if (messageCalls === 2) {
        return [
          { info: { role: "user" } },
          { info: { role: "assistant", time: { completed: "2026-04-06T12:00:00Z" } } },
          { info: { role: "assistant", time: { completed: false } } },
        ]
      }
      // Call 3: next poll — second message still streaming
      if (messageCalls === 3) {
        return [
          { info: { role: "user" } },
          { info: { role: "assistant", time: { completed: "2026-04-06T12:00:00Z" } } },
          { info: { role: "assistant", time: { completed: false } } },
        ]
      }
      // Call 4+: second message now completed (re-sample confirms done)
      return [
        { info: { role: "user" } },
        { info: { role: "assistant", time: { completed: "2026-04-06T12:00:00Z" } } },
        { info: { role: "assistant", time: { completed: "2026-04-06T12:01:00Z" } } },
      ]
    }

    const result = await client.waitForTurn("sess-unlisted-multistep", {
      initialDelayMs: 0,
      pollIntervalMs: 1000,
      absoluteTimeoutMs: 60000,
      staleTimeoutMs: 30000,
      messageCountBefore: 1,
    })

    assert.equal(result.completed, true)
    assert.equal(result.reason, "done")
    assert.ok(messageCalls >= 4, `expected at least 4 getMessages calls, got ${messageCalls}`)
  })
})
