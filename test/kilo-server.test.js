import { mock, test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"
// Force a predictable shell so the spawn-shape test isn't tied to the CI runner's $SHELL.
process.env.KILO_SERVE_SHELL = "/bin/testshell"

// ── Helpers ──

/** Build a minimal mock ChildProcess with controllable exit. */
function makeChild({ pid = 12345 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  // exitCode and signalCode are null on a running process (mirrors real ChildProcess).
  child.exitCode = null
  child.signalCode = null
  child.kill = mock.fn((signal) => {
    child.killed = true
    setImmediate(() => child.emit("exit", signal === "SIGKILL" ? 137 : 0))
  })
  return child
}

// ── Mocks ──

await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  },
})

let spawnImpl = null

await mock.module("node:child_process", {
  namedExports: {
    spawn: (...args) => spawnImpl(...args),
  },
})

let fetchImpl = null
globalThis.fetch = (...args) => fetchImpl(...args)

// Import module under test AFTER mocks are installed.
const { startKiloServer, stopKiloServer } = await import("../src/kilo-server.js")

// ── Tests ──

test("happy path: spawn succeeds, fetch returns 200, resolves with { pid, baseUrl }", async () => {
  const child = makeChild({ pid: 42 })
  spawnImpl = mock.fn(() => child)
  fetchImpl = mock.fn(async () => ({ ok: true }))

  const result = await startKiloServer({ port: 4097 })

  assert.equal(result.pid, 42)
  assert.equal(result.baseUrl, "http://127.0.0.1:4097")
  assert.equal(fetchImpl.mock.calls.length >= 1, true)
})

test("readiness timeout: fetch always fails; SIGKILL sent and error thrown", async () => {
  // Reset module-level state by calling stopKiloServer first.
  await stopKiloServer()

  const child = makeChild({ pid: 99 })
  spawnImpl = mock.fn(() => child)
  fetchImpl = mock.fn(async () => { throw new Error("ECONNREFUSED") })

  // Speed up the 30s timeout: make performance.now advance past the deadline after the
  // first call (which sets startTime), and make setTimeout fire immediately so
  // the sleep(200) polling delay doesn't actually wait.
  const origPerfNow = performance.now.bind(performance)
  const origSetTimeout = globalThis.setTimeout
  let perfCalls = 0
  const baseTime = origPerfNow()

  performance.now = () => {
    perfCalls++
    // First call sets startTime inside startKiloServer. Return base.
    // All subsequent calls should appear past the 30s deadline.
    return perfCalls === 1 ? baseTime : baseTime + 31_000
  }
  globalThis.setTimeout = (fn, _ms, ...args) => origSetTimeout(fn, 0, ...args)

  try {
    await assert.rejects(
      () => startKiloServer({ port: 4097 }),
      (err) => {
        assert.ok(err.message.includes("did not become ready"), `unexpected message: ${err.message}`)
        return true
      },
    )
    assert.equal(child.kill.mock.calls.length >= 1, true, "SIGKILL should have been sent")
    const signals = child.kill.mock.calls.map((c) => c.arguments[0])
    assert.ok(signals.includes("SIGKILL"), "SIGKILL should be in kill signals")
  } finally {
    performance.now = origPerfNow
    globalThis.setTimeout = origSetTimeout
  }
})

test("spawn command shape: uses config.kiloServeShell with -lc exec wrapper", async () => {
  await stopKiloServer()

  const child = makeChild({ pid: 7 })
  let capturedArgs = null
  spawnImpl = mock.fn((...args) => {
    capturedArgs = args
    return child
  })
  fetchImpl = mock.fn(async () => ({ ok: true }))

  await startKiloServer({ port: 4097 })

  assert.equal(capturedArgs[0], "/bin/testshell")
  assert.deepEqual(capturedArgs[1], ["-lc", "exec kilo serve --hostname 127.0.0.1 --port 4097"])
})

test("spawn command includes --hostname 127.0.0.1 before --port: explicit localhost bind invariant", async () => {
  // Kilo 7.1.8+ uses --hostname (not --host). An earlier version of this file
  // passed --host, which Kilo rejected with an unknown-argument error, silently
  // taking down the bridge on startup. This test locks the correct flag name
  // and the 127.0.0.1 value as a regression guard against a future edit slipping
  // the flag name back to --host or removing the explicit bind entirely.
  await stopKiloServer()

  const child = makeChild({ pid: 9 })
  let capturedCmd = null
  spawnImpl = mock.fn((_shell, args) => {
    capturedCmd = args[1]
    return child
  })
  fetchImpl = mock.fn(async () => ({ ok: true }))

  await startKiloServer({ port: 5000 })

  // Word boundary on --hostname so that a hypothetical --host regression doesn't
  // accidentally satisfy the assertion via substring matching.
  assert.ok(
    /\bexec kilo serve --hostname 127\.0\.0\.1 --port \d+/.test(capturedCmd),
    `spawn command must include 'exec kilo serve --hostname 127.0.0.1 --port <n>'; got: ${capturedCmd}`,
  )
  assert.ok(
    !/--host\b(?!name)/.test(capturedCmd),
    `spawn command must NOT use the legacy --host flag; got: ${capturedCmd}`,
  )
})

test("KILO_SERVER_PASSWORD overridden: even when parent has KILO_SERVER_PASSWORD=secret, spawn env passes empty", async () => {
  await stopKiloServer()

  process.env.KILO_SERVER_PASSWORD = "secret"

  const child = makeChild({ pid: 55 })
  let capturedOptions = null
  spawnImpl = mock.fn((_cmd, _args, opts) => {
    capturedOptions = opts
    return child
  })
  fetchImpl = mock.fn(async () => ({ ok: true }))

  try {
    await startKiloServer({ port: 4097 })
    assert.equal(capturedOptions.env.KILO_SERVER_PASSWORD, "", "KILO_SERVER_PASSWORD must be empty in spawn env")
  } finally {
    delete process.env.KILO_SERVER_PASSWORD
  }
})

test("stopKiloServer no-op: called without prior startKiloServer; resolves silently", async () => {
  await stopKiloServer()
  // Must not throw; calling again is also fine.
  await stopKiloServer()
})

test("stopKiloServer graceful: child responds to SIGTERM, resolves before gracePeriodMs", async () => {
  await stopKiloServer()

  const child = makeChild({ pid: 123 })
  spawnImpl = mock.fn(() => child)
  fetchImpl = mock.fn(async () => ({ ok: true }))

  await startKiloServer({ port: 4097 })

  // Override kill to emit exit on SIGTERM (graceful shutdown).
  child.kill = mock.fn((signal) => {
    child.killed = true
    setImmediate(() => child.emit("exit", 0))
  })

  const start = Date.now()
  await stopKiloServer({ gracePeriodMs: 5000 })
  const elapsed = Date.now() - start

  assert.ok(elapsed < 1000, `should resolve quickly on graceful shutdown (elapsed: ${elapsed}ms)`)
  const signals = child.kill.mock.calls.map((c) => c.arguments[0])
  assert.ok(signals.includes("SIGTERM"), "SIGTERM should have been sent")
})

test("stopKiloServer ungraceful: child ignores SIGTERM; SIGKILL sent after gracePeriodMs", async () => {
  await stopKiloServer()

  const child = makeChild({ pid: 456 })
  spawnImpl = mock.fn(() => child)
  fetchImpl = mock.fn(async () => ({ ok: true }))

  await startKiloServer({ port: 4097 })

  // Override kill: only exit when SIGKILL is received.
  child.kill = mock.fn((signal) => {
    child.killed = true
    if (signal === "SIGKILL") {
      setImmediate(() => child.emit("exit", 137))
    }
    // SIGTERM does nothing — process ignores it.
  })

  const start = Date.now()
  await stopKiloServer({ gracePeriodMs: 50 })  // short grace period for test speed
  const elapsed = Date.now() - start

  assert.ok(elapsed >= 50, `should wait at least gracePeriodMs (elapsed: ${elapsed}ms)`)
  const signals = child.kill.mock.calls.map((c) => c.arguments[0])
  assert.ok(signals.includes("SIGTERM"), "SIGTERM should have been sent first")
  assert.ok(signals.includes("SIGKILL"), "SIGKILL should have been sent after grace period")
})

test("spawn failure: spawn throws synchronously; error propagates from startKiloServer", async () => {
  await stopKiloServer()

  spawnImpl = mock.fn(() => { throw new Error("ENOENT: /bin/testshell not found") })
  fetchImpl = mock.fn(async () => ({ ok: true }))

  await assert.rejects(
    () => startKiloServer({ port: 4097 }),
    (err) => {
      assert.ok(err.message.includes("ENOENT"), `unexpected message: ${err.message}`)
      return true
    },
  )
})

test("error event during startup: child emits error before ready; rejects immediately with cause", async () => {
  await stopKiloServer()

  let capturedChild
  spawnImpl = mock.fn(() => {
    capturedChild = makeChild({ pid: 77 })
    return capturedChild
  })
  fetchImpl = mock.fn(async () => { throw new Error("ECONNREFUSED") })

  // startKiloServer attaches error/exit listeners synchronously before returning the Promise.
  const promise = startKiloServer({ port: 4097 })
  capturedChild.emit("error", new Error("ENOENT: kilo not found"))

  await assert.rejects(() => promise, (err) => {
    assert.ok(err.message.includes("ENOENT"), `unexpected message: ${err.message}`)
    return true
  })
})

test("exit event during startup: child exits before ready; rejects immediately with exit info", async () => {
  await stopKiloServer()

  let capturedChild
  spawnImpl = mock.fn(() => {
    capturedChild = makeChild({ pid: 88 })
    return capturedChild
  })
  fetchImpl = mock.fn(async () => { throw new Error("ECONNREFUSED") })

  const promise = startKiloServer({ port: 4097 })
  capturedChild.emit("exit", 1, null)

  await assert.rejects(() => promise, (err) => {
    assert.ok(err.message.includes("exited unexpectedly"), `unexpected message: ${err.message}`)
    return true
  })
})

test("exit with stderr output: stderr tail is surfaced in the rejection error", async () => {
  // Regression guard: when Kilo fails a config validation (e.g. an opencode.json
  // with an unsupported `env` key on an MCP entry) it writes the diagnostic to
  // stderr and then exits with code 1. The bridge must include that stderr tail
  // in the rejection error so users see the actual cause ("Invalid input
  // mcp.memory") in the startup log instead of a generic "exited unexpectedly"
  // that forces them to reproduce the failure manually with LOG_LEVEL=debug.
  await stopKiloServer()

  let capturedChild
  spawnImpl = mock.fn(() => {
    capturedChild = makeChild({ pid: 89 })
    return capturedChild
  })
  fetchImpl = mock.fn(async () => { throw new Error("ECONNREFUSED") })

  const promise = startKiloServer({ port: 4097 })

  // Simulate Kilo emitting a config validation error on stderr, then exiting.
  capturedChild.stderr.emit(
    "data",
    Buffer.from("Error: Configuration is invalid at /Users/test/.config/kilo/opencode.json\n↳ Invalid input mcp.memory\n"),
  )
  capturedChild.emit("exit", 1, null)

  await assert.rejects(() => promise, (err) => {
    assert.ok(err.message.includes("exited unexpectedly"), `missing exit info: ${err.message}`)
    assert.ok(err.message.includes("Invalid input mcp.memory"), `missing stderr tail: ${err.message}`)
    assert.ok(err.message.includes("Configuration is invalid"), `missing stderr context: ${err.message}`)
    return true
  })
})

test("exit with stderr tail bounded to STDERR_TAIL_LIMIT lines: very long stderr is truncated", async () => {
  // Defense against runaway error messages: if Kilo spews a 10k-line stack trace
  // before exiting, we want to cap the tail included in the rejection error so
  // the bridge log stays readable. The limit is 20 lines (see STDERR_TAIL_LIMIT
  // in src/kilo-server.js). This test asserts the tail-truncation behavior.
  await stopKiloServer()

  let capturedChild
  spawnImpl = mock.fn(() => {
    capturedChild = makeChild({ pid: 90 })
    return capturedChild
  })
  fetchImpl = mock.fn(async () => { throw new Error("ECONNREFUSED") })

  const promise = startKiloServer({ port: 4097 })

  // Emit 50 lines of stderr. The first 30 should be truncated off the tail,
  // only the last 20 should survive into the error message.
  for (let i = 0; i < 50; i++) {
    capturedChild.stderr.emit("data", Buffer.from(`stderr line ${i}\n`))
  }
  capturedChild.emit("exit", 1, null)

  await assert.rejects(() => promise, (err) => {
    // Lines 0-29 must be gone from the tail.
    assert.ok(!err.message.includes("stderr line 0\n"), `unexpected early line in tail: ${err.message}`)
    assert.ok(!err.message.includes("stderr line 29\n"), `unexpected early line in tail: ${err.message}`)
    // Lines 30-49 must be present (the last 20 lines of the 50-line stream).
    assert.ok(err.message.includes("stderr line 30"), `expected last 20 lines in tail, missing 'stderr line 30': ${err.message}`)
    assert.ok(err.message.includes("stderr line 49"), `expected last 20 lines in tail, missing 'stderr line 49': ${err.message}`)
    return true
  })
})

test("exit with multi-line single chunk: STDERR_TAIL_LIMIT applies to lines, not chunks", async () => {
  // Regression guard for a subtle line/chunk confusion: Node ChildProcess stderr
  // 'data' events deliver arbitrary byte chunks, NOT individual lines. A single
  // chunk can contain 50 newline-separated lines when Kilo flushes a stack trace
  // atomically. Before the line-splitting fix, the tail buffer pushed one entry
  // per chunk, so a large multi-line chunk would bypass the 20-line cap and
  // paste the entire thing into the startup error message. This test emits 50
  // lines in a SINGLE chunk and asserts that only the last 20 survive into the
  // error — catching the chunks-not-lines bug empirically.
  await stopKiloServer()

  let capturedChild
  spawnImpl = mock.fn(() => {
    capturedChild = makeChild({ pid: 92 })
    return capturedChild
  })
  fetchImpl = mock.fn(async () => { throw new Error("ECONNREFUSED") })

  const promise = startKiloServer({ port: 4097 })

  // 50 lines in ONE chunk (not 50 chunks of 1 line each — that's the other test).
  const bigChunk = Array.from({ length: 50 }, (_, i) => `bulk line ${i}`).join("\n") + "\n"
  capturedChild.stderr.emit("data", Buffer.from(bigChunk))
  capturedChild.emit("exit", 1, null)

  await assert.rejects(() => promise, (err) => {
    // Lines 0-29 must be gone (the first 30 of 50, trimmed to keep last 20).
    assert.ok(!err.message.includes("bulk line 0\n"), `unexpected early line 0: ${err.message}`)
    assert.ok(!err.message.includes("bulk line 29\n"), `unexpected early line 29: ${err.message}`)
    // Lines 30-49 must be present (the last 20 of the 50-line bulk chunk).
    assert.ok(err.message.includes("bulk line 30"), `missing 'bulk line 30' in tail: ${err.message}`)
    assert.ok(err.message.includes("bulk line 49"), `missing 'bulk line 49' in tail: ${err.message}`)
    return true
  })
})

test("exit with partial-line chunks: remainder is reassembled across chunks and flushed on exit", async () => {
  // Second half of the chunks-vs-lines story: a stderr chunk can end mid-line
  // (no trailing newline). The next chunk continues the same line. The tail
  // buffer must track a `stderrRemainder` string across chunks so the line is
  // reassembled correctly, and when the process exits with a non-empty
  // remainder (i.e. Kilo died mid-write), that partial line must be flushed
  // into the tail instead of silently lost. Otherwise the most recent stderr
  // output — often the most diagnostic — would disappear exactly when we need
  // it most.
  await stopKiloServer()

  let capturedChild
  spawnImpl = mock.fn(() => {
    capturedChild = makeChild({ pid: 93 })
    return capturedChild
  })
  fetchImpl = mock.fn(async () => { throw new Error("ECONNREFUSED") })

  const promise = startKiloServer({ port: 4097 })

  // Case 1: a complete line split across three chunks (remainder carried twice).
  capturedChild.stderr.emit("data", Buffer.from("first "))
  capturedChild.stderr.emit("data", Buffer.from("complete "))
  capturedChild.stderr.emit("data", Buffer.from("line\nsecond "))
  // Case 2: an incomplete trailing line with no final newline, then exit.
  capturedChild.stderr.emit("data", Buffer.from("incomplete"))
  capturedChild.emit("exit", 1, null)

  await assert.rejects(() => promise, (err) => {
    assert.ok(
      err.message.includes("first complete line"),
      `reassembled line missing from tail: ${err.message}`,
    )
    assert.ok(
      err.message.includes("second incomplete"),
      `flushed remainder missing from tail: ${err.message}`,
    )
    return true
  })
})

test("exit with no stderr output: rejection error is unchanged from legacy format", async () => {
  // Guard against accidentally introducing a trailing ": " or extra whitespace
  // when stderr is empty. The error message should be byte-identical to the
  // pre-change format when no stderr data was ever emitted.
  await stopKiloServer()

  let capturedChild
  spawnImpl = mock.fn(() => {
    capturedChild = makeChild({ pid: 91 })
    return capturedChild
  })
  fetchImpl = mock.fn(async () => { throw new Error("ECONNREFUSED") })

  const promise = startKiloServer({ port: 4097 })
  capturedChild.emit("exit", 2, null)  // no stderr data beforehand

  await assert.rejects(() => promise, (err) => {
    assert.equal(err.message, "kilo serve exited unexpectedly (code=2, signal=null)")
    return true
  })
})
