import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { config } from "../config.js"
import { log } from "../log.js"
import { sanitizedEnv, resolveExecCwd } from "./shared.js"

// ── Gemini CLI Backend ──
//
// Uses --output-format stream-json for real-time event streaming.
// Each sendMessage() spawns a new per-turn process — Gemini does not have
// a bidirectional stdin protocol, so no long-lived process is needed.
//
// Permissions are auto-approved via -y. Interactive permission handling is
// not available for Gemini CLI (RespondPermission is a no-op in cc-connect).
// TODO: expose BRIDGE_GEMINI_APPROVAL_MODE (yolo|auto_edit|plan) in Phase 1.2.

/**
 * Human-readable summary of a Gemini tool's parameters.
 * @param {string} toolName
 * @param {object} params
 * @returns {string}
 */
function summarizeToolParams(toolName, params) {
  if (!params || typeof params !== "object") return ""
  switch (toolName) {
    case "shell":
    case "run_shell_command":
      return (params.command ?? "").slice(0, 200)
    case "write_file":
    case "WriteFile":
    case "replace":
    case "ReplaceInFile":
    case "read_file":
    case "ReadFile":
      return params.file_path ?? params.path ?? ""
    case "list_directory":
    case "ListDirectory":
      return params.dir_path ?? params.path ?? params.directory ?? ""
    case "web_fetch":
    case "WebFetch":
      return params.url ?? params.prompt ?? ""
    case "google_web_search":
      return params.query ?? ""
    case "search_code":
    case "glob":
    case "grep_search":
      return params.pattern ?? params.query ?? ""
    default:
      try { return JSON.stringify(params).slice(0, 200) } catch { return "" }
  }
}

export class GeminiBackend {
  constructor() {
    this.name = "gemini"
    this.supported = false
  }

  /**
   * Send a message to Gemini and stream events via AsyncGenerator.
   *
   * Yields:
   *   { type: "text",     text: string }
   *   { type: "tool_use", toolName: string, toolInput: string }
   *   { type: "result",   sessionId: string, inputTokens: number, outputTokens: number }
   *   { type: "error",    message: string }  — terminal; generator ends after this
   *
   * Gemini emits two kinds of assistant messages:
   *   delta:true  — incremental fragment → yield { type:"text" } immediately
   *   delta:false — complete message; classify at end of turn:
   *                   before tool_use → discard (planning/reasoning, not user-facing)
   *                   before result   → yield as final text
   *
   * @param {{ sessionId: string, directory: string, text: string }} opts
   */
  async *sendMessage({ sessionId, directory, text }) {
    const cwdResult = resolveExecCwd("gemini", directory)
    if (cwdResult.error) {
      yield { type: "error", message: cwdResult.error }
      return
    }

    // Arg order matches cc-connect: flags → resume → model → -p prompt (last)
    const args = [
      "--output-format", "stream-json",
      "-y",
    ]

    // Skip placeholder IDs (gemini-<timestamp>) created by createSession()
    if (sessionId && !sessionId.startsWith("gemini-")) {
      args.push("-r", sessionId)
    }

    // Model selection for Gemini is not currently supported (API_CONTRACT.md).
    // Accept it from opts for forward-compatibility but do not pass it yet.

    args.push("-p", text)

    log.info("gemini.backend", "exec.start", {
      cli: "gemini",
      session_id: sessionId,
      directory,
      text_length: text.length,
    })

    const proc = spawn(config.binGemini, args, {
      cwd: cwdResult.cwd,
      env: sanitizedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    })

    // Capture spawn errors (e.g. ENOENT when binary is missing).
    // Without this handler Node.js would treat it as an uncaught exception.
    let spawnError = null
    proc.on("error", (err) => { spawnError = err })

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })

    // Collect stderr via a Promise so we can await it after the readline loop
    // ends, avoiding a race where stderrChunks is read before the data events fire.
    const stderrPromise = new Promise((resolve) => {
      const chunks = []
      proc.stderr.on("data", (chunk) => chunks.push(chunk))
      proc.stderr.on("end", () => resolve(Buffer.concat(chunks).toString().trim()))
      proc.stderr.on("error", () => resolve(""))
    })

    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      log.warn("gemini.backend", "exec.timeout", {
        cli: "gemini",
        session_id: sessionId,
        persist: true,
      })
      if (!proc.killed) proc.kill("SIGTERM")
    }, config.geminiTimeoutMs)

    // Buffer non-delta complete messages for end-of-turn classification.
    const pendingMsgs = []
    let detectedSessionId = null
    let hadResult = false

    try {
      for await (const line of rl) {
        if (!line.trim()) continue

        let raw
        try {
          raw = JSON.parse(line)
        } catch {
          log.debug("gemini.backend", "stream.non_json", { snippet: line.slice(0, 120) })
          continue
        }

        const eventType = raw.type
        log.debug("gemini.backend", "stream.event", { type: eventType })

        if (eventType === "init") {
          if (raw.session_id) detectedSessionId = raw.session_id
          continue
        }

        if (eventType === "message") {
          const content = raw.content ?? ""
          if (raw.role === "user" || !content) continue

          if (raw.delta === true) {
            yield { type: "text", text: content }
          } else {
            pendingMsgs.push(content)
          }
          continue
        }

        if (eventType === "tool_use") {
          // Pre-tool buffered messages are planning/reasoning — discard silently
          pendingMsgs.length = 0
          yield {
            type: "tool_use",
            toolName: raw.tool_name ?? "",
            toolInput: summarizeToolParams(raw.tool_name ?? "", raw.parameters ?? {}),
          }
          continue
        }

        if (eventType === "tool_result") {
          log.debug("gemini.backend", "stream.tool_result", {
            tool_id: raw.tool_id,
            status: raw.status,
          })
          continue
        }

        if (eventType === "error") {
          const message = raw.message ?? "Gemini reported an error"
          log.warn("gemini.backend", "stream.error_event", {
            cli: "gemini",
            session_id: sessionId,
            severity: raw.severity ?? "ERROR",
            message,
            persist: true,
          })
          yield { type: "error", message }
          return
        }

        if (eventType === "result") {
          hadResult = true

          if (raw.status === "error") {
            yield { type: "error", message: raw.error?.message ?? "Gemini turn failed" }
            return
          }

          // Flush buffered non-delta messages as the final assistant text
          if (pendingMsgs.length) {
            const accumulated = pendingMsgs.join("")
            pendingMsgs.length = 0
            if (accumulated) yield { type: "text", text: accumulated }
          }

          if (raw.session_id) detectedSessionId = raw.session_id

          yield {
            type: "result",
            sessionId: detectedSessionId ?? sessionId,
            inputTokens: raw.stats?.input_token_count ?? 0,
            outputTokens: raw.stats?.output_token_count ?? 0,
          }
          return
        }
      }

      // stdout closed without a result event (crash / timeout / SIGTERM / spawn error)
      if (!hadResult) {
        if (spawnError) {
          yield { type: "error", message: `Gemini failed to start: ${spawnError.message}` }
          return
        }
        if (timedOut) {
          yield { type: "error", message: `Gemini timed out (${config.geminiTimeoutMs}ms)` }
          return
        }
        // Await the promise so all stderr data is flushed before we read it
        const stderr = await stderrPromise
        if (stderr.includes("exhausted your capacity")) {
          yield { type: "error", message: "Gemini quota exhausted. Try again shortly." }
          return
        }
        log.warn("gemini.backend", "exec.no_result", {
          cli: "gemini",
          session_id: sessionId,
          stderr: stderr.slice(0, 500),
          persist: true,
        })
        yield { type: "error", message: stderr || "Gemini exited without producing a result" }
      }
    } finally {
      clearTimeout(timeoutId)
      rl.close()
      if (!proc.killed) proc.kill("SIGTERM")
    }
  }

  async createSession({ title, directory }) {
    return { id: `gemini-${Date.now()}`, title, directory }
  }

  async abortSession() {}

  async getSessionStatus() {
    return null
  }
}
