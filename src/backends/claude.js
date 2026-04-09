import { execFile } from "node:child_process"
import { config } from "../config.js"
import { log } from "../log.js"
import { sanitizedEnv, resolveExecCwd } from "./shared.js"

// ── Claude Code Backend ──

export class ClaudeBackend {
  constructor() {
    this.name = "claude"
    this.supported = false
  }

  sendMessage({ sessionId, directory, text, model }) {
    return new Promise((resolve) => {
      const cwdResult = resolveExecCwd("claude", directory)
      if (cwdResult.error) {
        resolve({ error: cwdResult.error })
        return
      }

      const args = [
        "-p", text,
        "--output-format", "json",
        "--permission-mode", "bypassPermissions",
        ...(sessionId && !sessionId.startsWith("claude-") ? ["-r", sessionId] : []),
        ...(model ? ["--model", model] : []),
      ]

      const startedAt = Date.now()
      log.info("claude.backend", "exec.start", { cli: "claude", session_id: sessionId, directory, text_length: text.length })
      execFile(config.binClaude, args, {
        cwd: cwdResult.cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: config.claudeTimeoutMs,
        env: sanitizedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, (error, stdout, stderr) => {
        if (error && (error.killed || error.signal || !stdout)) {
          const reason = (error.killed || error.signal)
            ? `Claude Code timed out or was killed (${error.signal || "timeout"})`
            : `Claude Code failed${error.code != null ? ` (exit code: ${error.code})` : ""}`
          log.warn("claude.backend", "exec.failed", { cli: "claude", session_id: sessionId, latency_ms: Date.now() - startedAt, exit_code: error.code, signal: error.signal, stderr_length: stderr?.length || 0, persist: true })
          resolve({ error: reason })
          return
        }
        log.info("claude.backend", "exec.success", { cli: "claude", session_id: sessionId, latency_ms: Date.now() - startedAt, stdout_length: stdout?.length || 0, stderr_length: stderr?.length || 0 })

        const textParts = []
        let detectedSessionId = null
        const events = []
        const trimmedStdout = stdout.trim()
        let lineParseFailures = 0

        try {
          const parsed = JSON.parse(trimmedStdout)
          if (Array.isArray(parsed)) {
            events.push(...parsed)
          } else if (parsed && typeof parsed === "object") {
            events.push(parsed)
          }
        } catch (parseError) {
          if (trimmedStdout) {
            log.debug("claude.backend", "response.full_json_parse_failed", {
              cli: "claude",
              session_id: sessionId,
              stdout_length: trimmedStdout.length,
              message: parseError.message,
            })
          }
        }

        if (!events.length) {
          for (const line of stdout.split("\n").filter(Boolean)) {
            try {
              const parsed = JSON.parse(line)
              if (Array.isArray(parsed)) {
                events.push(...parsed)
              } else if (parsed && typeof parsed === "object") {
                events.push(parsed)
              }
            } catch {
              lineParseFailures += 1
            }
          }
        }

        if (!events.length && lineParseFailures) {
          log.debug("claude.backend", "response.line_json_parse_failed", {
            cli: "claude",
            session_id: sessionId,
            line_parse_failures: lineParseFailures,
          })
        }

        for (const event of events) {
          if (event.type === "system" && event.session_id) {
            detectedSessionId = event.session_id
          }

          if (event.type === "assistant" && Array.isArray(event.message?.content)) {
            for (const block of event.message.content) {
              if (block?.type === "text" && block.text) {
                textParts.push(block.text)
              }
            }
          }

          if (event.type === "result") {
            if (event.session_id) detectedSessionId = event.session_id
            if (event.is_error && event.result) {
              textParts.length = 0
              textParts.push(`Error: ${event.result}`)
            } else if (!event.is_error && event.result && !textParts.length) {
              textParts.push(event.result)
            }
          }
        }

        if (!events.length && trimmedStdout) {
          log.warn("claude.backend", "response.unparsed_stdout", {
            cli: "claude",
            session_id: sessionId,
            stdout_length: trimmedStdout.length,
            stderr_length: stderr?.length || 0,
            persist: true,
          })
        }

        const reply = textParts.join("\n\n")
        resolve(reply ? { text: reply, threadId: detectedSessionId } : { error: "Claude Code returned no text" })
      })
    })
  }

  async createSession({ title, directory }) {
    return { id: `claude-${Date.now()}`, title, directory }
  }

  async abortSession() {}

  async getSessionStatus() {
    return null
  }
}
