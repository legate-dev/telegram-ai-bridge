import { execFile, execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import { config } from "./config.js"
import { extractAssistantText, extractMessageError } from "./format.js"
import { log } from "./log.js"

// Strip bridge-owned secrets from env before passing to CLI subprocesses.
//
// What this DOES:
//   Removes the 4 secrets that belong to the bridge itself (Telegram bot
//   token, allowed user ID, Kilo HTTP credentials). These are useless to
//   the CLIs and have no business reaching them.
//
// What this DOES NOT do:
//   It does NOT sandbox the env. Provider API keys (OPENAI_API_KEY,
//   ANTHROPIC_API_KEY, GITHUB_TOKEN, GEMINI_API_KEY, etc.) and any other
//   shell environment variable are forwarded as-is. This is INTENTIONAL:
//
//   1. CLIs (Codex, Claude, Copilot, Gemini) manage their own credentials
//      via their own auth files (~/.codex, ~/.claude, etc.) or env vars,
//      depending on user setup. The bridge has no business filtering or
//      mediating provider credentials — they belong to the CLIs.
//
//   2. The trust boundary is the Telegram bot token. With --allow-all-tools
//      and --permission-mode bypassPermissions enabled, anyone holding the
//      token has shell access to the host via the CLI tool calls. Filtering
//      env vars adds zero defense against this — an attacker can simply
//      ask the CLI to `cat ~/.zshrc` or read auth files directly.
//
// See SECURITY.md "Threat model" and DECISION_LOG.md "Security hardening
// roadmap" for the full reasoning.
const REDACTED_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_ID",
  "KILO_SERVER_PASSWORD",
  "KILO_SERVER_USERNAME",
])

function sanitizedEnv() {
  const env = { ...process.env }
  for (const key of REDACTED_KEYS) delete env[key]
  return env
}

function resolveExecCwd(cli, directory) {
  const cwd = directory || process.cwd()
  let statError = null

  try {
    if (statSync(cwd).isDirectory()) return { cwd }
  } catch (error) {
    statError = error
  }

  const errorCode = statError?.code ? ` (${statError.code})` : ""
  const reason = statError?.code === "ENOENT"
    ? "Workspace path is missing"
    : statError
      ? "Workspace path is missing or inaccessible"
      : "Workspace path is missing or not a directory"
  const error = `${reason} for ${cli}: ${cwd}${errorCode}. Bind a live session in an existing repo or create a new one with /new.`
  log.warn(`${cli}.backend`, "exec.missing_cwd", {
    cli,
    directory: cwd,
    reason,
    error_code: statError?.code ?? null,
    persist: true,
  })
  return { error }
}

// ── Backend interface ──
// Every backend must implement:
//   sendMessage({ sessionId, directory, text, agent }) →
//     { text: string } | { error: string } | { question: { questions, precedingText } }
//   createSession({ title, directory }) → { id: string } | null
//   supported → boolean
//
// The { question } result is returned by KiloBackend when the AI calls
// mcp_question mid-turn. The caller should surface the question to the user
// and re-submit their answer as a new turn.

// ── Kilo Backend ──

export class KiloBackend {
  constructor(kiloClient) {
    this.kilo = kiloClient
    this.name = "kilo"
    this.supported = true // Kilo is HTTP-based; always available if configured
  }

  async sendMessage({ sessionId, directory, text, agent }) {
    // Auto-abort if session is stuck in busy state from a previous turn
    try {
      const status = await this.kilo.getSessionStatus(sessionId)
      if (status?.type === "busy") {
        log.warn("kilo.backend", "session.busy_detected", {
          cli: "kilo",
          session_id: sessionId,
          directory,
          agent,
        })
        try {
          await this.kilo.abortSession(sessionId)
          log.info("kilo.backend", "session.abort_requested", {
            cli: "kilo",
            session_id: sessionId,
          })
        } catch (error) {
          log.warn("kilo.backend", "session.abort_failed", {
            cli: "kilo",
            session_id: sessionId,
            error,
            persist: true,
          })
        }
        await new Promise((r) => setTimeout(r, 1000))
        const recheck = await this.kilo.getSessionStatus(sessionId)
        if (recheck?.type === "busy") {
          log.warn("kilo.backend", "session.still_busy_after_abort", {
            cli: "kilo",
            session_id: sessionId,
            persist: true,
          })
          return { error: "Session is stuck. Abort was attempted but it's still busy. Try /new to start fresh." }
        }
      }
    } catch (error) {
      log.warn("kilo.backend", "session.status_preflight_failed", {
        cli: "kilo",
        session_id: sessionId,
        error,
      })
    }

    // Count existing messages before submitting, so we know what's new.
    // If this fails, set to -1 so we know the count is unreliable.
    let messageCountBefore = -1
    try {
      const existingMessages = await this.kilo.getMessages(sessionId, directory)
      messageCountBefore = Array.isArray(existingMessages) ? existingMessages.length : -1
    } catch {
      // Count unavailable — we'll use last-assistant fallback only
    }

    // Submit asynchronously — returns immediately without blocking
    log.info("kilo.backend", "turn.submit_async", {
      cli: "kilo",
      session_id: sessionId,
      directory,
      agent,
      messages_before: messageCountBefore,
      persist: true,
    })

    await this.kilo.promptAsync({ sessionId, directory, text, agent })

    // Wait for turn completion via status polling.
    // Pass messageCountBefore to enable mid-turn question detection.
    const waitResult = await this.kilo.waitForTurn(sessionId, { messageCountBefore })

    log.info("kilo.backend", "turn.wait_completed", {
      cli: "kilo",
      session_id: sessionId,
      completed: waitResult.completed,
      reason: waitResult.reason,
      elapsed_ms: waitResult.elapsed,
      persist: true,
    })

    // Mid-turn question detected — abort the current turn (the question tool
    // can't receive results via HTTP API) and surface it to the user.
    // The conversation history already contains the question, so when the user
    // replies and we submit a new turn, the AI sees its question + the answer.
    if (waitResult.reason === "question_pending" && waitResult.question) {
      log.info("kilo.backend", "turn.question_abort", {
        cli: "kilo",
        session_id: sessionId,
        question_count: waitResult.question.questions?.length ?? 0,
        persist: true,
      })
      try {
        await this.kilo.abortSession(sessionId)
      } catch (error) {
        log.warn("kilo.backend", "turn.question_abort_failed", {
          cli: "kilo",
          session_id: sessionId,
          error,
        })
      }
      return { question: waitResult.question }
    }

    // Mid-turn permission request detected — do NOT abort the turn.
    // Kilo holds the turn server-side and resumes it once we POST a reply
    // to /permission/<id>/reply. Aborting would lose state.
    // Include messageCountBefore so the caller can resume polling via resumeTurn().
    if (waitResult.reason === "permission_pending" && waitResult.permission) {
      log.info("kilo.backend", "turn.permission_pending", {
        cli: "kilo",
        session_id: sessionId,
        request_id: waitResult.permission.id,
        permission: waitResult.permission.permission,
        persist: true,
      })
      return { permission: waitResult.permission, messageCountBefore }
    }

    return this._waitCompleteAndRetrieve(sessionId, directory, messageCountBefore, waitResult)
  }

  /**
   * Resume a Kilo turn that was paused for a permission request.
   * Called by the message-handler after the user has granted or denied the permission
   * (i.e., after POSTing to /permission/<id>/reply). Re-polls waitForTurn and
   * retrieves the assistant response exactly like the tail of sendMessage().
   *
   * Returns the same shapes as sendMessage(): { text }, { error }, or { permission, messageCountBefore }
   * for a nested permission request.
   */
  async resumeTurn(sessionId, directory, messageCountBefore) {
    const waitResult = await this.kilo.waitForTurn(sessionId, { messageCountBefore })

    log.info("kilo.backend", "turn.wait_completed", {
      cli: "kilo",
      session_id: sessionId,
      completed: waitResult.completed,
      reason: waitResult.reason,
      elapsed_ms: waitResult.elapsed,
      persist: true,
    })

    // A question arrived mid-resume — abort (same as sendMessage) and surface it.
    if (waitResult.reason === "question_pending" && waitResult.question) {
      log.info("kilo.backend", "turn.question_abort", {
        cli: "kilo",
        session_id: sessionId,
        question_count: waitResult.question.questions?.length ?? 0,
        persist: true,
      })
      try {
        await this.kilo.abortSession(sessionId)
      } catch (error) {
        log.warn("kilo.backend", "turn.question_abort_failed", {
          cli: "kilo",
          session_id: sessionId,
          error,
        })
      }
      return { question: waitResult.question }
    }

    // Nested permission — surface it via the same callback flow.
    if (waitResult.reason === "permission_pending" && waitResult.permission) {
      log.info("kilo.backend", "turn.permission_pending", {
        cli: "kilo",
        session_id: sessionId,
        request_id: waitResult.permission.id,
        permission: waitResult.permission.permission,
        persist: true,
      })
      return { permission: waitResult.permission, messageCountBefore }
    }

    return this._waitCompleteAndRetrieve(sessionId, directory, messageCountBefore, waitResult)
  }

  /**
   * Handle the non-permission, non-question tail of a waitForTurn result:
   * check for timeout, then retrieve and return the assistant response.
   */
  async _waitCompleteAndRetrieve(sessionId, directory, messageCountBefore, waitResult) {
    if (!waitResult.completed) {
      const minutes = Math.round(waitResult.elapsed / 60000)
      const timeDesc = minutes >= 1 ? `${minutes}m` : `${Math.round(waitResult.elapsed / 1000)}s`

      if (waitResult.reason === "missing_status") {
        return {
          error: "Turn was submitted but Kilo never exposed session state. "
            + "The backend may have ignored the turn or lost track of the session. "
            + "Use /status to check, or /new to start fresh.",
        }
      }

      if (waitResult.reason === "stale_timeout") {
        return {
          error: `No activity detected for ${Math.round(config.kiloStaleTimeoutMs / 1000)}s. `
            + `The turn may still be processing. `
            + `Use /status to check, or /abort then resend.`,
        }
      }

      return {
        error: `Turn timed out after ${timeDesc}. `
          + `The turn may still complete. `
          + `Use /status to check, or /abort then resend.`,
      }
    }

    // Turn completed — retrieve the latest assistant message.
    // Kilo may produce multiple messages per turn (tool step + text step).
    // The text step can be written milliseconds after the tool step completes,
    // so we retry retrieval briefly if we only find tool-only messages.
    const retrievalPollMultiplier = 4
    const retrievalStatusMultiplier = 6
    const retrievalTimeoutMs = Math.max(
      config.kiloPollIntervalMs * retrievalPollMultiplier,
      config.kiloStatusTimeoutMs * retrievalStatusMultiplier,
    )
    const retrievalDelayMs = 1500
    const retrievalDeadline = Date.now() + retrievalTimeoutMs
    let lastRetrievalError = "Turn completed but assistant response was empty."

    for (let retrieval = 1; Date.now() <= retrievalDeadline; retrieval++) {
      try {
        const messages = await this.kilo.getMessages(sessionId, directory)
        if (!Array.isArray(messages) || messages.length === 0) {
          lastRetrievalError = "Turn completed but no messages found in session."
        } else {
          // Find the newest assistant message(s) after our submission.
          // If messageCountBefore is unreliable (-1), fall back to the last assistant message only.
          let assistantMessages = []

          if (messageCountBefore >= 0) {
            const newMessages = messages.slice(messageCountBefore)
            assistantMessages = newMessages.filter((m) => m?.info?.role === "assistant")
          }

          // Only fall back to the last assistant message when the pre-submit count
          // is unavailable; otherwise we can accidentally replay the previous turn.
          if (messageCountBefore < 0 && !assistantMessages.length) {
            const lastAssistant = [...messages].reverse().find((m) => m?.info?.role === "assistant")
            if (lastAssistant) {
              assistantMessages = [lastAssistant]
            }
          }

          if (!assistantMessages.length) {
            lastRetrievalError = "Turn completed but no assistant response found."
          } else {
            // Concatenate all new assistant messages (multi-step turns produce multiple)
            const textParts = []
            const messageErrors = []
            for (const msg of assistantMessages) {
              const part = extractAssistantText(msg)
              if (part) textParts.push(part)
              const messageError = extractMessageError(msg)
              if (messageError) messageErrors.push(messageError)
            }

            const replyText = textParts.join("\n\n")

            if (replyText) {
              // Check if the last assistant message contains tool parts — if so,
              // the model likely produced a follow-up step with the tool result.
              // Keep polling for more messages instead of returning early.
              const lastMsg = assistantMessages[assistantMessages.length - 1]
              const hasToolParts = (lastMsg?.parts || []).some((p) => p.type === "tool")
              if (hasToolParts) {
                log.info("kilo.backend", "turn.retrieval_has_tool_parts", {
                  cli: "kilo",
                  session_id: sessionId,
                  attempt: retrieval,
                  text_so_far: replyText.length,
                  persist: true,
                })
                // Don't return yet — wait for the follow-up text step
                await new Promise((r) => setTimeout(r, retrievalDelayMs))
                continue
              }
              return { text: replyText }
            }

            if (messageErrors.length) {
              return { error: messageErrors.at(-1) }
            }

            lastRetrievalError = "Turn completed but assistant response was empty."
          }
        }
        log.info("kilo.backend", "turn.retrieval_retry", {
          cli: "kilo",
          session_id: sessionId,
          attempt: retrieval,
          reason: lastRetrievalError,
          persist: true,
        })
        await new Promise((r) => setTimeout(r, retrievalDelayMs))
      } catch (error) {
        log.error("kilo.backend", "turn.message_retrieval_failed", {
          cli: "kilo",
          session_id: sessionId,
          error,
          persist: true,
        })
        return { error: `Turn completed but failed to retrieve response: ${error.message}` }
      }
    }

    return { error: lastRetrievalError }
  }

  async createSession({ title, directory }) {
    return this.kilo.createSession({ title, directory })
  }

  async abortSession(sessionId) {
    return this.kilo.abortSession(sessionId)
  }

  async getSessionStatus(sessionId) {
    return this.kilo.getSessionStatus(sessionId)
  }
}

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
      const child = execFile(config.binCodex, args, {
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

// ── Backend registry ──

const BACKENDS = {}

export function registerBackend(backend) {
  BACKENDS[backend.name] = backend
}

export function getBackend(cliName) {
  return BACKENDS[cliName] ?? null
}

export function supportedClis() {
  return Object.keys(BACKENDS).filter((name) => BACKENDS[name].supported)
}

// ── CLI availability detection ──

function isBinaryAvailable(binPath) {
  try {
    execFileSync("which", [binPath], { timeout: 2000 })
    return true
  } catch {
    return false
  }
}

export function detectAvailableClis() {
  // Kilo is HTTP-based so it is always considered available (checked via hasBinary short-circuit below).
  const binaries = {
    codex: config.binCodex,
    copilot: config.binCopilot,
    gemini: config.binGemini,
    claude: config.binClaude,
  }

  for (const [name, backend] of Object.entries(BACKENDS)) {
    const hasBinary = name === "kilo" || isBinaryAvailable(binaries[name])
    backend.supported = hasBinary
  }
}
