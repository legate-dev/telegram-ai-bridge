import { config } from "./config.js"
import { log } from "./log.js"

function authHeader(username, password) {
  if (!password) return {}
  const token = Buffer.from(`${username}:${password}`).toString("base64")
  return { Authorization: `Basic ${token}` }
}

function timeoutSignal(timeoutMs) {
  if (!timeoutMs) return undefined
  return AbortSignal.timeout(timeoutMs)
}

function isTransient(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return true
  const code = error?.cause?.code ?? error?.code ?? ""
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET"].some(
    (c) => code.includes(c),
  )
}

function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class KiloClient {
  constructor(options) {
    this.baseUrl = options.baseUrl
    this.username = options.username
    this.password = options.password
  }

  buildUrl(pathname, directory) {
    const url = new URL(pathname, `${this.baseUrl}/`)
    if (directory) {
      url.searchParams.set("directory", directory)
    }
    return url
  }

  async request(pathname, options = {}) {
    const url = this.buildUrl(pathname, options.directory)
    const maxAttempts = options.retries ?? 1
    const baseDelay = 2000
    let lastError = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now()
      let response
      try {
        log.debug("kilo.http", "request.start", {
          method: options.method ?? "GET",
          path: url.pathname,
          attempt,
          max_attempts: maxAttempts,
          timeout_ms: options.timeoutMs ?? null,
        })
        response = await fetch(url, {
          method: options.method ?? "GET",
          headers: {
            ...authHeader(this.username, this.password),
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: timeoutSignal(options.timeoutMs),
        })
      } catch (error) {
        lastError = error
        if (isTransient(error) && attempt < maxAttempts) {
          const delay = baseDelay * attempt
          log.warn("kilo.http", "request.retry_transient", {
            method: options.method ?? "GET",
            path: url.pathname,
            attempt,
            max_attempts: maxAttempts,
            delay_ms: delay,
            latency_ms: Date.now() - startedAt,
            error,
          })
          await sleep(delay)
          continue
        }
        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
          log.error("kilo.http", "request.timeout", {
            method: options.method ?? "GET",
            path: url.pathname,
            timeout_ms: options.timeoutMs,
            latency_ms: Date.now() - startedAt,
            error,
            persist: true,
          })
          throw new Error(`${options.method ?? "GET"} ${url.pathname} timed out after ${options.timeoutMs}ms`)
        }
        log.error("kilo.http", "request.failed", {
          method: options.method ?? "GET",
          path: url.pathname,
          latency_ms: Date.now() - startedAt,
          error,
          persist: true,
        })
        throw error
      }

      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const delay = baseDelay * attempt
        log.warn("kilo.http", "request.retry_status", {
          method: options.method ?? "GET",
          path: url.pathname,
          attempt,
          max_attempts: maxAttempts,
          delay_ms: delay,
          status: response.status,
          latency_ms: Date.now() - startedAt,
        })
        await sleep(delay)
        continue
      }

      const text = await response.text()
      if (!response.ok) {
        log.error("kilo.http", "response.error", {
          method: options.method ?? "GET",
          path: url.pathname,
          status: response.status,
          latency_ms: Date.now() - startedAt,
          response_length: text.length,
          persist: true,
        })
        throw new Error(`${options.method ?? "GET"} ${url.pathname} failed (${response.status}): ${text || response.statusText}`)
      }

      log.info("kilo.http", "response.ok", {
        method: options.method ?? "GET",
        path: url.pathname,
        status: response.status,
        latency_ms: Date.now() - startedAt,
        response_length: text.length,
      })

      if (!text) return null
      try {
        return JSON.parse(text)
      } catch (error) {
        log.error("kilo.http", "response.parse_failed", {
          method: options.method ?? "GET",
          path: url.pathname,
          response_length: text.length,
          error,
          persist: true,
        })
        throw new Error(`${options.method ?? "GET"} ${url.pathname} returned invalid JSON`)
      }
    }

    throw lastError ?? new Error(`${options.method ?? "GET"} ${url.pathname} failed after ${maxAttempts} attempts`)
  }

  createSession({ title, directory }) {
    return this.request("/session", {
      method: "POST",
      directory,
      body: { title },
    })
  }

  getSession(sessionId, directory) {
    return this.request(`/session/${sessionId}`, { directory })
  }

  listSessions(directory) {
    return this.request("/session", { directory })
  }

  async getSessionStatus(sessionId) {
    const statuses = await this.request("/session/status", { timeoutMs: config.kiloStatusTimeoutMs })
    return statuses?.[sessionId] ?? null
  }

  abortSession(sessionId) {
    return this.request(`/session/${sessionId}/abort`, {
      method: "POST",
      timeoutMs: config.kiloAbortTimeoutMs,
    })
  }

  deleteSession(sessionId) {
    return this.request(`/session/${sessionId}`, { method: "DELETE" })
  }

  async getAllStatuses() {
    return (await this.request("/session/status", { timeoutMs: config.kiloStatusTimeoutMs })) ?? {}
  }

  /**
   * List all pending Kilo permission requests for the current project.
   * Returns an array of Request objects (potentially from sessions other than ours).
   * Caller MUST filter by sessionID before acting on entries.
   */
  async listPendingPermissions() {
    return this.request("/permission", { method: "GET", timeoutMs: config.kiloStatusTimeoutMs })
  }

  /**
   * Reply to a pending Kilo permission request.
   * @param {string} requestId
   * @param {"once" | "always" | "reject"} reply
   * @param {string} [message] — optional user feedback (only used with reject)
   */
  async replyToPermission(requestId, reply, message) {
    const encodedRequestId = encodeURIComponent(requestId)
    return this.request(`/permission/${encodedRequestId}/reply`, {
      method: "POST",
      body: { reply, ...(message != null ? { message } : {}) },
      timeoutMs: config.kiloStatusTimeoutMs,
    })
  }

  /**
   * @deprecated Synchronous message path replaced by promptAsync() + waitForTurn().
   * Kept as a fallback only; not used in production.
   */
  sendMessage({ sessionId, directory, text, variant = config.kiloVariant, agent }) {
    const body = {
      parts: [{ type: "text", text }],
      variant,
      ...(agent ? { agent } : {}),
    }

    return this.request(`/session/${sessionId}/message`, {
      method: "POST",
      directory,
      body,
      timeoutMs: config.kiloTimeoutMs,
      retries: config.kiloRetries,
    })
  }

  /**
   * Fire-and-forget message send. Returns immediately.
   * The actual result must be retrieved via getMessages() or status polling.
   * Routes through this.request() for consistent auth, logging, and error handling.
   */
  promptAsync({ sessionId, directory, text, variant = config.kiloVariant, agent }) {
    const body = {
      parts: [{ type: "text", text }],
      variant,
      ...(agent ? { agent } : {}),
    }

    return this.request(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      directory,
      body,
      timeoutMs: config.kiloSubmitTimeoutMs,
    })
  }

  /**
   * Retrieve all messages for a session.
   * Returns an array of message objects with { info, parts }.
   */
  getMessages(sessionId, directory) {
    return this.request(`/session/${sessionId}/message`, {
      directory,
      timeoutMs: config.kiloStatusTimeoutMs,
    })
  }

  /**
   * Wait for a Kilo turn to complete after prompt_async submission.
   *
   * Polls session status at regular intervals. Returns when the session
   * transitions out of "busy" state, or when the absolute timeout is reached.
   *
   * Stale timeout only applies when status checks fail repeatedly — a steady
   * "busy" response means the server is alive and working, not stale.
   *
   * When messageCountBefore is provided, also checks periodically for mid-turn
   * interactive questions (mcp_question tool calls). If a question is detected,
   * returns early with reason "question_pending" so the caller can surface it.
   *
   * When messageCountBefore is provided and the session is absent from the status
   * map (unlisted agents), falls back to message inspection to detect active streaming.
   *
   * @param {string} sessionId
   * @param {object} options
   * @param {number} options.absoluteTimeoutMs - max wall-clock time to wait
   * @param {number} options.staleTimeoutMs - max time without a successful status response
   * @param {number} options.pollIntervalMs - how often to check status
   * @param {number} [options.messageCountBefore] - message count before this turn (enables question detection)
   * @param {number} [options.questionCheckEveryNPolls] - check messages for questions every N polls (default 5)
   * @param {AbortSignal} [options.signal] - external abort signal
   * @returns {{ completed: boolean, lastStatus: object|null, elapsed: number, reason: string, question?: object, permission?: object }}
   */
  async waitForTurn(sessionId, options = {}) {
    const {
      absoluteTimeoutMs = config.kiloTurnTimeoutMs,
      staleTimeoutMs = config.kiloStaleTimeoutMs,
      pollIntervalMs = config.kiloPollIntervalMs,
      initialDelayMs = config.kiloPollInitialDelayMs,
      messageCountBefore = -1,
      questionCheckEveryNPolls = 5,
      signal,
    } = options

    const permissionCheckEveryNPolls = 2

    const startedAt = Date.now()
    let lastSuccessfulPollAt = startedAt
    let lastStatus = null
    let sawBusy = false
    let pollsSinceQuestionCheck = 0
    let pollsSincePermissionCheck = 0
    const busyAcknowledgeTimeoutMs = initialDelayMs + (pollIntervalMs * 2)

    // Wait before the first poll so Kilo has time to register the turn as busy.
    // Without this, the first poll may see "idle" and return completed: true prematurely.
    await sleep(initialDelayMs)

    while (true) {
      if (signal?.aborted) {
        return { completed: false, lastStatus, elapsed: Date.now() - startedAt, reason: "aborted" }
      }

      const elapsed = Date.now() - startedAt
      if (elapsed >= absoluteTimeoutMs) {
        return { completed: false, lastStatus, elapsed, reason: "absolute_timeout" }
      }

      // Stale = status checks keep failing (server unreachable), not "busy for a long time"
      const silentDuration = Date.now() - lastSuccessfulPollAt
      if (silentDuration >= staleTimeoutMs) {
        return { completed: false, lastStatus, elapsed, reason: "stale_timeout" }
      }

      try {
        const status = await this.getSessionStatus(sessionId)
        if (status) lastStatus = status
        lastSuccessfulPollAt = Date.now()

        const currentType = status?.type

        if (currentType === "busy") {
          sawBusy = true

          // Periodically check for mid-turn questions while busy.
          if (messageCountBefore >= 0) {
            pollsSinceQuestionCheck++
            if (pollsSinceQuestionCheck >= questionCheckEveryNPolls) {
              pollsSinceQuestionCheck = 0
              const questionResult = await this._checkForPendingQuestion(sessionId, messageCountBefore)
              if (questionResult) {
                log.info("kilo.poll", "turn.question_detected", {
                  session_id: sessionId,
                  elapsed_ms: Date.now() - startedAt,
                  question_header: questionResult.questions?.[0]?.header ?? null,
                })
                return {
                  completed: false,
                  lastStatus,
                  elapsed: Date.now() - startedAt,
                  reason: "question_pending",
                  question: questionResult,
                }
              }
            }
          }

          // Periodically check for pending Kilo permission requests while busy.
          pollsSincePermissionCheck++
          if (pollsSincePermissionCheck >= permissionCheckEveryNPolls) {
            pollsSincePermissionCheck = 0
            const permissionResult = await this._checkForPendingPermission(sessionId)
            if (permissionResult) {
              log.info("kilo.poll", "turn.permission_detected", {
                session_id: sessionId,
                request_id: permissionResult.id,
                permission: permissionResult.permission,
                pattern_count: Array.isArray(permissionResult.patterns) ? permissionResult.patterns.length : 0,
              })
              return {
                completed: false,
                lastStatus,
                elapsed: Date.now() - startedAt,
                reason: "permission_pending",
                permission: permissionResult,
              }
            }
          }
          log.debug("kilo.poll", "turn.still_busy", {
            session_id: sessionId,
            elapsed_ms: elapsed,
            poll_interval_ms: pollIntervalMs,
          })
          await sleep(pollIntervalMs)
          continue
        }

        // If status is missing or idle, we must verify if the turn is actually done.
        // Alternative agents (like venice-here, gemini_heavy) often do NOT expose 'busy' in the status map.
        // We use messageCountBefore and getMessages to detect active streaming reliably.
        if (messageCountBefore >= 0) {
          // Fetch messages separately so a getMessages() failure doesn't enter the outer catch
          // (which would treat it as a status failure) — fall back to status-only logic instead.
          let currentMessages
          try {
            currentMessages = await this.getMessages(sessionId)
          } catch (msgErr) {
            log.debug("kilo.poll", "turn.messages_check_failed", {
              session_id: sessionId,
              elapsed_ms: elapsed,
              error: msgErr,
            })
            // currentMessages stays undefined → fall through to status-only logic below
          }

          if (currentMessages !== undefined) {
            const newMessages = Array.isArray(currentMessages) ? currentMessages.slice(messageCountBefore) : []

            if (newMessages.length === 0) {
              if (elapsed >= busyAcknowledgeTimeoutMs) {
                if (sawBusy) {
                  // Was busy, now has no messages and is unlisted. Treat as done (likely errored out).
                  return { completed: true, lastStatus, elapsed: Date.now() - startedAt, reason: "done" }
                }
                return { completed: false, lastStatus, elapsed, reason: "missing_status" }
              }
              log.debug("kilo.poll", "turn.not_yet_visible_in_status_map", { session_id: sessionId, elapsed_ms: elapsed })
              await sleep(pollIntervalMs)
              continue
            }

            // We have new messages. Is the turn still streaming?
            const lastMsg = newMessages[newMessages.length - 1]
            if (lastMsg?.info?.role === "assistant" && !lastMsg.info.time?.completed) {
              sawBusy = true // It IS busy, just unlisted

              pollsSinceQuestionCheck++
              if (pollsSinceQuestionCheck >= questionCheckEveryNPolls) {
                pollsSinceQuestionCheck = 0
                const questionResult = await this._checkForPendingQuestion(sessionId, messageCountBefore)
                if (questionResult) {
                  log.info("kilo.poll", "turn.question_detected", {
                    session_id: sessionId,
                    elapsed_ms: Date.now() - startedAt,
                  })
                  return { completed: false, lastStatus, elapsed: Date.now() - startedAt, reason: "question_pending", question: questionResult }
                }
              }

              pollsSincePermissionCheck++
              if (pollsSincePermissionCheck >= permissionCheckEveryNPolls) {
                pollsSincePermissionCheck = 0
                const permissionResult = await this._checkForPendingPermission(sessionId)
                if (permissionResult) {
                  log.info("kilo.poll", "turn.permission_detected", {
                    session_id: sessionId,
                    request_id: permissionResult.id,
                    permission: permissionResult.permission,
                    pattern_count: Array.isArray(permissionResult.patterns) ? permissionResult.patterns.length : 0,
                  })
                  return { completed: false, lastStatus, elapsed: Date.now() - startedAt, reason: "permission_pending", permission: permissionResult }
                }
              }

              log.debug("kilo.poll", "turn.unlisted_but_streaming", { session_id: sessionId, elapsed_ms: elapsed })
              await sleep(pollIntervalMs)
              continue
            }

            // Messages present and the last assistant message is completed (or not assistant).
            // Do one extra sleep + recheck before declaring done — guards against multi-step turns
            // that briefly expose a completed message between steps.
            // For unlisted agents, getSessionStatus() is always null/idle, so we re-sample
            // getMessages() as the primary signal and use status only as an additional check.
            await sleep(pollIntervalMs)

            // Re-sample messages to confirm the turn hasn't resumed.
            try {
              const recheckMessages = await this.getMessages(sessionId)
              if (Array.isArray(recheckMessages) && recheckMessages.length > currentMessages.length) {
                // New messages appeared — turn resumed
                log.debug("kilo.poll", "turn.resumed_new_message", { session_id: sessionId, elapsed_ms: Date.now() - startedAt })
                continue
              }
              const recheckLast = Array.isArray(recheckMessages) ? recheckMessages[recheckMessages.length - 1] : undefined
              if (recheckLast?.info?.role === "assistant" && !recheckLast.info.time?.completed) {
                // Last assistant message is streaming again
                log.debug("kilo.poll", "turn.resumed_incomplete_message", { session_id: sessionId, elapsed_ms: Date.now() - startedAt })
                continue
              }
            } catch {
              // getMessages recheck failed — fall through to status check
            }

            try {
              const recheck = await this.getSessionStatus(sessionId)
              lastSuccessfulPollAt = Date.now()
              lastStatus = recheck ?? lastStatus
              if (recheck?.type === "busy") {
                log.debug("kilo.poll", "turn.resumed_after_messages_idle", { session_id: sessionId, elapsed_ms: Date.now() - startedAt })
                continue
              }
            } catch {
              // Recheck failed — proceed with done
            }
            return { completed: true, lastStatus, elapsed: Date.now() - startedAt, reason: "done" }
          }
          // If currentMessages === undefined (getMessages failed), fall through to status-only logic.
        }

        // Fallback for when messageCountBefore is unavailable (-1):
        // Rely entirely on the status map and rechecks.
        if (!status) {
          if (sawBusy) {
            log.debug("kilo.poll", "turn.idle_omitted_from_status_map", { session_id: sessionId, elapsed_ms: Date.now() - startedAt })
            await sleep(pollIntervalMs)
            try {
              const recheck = await this.getSessionStatus(sessionId)
              lastSuccessfulPollAt = Date.now()
              lastStatus = recheck ?? lastStatus
              if (recheck?.type === "busy") {
                log.debug("kilo.poll", "turn.resumed_after_idle_omission", { session_id: sessionId, elapsed_ms: Date.now() - startedAt })
                continue
              }
            } catch {
              // Recheck failed
            }
            return { completed: true, lastStatus, elapsed: Date.now() - startedAt, reason: "done" }
          }

          if (elapsed >= busyAcknowledgeTimeoutMs) {
            return { completed: false, lastStatus, elapsed, reason: "missing_status" }
          }

          log.debug("kilo.poll", "turn.not_yet_visible_in_status_map", { session_id: sessionId, elapsed_ms: elapsed })
          await sleep(pollIntervalMs)
          continue
        }

        if (currentType !== "busy") {
          log.debug("kilo.poll", "turn.idle_detected", { session_id: sessionId, elapsed_ms: Date.now() - startedAt })
          await sleep(pollIntervalMs)
          try {
            const recheck = await this.getSessionStatus(sessionId)
            if (recheck?.type === "busy") {
              log.debug("kilo.poll", "turn.resumed_after_idle", { session_id: sessionId, elapsed_ms: Date.now() - startedAt })
              lastSuccessfulPollAt = Date.now()
              lastStatus = recheck
              continue
            }
          } catch {
            // Recheck failed
          }
          return { completed: true, lastStatus, elapsed: Date.now() - startedAt, reason: "done" }
        }

      } catch (error) {
        log.warn("kilo.poll", "status_check_failed", {
          session_id: sessionId,
          elapsed_ms: Date.now() - startedAt,
          silent_ms: Date.now() - lastSuccessfulPollAt,
          error,
        })
      }

      await sleep(pollIntervalMs)
    }
  }

  /**
   * Check Kilo's permission queue for a pending request belonging to our session.
   * Returns the matching Request object, or null.
   *
   * IMPORTANT: GET /permission returns ALL pending permissions for the project,
   * not just our session's. We MUST filter by sessionID before returning.
   * @private
   */
  async _checkForPendingPermission(sessionId) {
    try {
      const pending = await this.listPendingPermissions()
      if (!Array.isArray(pending)) return null
      const ours = pending.find((req) => req.sessionID === sessionId)
      return ours ?? null
    } catch (error) {
      log.debug("kilo.poll", "permission_check_failed", { session_id: sessionId, error: String(error) })
      return null
    }
  }

  /**
   * Check session messages for a pending mcp_question tool call.
   * Returns question data if found, null otherwise.
   * @private
   */
  async _checkForPendingQuestion(sessionId, messageCountBefore) {
    try {
      const messages = await this.getMessages(sessionId)
      if (!Array.isArray(messages) || messages.length <= messageCountBefore) return null

      const newMessages = messages.slice(messageCountBefore)
      for (const msg of newMessages) {
        if (msg?.info?.role !== "assistant") continue
        const parts = msg.parts || []
        for (const part of parts) {
          if (part.type === "tool" && part.tool === "question" && part.state?.status === "running") {
            const questions = part.state?.input?.questions || []
            if (!questions.length) continue
            // Extract any text the AI produced in the same message before the question
            const precedingText = parts
              .filter((p) => p.type === "text" && p.text)
              .map((p) => p.text)
              .join("\n\n")
            return { questions, precedingText }
          }
        }
      }
    } catch (error) {
      log.debug("kilo.poll", "question_check_failed", { session_id: sessionId, error })
    }
    return null
  }
}
