import { config } from "../config.js"
import { extractAssistantText, extractMessageError } from "../format.js"
import { log } from "../log.js"

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
