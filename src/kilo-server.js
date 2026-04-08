import { spawn } from "node:child_process"
import { config } from "./config.js"
import { log } from "./log.js"

// Keys that must not be forwarded to the kilo serve subprocess.
const REDACTED_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_ID",
  "KILO_SERVER_USERNAME",
  "KILO_SERVER_PASSWORD",
])

function buildEnv() {
  const env = { ...process.env }
  for (const key of REDACTED_KEYS) delete env[key]
  // Force empty password so kilo runs in insecure mode on localhost.
  // Overrides any inherited value (e.g. from a previous shell session or Direnv).
  env.KILO_SERVER_PASSWORD = ""
  return env
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Module-level handle for the spawned kilo serve process.
let kiloChild = null

/**
 * Spawn `kilo serve` and wait until it responds to HTTP requests.
 * Throws on spawn failure, early process exit, or readiness timeout.
 *
 * @param {{ port: number }} options
 * @returns {Promise<{ pid: number, baseUrl: string }>}
 */
export async function startKiloServer({ port }) {
  // Explicit localhost bind. The bridge forces KILO_SERVER_PASSWORD="" (see buildEnv above),
  // so exposing the HTTP API beyond 127.0.0.1 would grant unauthenticated arbitrary code
  // execution to anyone on the LAN (Kilo's tool-call API can execute arbitrary shell
  // commands). Kilo 7.1.8+ defaults --hostname to "127.0.0.1", but we pass it explicitly
  // as defense-in-depth against: (a) an opencode.json config overriding the default,
  // (b) an --mdns flag being introduced elsewhere in the spawn chain (it flips the
  // default to 0.0.0.0), (c) a future Kilo version changing the default. Do not remove
  // --hostname 127.0.0.1 without also adding auth. The flag name is `--hostname`, not
  // `--host` — older drafts of this code used `--host` which Kilo rejects with an
  // unknown-argument error, silently taking down the bridge on startup.
  const child = spawn(config.kiloServeShell, ["-lc", `exec kilo serve --hostname 127.0.0.1 --port ${port}`], {
    env: buildEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  })

  // Collect stderr into a tail buffer so that if Kilo exits before becoming ready,
  // the actual diagnostic (config validation failure, missing binary, port conflict,
  // etc.) is surfaced in the startup error instead of a generic "exited unexpectedly"
  // message. Without this, users need LOG_LEVEL=debug to even see the stderr, and
  // end up having to reproduce the failure manually in a terminal.
  //
  // IMPORTANT: Node ChildProcess stderr "data" events deliver arbitrary byte chunks,
  // NOT individual lines. A single chunk can contain multiple newline-separated lines
  // (e.g. when Kilo flushes a stack trace atomically) OR a partial line that is
  // completed by the next chunk. We therefore split each chunk on "\n" and maintain
  // a `stderrRemainder` string for the trailing partial line that must be carried
  // across chunks. The STDERR_TAIL_LIMIT cap is applied to the RESULTING LINES, not
  // to the raw chunks — otherwise a single large chunk could bypass the cap
  // entirely and paste a 10k-line stack trace into the startup error.
  const stderrTail = []
  const STDERR_TAIL_LIMIT = 20
  let stderrRemainder = ""

  // Forward kilo output to the bridge logger so structured logs stay clean.
  child.stdout.on("data", (data) => {
    log.debug("kilo-server", "stdout", { line: data.toString().trimEnd() })
  })
  child.stderr.on("data", (data) => {
    // Prepend any partial line carried over from the previous chunk, then split
    // into complete lines. The last element of the split is either an empty
    // string (if the chunk ended exactly on a newline) or the new partial line
    // that continues into the next chunk — keep it as the new remainder.
    const combined = stderrRemainder + data.toString()
    const parts = combined.split("\n")
    stderrRemainder = parts.pop() ?? ""
    for (const line of parts) {
      if (line) {
        stderrTail.push(line)
        if (stderrTail.length > STDERR_TAIL_LIMIT) stderrTail.shift()
      }
      log.debug("kilo-server", "stderr", { line })
    }
  })

  kiloChild = child

  // Race the readiness probe against fatal events so that a spawn error or unexpected
  // early exit rejects immediately with a clear cause instead of hiding behind a
  // generic 30s readiness timeout.
  return new Promise((resolve, reject) => {
    let cancelled = false

    const onError = (err) => {
      cancelled = true
      kiloChild = null
      reject(new Error(`kilo serve spawn error: ${err.message}`))
    }
    const onEarlyExit = (code, signal) => {
      cancelled = true
      kiloChild = null
      // If Kilo exited in the middle of writing a line (no trailing newline),
      // the last piece of output is sitting in stderrRemainder — flush it into
      // the tail so it shows up in the error. Apply the same cap as normal
      // line handling so a partial line can still trigger a shift.
      if (stderrRemainder) {
        stderrTail.push(stderrRemainder)
        if (stderrTail.length > STDERR_TAIL_LIMIT) stderrTail.shift()
        stderrRemainder = ""
      }
      // Include the last stderr lines so config validation errors (like
      // "Invalid input mcp.memory" from an opencode.json with unsupported keys)
      // are immediately visible without requiring LOG_LEVEL=debug.
      const tail = stderrTail.join("\n").trim()
      const detail = tail ? `: ${tail}` : ""
      reject(new Error(`kilo serve exited unexpectedly (code=${code}, signal=${signal})${detail}`))
    }

    child.once("error", onError)
    child.once("exit", onEarlyExit)

    const poll = async () => {
      // Readiness probe: poll /session/status until 2xx or 30s timeout.
      // Use performance.now() for monotonic timing to avoid wall-clock skew.
      const timeoutMs = 30_000
      const startTime = performance.now()

      while (!cancelled && performance.now() - startTime < timeoutMs) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/session/status`, {
            signal: AbortSignal.timeout(2000),
          })
          if (res.ok) {
            child.removeListener("error", onError)
            child.removeListener("exit", onEarlyExit)
            resolve({ pid: child.pid, baseUrl: `http://127.0.0.1:${port}` })
            return
          }
        } catch {
          // Not ready yet — keep polling.
        }
        await sleep(200)
      }

      if (cancelled) return

      // Timeout: kill the process and report clearly.
      child.removeListener("error", onError)
      child.removeListener("exit", onEarlyExit)
      child.kill("SIGKILL")
      kiloChild = null
      reject(new Error(`kilo serve did not become ready within ${timeoutMs}ms on port ${port}`))
    }

    // Any unexpected throw inside poll() is forwarded to reject() as well.
    poll().catch(reject)
  })
}

/**
 * Gracefully terminate the spawned kilo serve process.
 * SIGTERM → wait gracePeriodMs → SIGKILL.
 * No-op if startKiloServer was never called or already stopped.
 *
 * @param {{ gracePeriodMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function stopKiloServer({ gracePeriodMs = 5000 } = {}) {
  const child = kiloChild
  if (!child) return
  kiloChild = null

  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once("exit", resolve))

  child.kill("SIGTERM")

  const timer = setTimeout(() => {
    child.kill("SIGKILL")
  }, gracePeriodMs)

  await exited
  clearTimeout(timer)
}
