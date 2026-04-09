import { execFile } from "node:child_process"
import { config } from "../config.js"
import { log } from "../log.js"
import { sanitizedEnv, resolveExecCwd } from "./shared.js"

// ── Copilot Backend ──

export class CopilotBackend {
  constructor() {
    this.name = "copilot"
    this.supported = false
  }

  sendMessage({ sessionId, directory, text }) {
    return new Promise((resolve) => {
      const cwdResult = resolveExecCwd("copilot", directory)
      if (cwdResult.error) {
        resolve({ error: cwdResult.error })
        return
      }

      const args = [
        ...(sessionId && !sessionId.startsWith("copilot-") ? [`--resume=${sessionId}`] : []),
        "-p", text,
        "--output-format", "json",
        ...(config.copilotAllowAllTools ? ["--allow-all-tools"] : []),
      ]

      const startedAt = Date.now()
      log.info("copilot.backend", "exec.start", { cli: "copilot", session_id: sessionId, directory, text_length: text.length })
      const child = execFile(config.binCopilot, args, {
        cwd: cwdResult.cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: config.copilotTimeoutMs,
        env: sanitizedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, (error, stdout, stderr) => {
        if (error && (error.killed || error.signal || !stdout)) {
          const reason = (error.killed || error.signal)
            ? `Copilot timed out or was killed (${error.signal || "timeout"})`
            : `Copilot failed${error.code !== undefined ? ` (exit code ${error.code})` : ""}`
          log.warn("copilot.backend", "exec.failed", { cli: "copilot", session_id: sessionId, latency_ms: Date.now() - startedAt, exit_code: error.code, signal: error.signal, stderr_length: stderr?.length || 0, persist: true })
          resolve({ error: reason })
          return
        }
        log.info("copilot.backend", "exec.success", { cli: "copilot", session_id: sessionId, latency_ms: Date.now() - startedAt, stdout_length: stdout?.length || 0, stderr_length: stderr?.length || 0 })

        const textParts = []
        let detectedSessionId = null
        let turnError = null

        for (const line of stdout.split("\n").filter(Boolean)) {
          try {
            const event = JSON.parse(line)
            if (event.type === "assistant.message" && event.data?.content) {
              textParts.push(event.data.content)
            }
            if (event.type === "result" && event.sessionId) {
              detectedSessionId = event.sessionId
            }
            if (event.type === "assistant.turn_end" && event.data?.error) {
              turnError = event.data.error
            }
            if (event.type === "error") {
              turnError = event.data?.message || event.message || "Unknown error"
            }
          } catch {}
        }

        if (turnError && !textParts.length) {
          resolve({ error: `Copilot error: ${turnError}` })
          return
        }

        const reply = textParts.join("\n\n")
        resolve(reply ? { text: reply, threadId: detectedSessionId } : { error: "Copilot returned no text" })
      })
    })
  }

  async createSession({ title, directory }) {
    return { id: `copilot-${Date.now()}`, title, directory }
  }

  async abortSession() {}

  async getSessionStatus() {
    return null
  }
}
