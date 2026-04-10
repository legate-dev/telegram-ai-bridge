import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { config } from "../config.js"
import { log } from "../log.js"
import { sanitizedEnv, resolveExecCwd } from "./shared.js"

// ── Claude Code Backend ──
//
// Uses --input-format stream-json / --output-format stream-json so that each
// sendMessage() spawns a long-lived interactive process, sends one user message
// on stdin, streams events via AsyncGenerator, then closes stdin after the
// `result` event so the process exits cleanly.
//
// Permission modes (controlled by BRIDGE_CLAUDE_DANGEROUS_SKIP_PERMISSIONS):
//   true  (default) — --permission-mode bypassPermissions  →  all tools auto-approved (yolo)
//   false           — --permission-prompt-tool stdio        →  permission events surface via Telegram

/**
 * Human-readable summary of a Claude tool's input parameters.
 * @param {string} toolName
 * @param {object} input
 * @returns {string}
 */
function summarizeInput(toolName, input) {
  if (!input || typeof input !== "object") return ""
  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
      return input.file_path ?? ""
    case "Bash":
      return (input.command ?? "").slice(0, 200)
    case "Grep":
      return input.pattern ?? ""
    case "Glob":
      return input.pattern ?? input.glob_pattern ?? ""
    case "WebFetch":
    case "WebSearch":
      return input.url ?? input.query ?? ""
    default:
      try { return JSON.stringify(input).slice(0, 200) } catch { return "" }
  }
}

/**
 * Parse the questions array from an AskUserQuestion tool input.
 * @param {object} input
 * @returns {Array<{question: string, header: string, multiple: boolean, options: Array}>}
 */
function parseUserQuestions(input) {
  const raw = input?.questions
  if (!Array.isArray(raw)) return []
  return raw
    .filter((q) => q?.question)
    .map((q) => ({
      question: q.question,
      header: q.header ?? "",
      multiple: q.multiSelect ?? false,
      options: Array.isArray(q.options)
        ? q.options.map((o) => ({ label: o.label ?? "", description: o.description ?? "" }))
        : [],
    }))
}

export class ClaudeBackend {
  constructor() {
    this.name = "claude"
    this.supported = false
    /** @type {import("node:child_process").ChildProcess | null} */
    this._activeTurnProcess = null
  }

  /**
   * Send a message to Claude and stream events via AsyncGenerator.
   *
   * Yields:
   *   { type: "text",       content: string }
   *   { type: "thinking",   content: string }
   *   { type: "tool_use",   toolName: string, toolInput: string }
   *   { type: "permission", requestId: string, toolName: string, toolInput: string, toolInputRaw: object }
   *   { type: "question",   requestId: string, questions: Array }
   *   { type: "result",     sessionId: string, inputTokens: number, outputTokens: number }
   *   { type: "error",      message: string }
   *
   * Permission events naturally pause the generator — Claude blocks on stdin until
   * replyPermission() writes a control_response, then the loop resumes.
   *
   * @param {{ sessionId: string, directory: string, text: string, model?: string }} opts
   */
  async *sendMessage({ sessionId, directory, text, model }) {
    const cwdResult = resolveExecCwd("claude", directory)
    if (cwdResult.error) {
      yield { type: "error", message: cwdResult.error }
      return
    }

    const args = [
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
    ]

    if (config.claudeDangerousSkipPermissions) {
      args.push("--permission-mode", "bypassPermissions")
    } else {
      args.push("--permission-prompt-tool", "stdio")
    }

    // Resume a known session. Skip placeholder IDs (claude-<timestamp>) assigned
    // by createSession() for new sessions before Claude confirms the real session_id.
    if (sessionId && !sessionId.startsWith("claude-")) {
      args.push("--resume", sessionId)
    }

    if (model) args.push("--model", model)

    log.info("claude.backend", "exec.start", {
      cli: "claude",
      session_id: sessionId,
      directory,
      text_length: text.length,
      dangerous_skip: config.claudeDangerousSkipPermissions,
    })

    const proc = spawn(config.binClaude, args, {
      cwd: cwdResult.cwd,
      env: sanitizedEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })

    // NOTE: _activeTurnProcess is a single field on this singleton instance.
    // inFlightChats prevents concurrent turns from the same chat, but two different
    // chat IDs could theoretically race here. With TELEGRAM_ALLOWED_USER_ID limiting
    // access to one user, concurrent multi-chat usage is unlikely in practice.
    // If multi-chat support is added, replace with a Map<chatKey, ChildProcess>.
    this._activeTurnProcess = proc

    // Suppress async EPIPE and other stream errors on stdin.
    // These occur when Claude exits while we attempt a late write (e.g. replyPermission
    // after TTL expiry killed the process). Without this handler the error propagates
    // as an uncaughtException and crashes the bridge.
    proc.stdin.on("error", (err) => {
      log.debug("claude.backend", "stdin.error", {
        cli: "claude",
        session_id: sessionId,
        error: String(err),
      })
    })

    // Send the user message as the first stdin line.
    proc.stdin.write(
      JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n",
    )

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
    const stderrChunks = []
    proc.stderr.on("data", (chunk) => stderrChunks.push(chunk))

    const timeoutId = setTimeout(() => {
      log.warn("claude.backend", "exec.timeout", {
        cli: "claude",
        session_id: sessionId,
        persist: true,
      })
      if (!proc.killed) proc.kill("SIGTERM")
    }, config.claudeTimeoutMs)

    let hadResult = false

    try {
      for await (const line of rl) {
        if (!line.trim()) continue

        let raw
        try {
          raw = JSON.parse(line)
        } catch {
          log.debug("claude.backend", "stream.non_json", { snippet: line.slice(0, 120) })
          continue
        }

        const eventType = raw.type
        log.debug("claude.backend", "stream.event", { type: eventType })

        if (eventType === "system") {
          // session_id is captured again from the result event; just log here.
          continue
        }

        if (eventType === "assistant") {
          const content = raw.message?.content
          if (!Array.isArray(content)) continue
          for (const block of content) {
            if (block?.type === "text" && block.text) {
              yield { type: "text", content: block.text }
            } else if (block?.type === "thinking" && block.thinking) {
              yield { type: "thinking", content: block.thinking }
            } else if (block?.type === "tool_use" && block.name !== "AskUserQuestion") {
              yield {
                type: "tool_use",
                toolName: block.name,
                toolInput: summarizeInput(block.name, block.input),
              }
            }
          }
          continue
        }

        if (eventType === "result") {
          hadResult = true
          yield {
            type: "result",
            sessionId: raw.session_id ?? sessionId,
            inputTokens: raw.usage?.input_tokens ?? 0,
            outputTokens: raw.usage?.output_tokens ?? 0,
          }
          // Close stdin — Claude exits gracefully on EOF.
          proc.stdin.end()
          return
        }

        if (eventType === "control_request") {
          const request = raw.request
          if (request?.subtype !== "can_use_tool") continue

          const requestId = raw.request_id
          const toolName = request.tool_name
          const input = request.input ?? {}

          if (toolName === "AskUserQuestion") {
            yield { type: "question", requestId, questions: parseUserQuestions(input) }
          } else {
            yield {
              type: "permission",
              requestId,
              toolName,
              toolInput: summarizeInput(toolName, input),
              toolInputRaw: input,
            }
          }
          // Generator suspends here — Claude is blocked on stdin awaiting control_response.
          // replyPermission() writes the response; Claude resumes and the loop continues.
          continue
        }

        // control_cancel_request and unknown events — ignore
      }

      // stdout closed without a result event (crash, timeout, early exit)
      if (!hadResult) {
        const stderr = Buffer.concat(stderrChunks).toString().trim()
        log.warn("claude.backend", "exec.no_result", {
          cli: "claude",
          session_id: sessionId,
          stderr: stderr.slice(0, 500),
          persist: true,
        })
        yield { type: "error", message: stderr || "Claude Code exited without producing a result" }
      }
    } finally {
      clearTimeout(timeoutId)
      this._activeTurnProcess = null
      rl.close()
      if (!proc.killed) proc.kill("SIGTERM")
    }
  }

  /**
   * Write a control_response to Claude's stdin.
   * Called by the perm: callback handler after the user taps Allow/Deny.
   *
   * @param {string} requestId
   * @param {"allow"|"deny"} behavior
   */
  replyPermission(requestId, behavior) {
    if (!this._activeTurnProcess) {
      log.warn("claude.backend", "reply_permission.no_active_turn", { request_id: requestId })
      return
    }
    const response = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: behavior === "allow"
          ? { behavior: "allow", updatedInput: {} }
          : { behavior: "deny", message: "The user denied this tool use. Stop and wait for instructions." },
      },
    }
    try {
      this._activeTurnProcess.stdin.write(JSON.stringify(response) + "\n")
    } catch (err) {
      log.warn("claude.backend", "reply_permission.write_failed", {
        request_id: requestId,
        error: String(err),
      })
    }
  }

  async createSession({ title, directory }) {
    // Claude sessions are created implicitly on first run. Return a placeholder ID
    // that is replaced with the real session_id once the first turn yields a "result" event.
    return { id: `claude-${Date.now()}`, title, directory }
  }

  async abortSession() {
    if (this._activeTurnProcess && !this._activeTurnProcess.killed) {
      this._activeTurnProcess.kill("SIGTERM")
      this._activeTurnProcess = null
    }
  }

  async getSessionStatus() {
    return null
  }
}
