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
  assert.deepEqual(capturedArgs[1], ["-lc", "exec kilo serve --host 127.0.0.1 --port 4097"])
})

test("spawn command includes --host 127.0.0.1 before --port: explicit localhost bind invariant", async () => {
  await stopKiloServer()

  const child = makeChild({ pid: 9 })
  let capturedCmd = null
  spawnImpl = mock.fn((_shell, args) => {
    capturedCmd = args[1]
    return child
  })
  fetchImpl = mock.fn(async () => ({ ok: true }))

  await startKiloServer({ port: 5000 })

  assert.ok(
    /--host 127\.0\.0\.1 --port \d+/.test(capturedCmd),
    `spawn command must include '--host 127.0.0.1 --port <n>'; got: ${capturedCmd}`,
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
