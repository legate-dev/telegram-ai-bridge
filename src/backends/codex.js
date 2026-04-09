import { execFile } from "node:child_process"
import { config } from "../config.js"
import { log } from "../log.js"
import { sanitizedEnv, resolveExecCwd } from "./shared.js"

// ── Codex Backend ──

export class CodexBackend {
  constructor() {
    this.name = "codex"
    this.supported = false
  }

  sendMessage({ sessionId, directory, text, model }) {
    return new Promise((resolve) => {
      const cwdResult = resolveExecCwd("codex", directory)
      if (cwdResult.error) {
        resolve({ error: cwdResult.error })
        return
      }

      // Build args: resume existing session or exec fresh
      const modelArgs = model ? ["-m", model] : []
      const args = sessionId
        ? ["exec", "resume", sessionId, "--json", "--skip-git-repo-check", ...modelArgs, text]
        : ["exec", "--json", "--skip-git-repo-check", ...modelArgs, text]

      const startedAt = Date.now()
      log.info("codex.backend", "exec.start", { cli: "codex", session_id: sessionId, directory, text_length: text.length })
      execFile(config.binCodex, args, {
        cwd: cwdResult.cwd,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        timeout: config.codexTimeoutMs,
        env: sanitizedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, (error, stdout, stderr) => {
        if (error && (error.killed || error.signal || !stdout)) {
          const exitCode = error.code ?? "unknown"
          const termination = error.signal || (error.killed ? "killed" : "timeout")
          const reason = (error.killed || error.signal)
            ? `Codex timed out or was killed (${termination}, exit code ${exitCode})`
            : `Codex exec failed (exit code ${exitCode})`
          log.warn("codex.backend", "exec.failed", { cli: "codex", session_id: sessionId, latency_ms: Date.now() - startedAt, exit_code: error.code, signal: error.signal, stderr_length: stderr?.length || 0, persist: true })
          resolve({ error: reason })
          return
        }
        log.info("codex.backend", "exec.success", { cli: "codex", session_id: sessionId, latency_ms: Date.now() - startedAt, stdout_length: stdout?.length || 0, stderr_length: stderr?.length || 0 })

        // Parse JSONL output — extract agent_message text
        const textParts = []
        let threadId = null
        let turnError = null

        for (const line of stdout.split("\n").filter(Boolean)) {
          try {
            const event = JSON.parse(line)
            if (event.type === "thread.started") {
              threadId = event.thread_id
            }
            if (event.type === "item.completed" && event.item?.type === "agent_message") {
              if (event.item.text) textParts.push(event.item.text)
            }
            if (event.type === "turn.failed") {
              turnError = event.error?.message || "Turn failed"
            }
            if (event.type === "error" && !event.item) {
              turnError = event.message || "Unknown error"
            }
          } catch {
            // skip malformed lines
          }
        }

        if (turnError && !textParts.length) {
          resolve({ error: `Codex error: ${turnError}` })
          return
        }

        const reply = textParts.join("\n\n")
        resolve(reply ? { text: reply, threadId } : { error: "Codex returned no text" })
      })
    })
  }

  // Codex doesn't have explicit session creation — sessions are created on first exec
  async createSession({ title, directory }) {
    return { id: `codex-${Date.now()}`, title, directory }
  }

  async abortSession() {
    // Codex exec processes are ephemeral — nothing to abort
  }

  async getSessionStatus() {
    return null
  }
}
