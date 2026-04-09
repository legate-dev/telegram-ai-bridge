import { execFile } from "node:child_process"
import { config } from "../config.js"
import { log } from "../log.js"
import { sanitizedEnv, resolveExecCwd } from "./shared.js"

// ── Gemini Backend ──

export class GeminiBackend {
  constructor() {
    this.name = "gemini"
    this.supported = false
  }

  sendMessage({ sessionId, directory, text }) {
    return new Promise((resolve) => {
      const cwdResult = resolveExecCwd("gemini", directory)
      if (cwdResult.error) {
        resolve({ error: cwdResult.error })
        return
      }

      const args = [
        "-p", text,
        "-o", "json",
        "-y",
        ...(sessionId && !sessionId.startsWith("gemini-") ? ["-r", sessionId] : []),
      ]

      const startedAt = Date.now()
      log.info("gemini.backend", "exec.start", { cli: "gemini", session_id: sessionId, directory, text_length: text.length })
      const child = execFile(config.binGemini, args, {
        cwd: cwdResult.cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: config.geminiTimeoutMs,
        env: sanitizedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, (error, stdout, stderr) => {
        if (error && (error.killed || error.signal || !stdout)) {
          if (error.killed || error.signal) {
            log.warn("gemini.backend", "exec.failed", { cli: "gemini", session_id: sessionId, latency_ms: Date.now() - startedAt, exit_code: error.code, signal: error.signal, stderr_length: stderr?.length || 0, persist: true })
            resolve({ error: `Gemini timed out or was killed (${error.signal || "timeout"})` })
            return
          }
          // Check for quota errors in stderr
          if (stderr?.includes("exhausted your capacity")) {
            resolve({ error: "Gemini quota exhausted. Try again shortly." })
            return
          }
          log.warn("gemini.backend", "exec.failed", { cli: "gemini", session_id: sessionId, latency_ms: Date.now() - startedAt, exit_code: error.code, signal: error.signal, stderr_length: stderr?.length || 0, persist: true })
          resolve({ error: `Gemini failed${error.code !== undefined ? ` (exit code ${error.code})` : ""}` })
          return
        }
        log.info("gemini.backend", "exec.success", { cli: "gemini", session_id: sessionId, latency_ms: Date.now() - startedAt, stdout_length: stdout?.length || 0, stderr_length: stderr?.length || 0 })

        // Gemini -o json outputs a single JSON object with { response, session_id, stats }
        const textParts = []
        let detectedSessionId = null
        const trimmedStdout = stdout.trim()
        let lineParseFailures = 0

        try {
          const singleEvent = JSON.parse(trimmedStdout)
          if (singleEvent?.response && typeof singleEvent.response === "string") {
            textParts.push(singleEvent.response)
            if (singleEvent.session_id) detectedSessionId = singleEvent.session_id
          } else if (singleEvent?.content && typeof singleEvent.content === "string") {
            textParts.push(singleEvent.content)
            if (singleEvent.session_id) detectedSessionId = singleEvent.session_id
          } else if (singleEvent?.text && typeof singleEvent.text === "string") {
            textParts.push(singleEvent.text)
            if (singleEvent.session_id) detectedSessionId = singleEvent.session_id
          }
        } catch (parseError) {
          if (trimmedStdout) {
            log.debug("gemini.backend", "response.full_json_parse_failed", {
              cli: "gemini",
              session_id: sessionId,
              stdout_length: trimmedStdout.length,
              message: parseError.message,
            })
          }
        }

        for (const line of stdout.split("\n").filter(Boolean)) {
          if (textParts.length) break
          try {
            const event = JSON.parse(line)
            // Primary format: { response: "...", session_id: "..." }
            if (event.response && typeof event.response === "string") {
              textParts.push(event.response)
              if (event.session_id) detectedSessionId = event.session_id
            }
            // Fallback: content or text field
            if (!textParts.length && event.content && typeof event.content === "string") {
              textParts.push(event.content)
              if (event.session_id) detectedSessionId = event.session_id
            }
            if (!textParts.length && event.text && typeof event.text === "string") {
              textParts.push(event.text)
              if (event.session_id) detectedSessionId = event.session_id
            }
          } catch {
            lineParseFailures += 1
          }
        }

        if (!textParts.length && lineParseFailures) {
          log.debug("gemini.backend", "response.line_json_parse_failed", {
            cli: "gemini",
            session_id: sessionId,
            line_parse_failures: lineParseFailures,
          })
        }

        // Last resort: if no JSON parsed, treat entire stdout as text
        if (!textParts.length && trimmedStdout) {
          log.warn("gemini.backend", "response.raw_stdout_fallback", {
            cli: "gemini",
            session_id: sessionId,
            stdout_length: trimmedStdout.length,
            stderr_length: stderr?.length || 0,
            persist: true,
          })
          textParts.push(trimmedStdout)
        }

        const reply = textParts.join("\n\n")
        resolve(reply ? { text: reply, threadId: detectedSessionId } : { error: "Gemini returned no text" })
      })
    })
  }

  async createSession({ title, directory }) {
    return { id: `gemini-${Date.now()}`, title, directory }
  }

  async abortSession() {}

  async getSessionStatus() {
    return null
  }
}
