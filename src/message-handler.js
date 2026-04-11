import { InlineKeyboard } from "grammy"
import { randomUUID } from "node:crypto"
import { getChatBinding, setChatBinding, getCliSessionById } from "./db.js"
import { config } from "./config.js"
import { checkRateLimit } from "./rate-limit.js"
import { getBackend, supportedClis } from "./backends.js"
import { getModelsForCli } from "./model-discovery.js"
import { createNewSession } from "./commands.js"
import { log, redactString } from "./log.js"
import { readLastTurn } from "./last-turn.js"
import {
  replyChunks,
  resolvePreferredAgent,
  hasBoundSession,
  displayPath,
  explainBackendFailure,
  registerPath,
  resolvePath,
  parseUserPath,
  validateWorkspaceDirectory,
  resolveSessionLabel,
} from "./telegram-utils.js"

const inFlightChats = new Set()
// pendingCustomPath: chatKey → { timerId }
// TTL matches pendingQuestions pattern: self-clearing after config.bridgePendingPathTtlMs
// to prevent state leak when users click "Custom path..." and never respond.
const pendingCustomPath = new Map()

export function setPendingCustomPath(chatKey) {
  deletePendingCustomPath(chatKey)  // cancel any existing timer
  const entry = { timerId: null }
  const timerId = setTimeout(() => {
    if (pendingCustomPath.get(chatKey) === entry) {
      pendingCustomPath.delete(chatKey)
      log.debug("telegram.message", "pending_custom_path.ttl_expired", { chat_id: chatKey })
    }
  }, config.bridgePendingPathTtlMs)
  timerId.unref?.()
  entry.timerId = timerId
  pendingCustomPath.set(chatKey, entry)
}

export function deletePendingCustomPath(chatKey) {
  const entry = pendingCustomPath.get(chatKey)
  if (entry?.timerId) clearTimeout(entry.timerId)
  pendingCustomPath.delete(chatKey)
}

export function hasPendingCustomPath(chatKey) {
  return pendingCustomPath.has(chatKey)
}

// Private — all mutations must go through setPendingQuestion / deletePendingQuestion
// to keep the per-entry TTL timer in sync. Tests use the read-only helpers below.
const pendingQuestions = new Map()
// Private — all mutations must go through setPendingPermission / deletePendingPermission
// to keep the per-entry TTL timer in sync. Tests use the read-only helpers below.
const pendingPermissions = new Map()
// Buffer for coalescing consecutive Telegram message fragments into one LLM turn.
// Map<chatKey, { texts: string[], ctx: object, timerId: NodeJS.Timeout }>
const messageBuffer = new Map()

// Telegram's per-message character limit. When a user's input exceeds this,
// Telegram silently splits it into consecutive messages. Every fragment except
// the last will be exactly this length, so a message at this boundary is a
// reliable signal that more fragments are on the way.
const TELEGRAM_SPLIT_LENGTH = 4096

/**
 * Add (or replace) a pending question entry for a chat.
 * Clears any existing timeout for the same chatKey before scheduling a new one,
 * so replacing an entry never fires the old timeout.
 */
export function setPendingQuestion(chatKey, data) {
  const existing = pendingQuestions.get(chatKey)
  if (existing?.timeoutId) clearTimeout(existing.timeoutId)

  const entry = { ...data, createdAt: Date.now() }
  entry.timeoutId = setTimeout(() => {
    if (pendingQuestions.get(chatKey) === entry) {
      pendingQuestions.delete(chatKey)
      log.debug("telegram.message", "pending_question.ttl_expired", { chat_id: chatKey })
    }
  }, config.bridgePendingQuestionTtlMs)
  entry.timeoutId.unref?.()

  pendingQuestions.set(chatKey, entry)
}

/**
 * Delete a pending question entry and cancel its scheduled TTL timeout.
 */
function deletePendingQuestion(chatKey) {
  const entry = pendingQuestions.get(chatKey)
  if (entry?.timeoutId) clearTimeout(entry.timeoutId)
  pendingQuestions.delete(chatKey)
}

// Read-only helpers exported for tests. Production code must not import these.
export function hasPendingQuestion(chatKey) {
  return pendingQuestions.has(chatKey)
}

export function getPendingQuestion(chatKey) {
  return pendingQuestions.get(chatKey)
}

export function getBufferedFragmentCount(chatKey) {
  return messageBuffer.get(chatKey)?.texts.length ?? 0
}

/**
 * Add (or replace) a pending permission entry for a chat.
 * Clears any existing timeout for the same chatKey before scheduling a new one,
 * so replacing an entry never fires the old timeout.
 */
export function setPendingPermission(chatKey, data) {
  const existing = pendingPermissions.get(chatKey)
  if (existing?.timeoutId) clearTimeout(existing.timeoutId)

  const entry = { ...data, createdAt: Date.now() }
  entry.timeoutId = setTimeout(() => {
    if (pendingPermissions.get(chatKey) === entry) {
      pendingPermissions.delete(chatKey)
      log.debug("telegram.message", "pending_permission.ttl_expired", { chat_id: chatKey })
      // For Claude: the generator is suspended on stdin waiting for a control_response.
      // If the TTL fires without a user reply, send a deny so the generator can resume
      // and the turn can complete (or error out), releasing inFlightChats.
      if (entry.binding?.cli === "claude" && typeof entry.backend?.replyPermission === "function") {
        entry.backend.replyPermission(entry.requestId, "deny")
      }
    }
  }, config.bridgePendingPermissionTtlMs)
  entry.timeoutId.unref?.()

  pendingPermissions.set(chatKey, entry)
}

/**
 * Delete a pending permission entry and cancel its scheduled TTL timeout.
 */
function deletePendingPermission(chatKey) {
  const entry = pendingPermissions.get(chatKey)
  if (entry?.timeoutId) clearTimeout(entry.timeoutId)
  pendingPermissions.delete(chatKey)
}

/**
 * Clear the pending permission entry for a chat (e.g. on /abort or /detach).
 * Exported so that index.js slash-command middleware can call it before any
 * command handler runs, preventing a stale pending from blocking new turns.
 */
export function clearPendingPermission(chatKey) {
  deletePendingPermission(chatKey)
}

// Read-only helpers exported for tests. Production code must not import these.
export function hasPendingPermission(chatKey) {
  return pendingPermissions.has(chatKey)
}

export function getPendingPermission(chatKey) {
  return pendingPermissions.get(chatKey)
}

/**
 * Clear the buffered text fragments for a chat, cancelling the debounce timer.
 * Called when a slash command is received, so that a subsequent flush does not
 * replay stale fragments against a changed binding or conversational state.
 */
export function clearMessageBuffer(chatKey) {
  const entry = messageBuffer.get(chatKey)
  if (!entry) return
  if (entry.timerId) clearTimeout(entry.timerId)
  messageBuffer.delete(chatKey)
  log.debug("telegram.message", "message_buffer.cleared_by_command", { chat_id: chatKey })
}

/**
 * Surface a mid-turn mcp_question as a Telegram inline keyboard.
 * Stores the question state so the callback handler can process the response.
 */
async function surfaceQuestion(ctx, questionData, chatKey, binding, agent, backend) {
  const q = questionData.questions?.[0]
  if (!q) {
    await replyChunks(ctx, "The AI asked a question but it was empty. Send your message again.")
    return
  }

  const rawOptions = q.options || []

  // Send any text the AI produced before the question
  if (questionData.precedingText) {
    await replyChunks(ctx, questionData.precedingText)
  }

  // Build stable labels upfront — fallback when label is missing
  const options = rawOptions.map((opt, i) => ({
    ...opt,
    label: opt.label || `Option ${i + 1}`,
  }))

  // Build the question text (plain text — no parse_mode to avoid escaping issues)
  const header = q.header ? `${q.header}\n` : ""
  const questionBody = typeof q.question === "string" && q.question.trim()
    ? q.question.trim()
    : "The AI is asking a follow-up question. Pick an option or type a reply."
  const questionText = `${header}${questionBody}`

  // Build inline keyboard — one button per option
  const keyboard = new InlineKeyboard()
  for (let i = 0; i < options.length; i++) {
    keyboard.text(options[i].label, `q:${i}`).row()
  }

  // A self-cancelling setTimeout ensures the entry is removed after PENDING_QUESTION_TTL_MS
  // even if the user never responds (active cleanup, not lazy).
  //
  // TODO Phase 1.2: For Claude's AskUserQuestion, the q: callback must branch on
  // `pending.binding.cli === "claude"` and call backend.replyPermission(requestId, answer)
  // instead of spawning a new turn. This requires storing requestId here and a separate
  // `cq:` callback prefix (or a cli-branch in the existing `q:` handler) to keep
  // Claude's control_response flow isolated from Kilo's new-turn flow.
  setPendingQuestion(chatKey, { binding, agent, backend, options, questionText })

  // Use replyChunks for question text (can exceed Telegram's 4096 char limit)
  // then send the keyboard as a separate message
  await replyChunks(ctx, questionText)
  await ctx.reply("Choose an option:", { reply_markup: keyboard })
}

/**
 * Compose a human-readable summary of a Kilo permission request.
 * @param {{ permission: string, patterns?: string[], metadata?: object }} req
 */
function formatPermissionPrompt(req) {
  const lines = [`Tool: ${req.permission}`]
  if (Array.isArray(req.patterns) && req.patterns.length > 0) {
    lines.push(`Patterns: ${req.patterns.join(", ")}`)
  }
  if (req.metadata && typeof req.metadata === "object") {
    const entries = Object.entries(req.metadata)
    if (entries.length > 0) {
      lines.push("Details:")
      for (const [k, v] of entries) {
        lines.push(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      }
    }
  }
  return lines.join("\n")
}

/**
 * Surface a mid-turn Kilo permission request as a Telegram inline keyboard.
 * Stores the permission state so the callback handler can process the response
 * and resume the paused Kilo turn.
 *
 * @param sessionId  The Kilo session ID (used by the callback handler to call resumeTurn).
 * @param directory  The session workspace directory.
 * @param messageCountBefore  Message count before the turn was submitted — passed to resumeTurn
 *   so it can correctly identify new assistant messages after the turn completes.
 */
async function surfacePermission(ctx, permissionData, chatKey, binding, agent, backend, sessionId, directory, messageCountBefore) {
  const req = permissionData
  const header = `🔐 Permission required\n\n`
  const body = formatPermissionPrompt(req)
  const text = `${header}${body}`

  const requestId = req.id

  const keyboard = new InlineKeyboard()
    .text("✅ Allow once", `perm:once:${requestId}`)
    .text("✓✓ Always allow", `perm:always:${requestId}`)
    .text("❌ Deny", `perm:deny:${requestId}`)

  // "Allow everything" — available only for Kilo, which has a dedicated REST
  // endpoint (POST /allow-everything) that resolves the current pending request
  // AND sets a wildcard rule so future permissions are auto-approved.
  if (typeof backend?.kilo?.allowEverything === "function") {
    keyboard
      .row()
      .text("⚡ Allow everything (session)", `ae:session:${requestId}`)
      .text("🌐 Allow everything (global)", `ae:global:${requestId}`)
  }

  setPendingPermission(chatKey, { binding, agent, backend, requestId, text, sessionId, directory, messageCountBefore })

  await replyChunks(ctx, text)
  await ctx.reply("Choose an action:", { reply_markup: keyboard })
}

export function setupHandlers(bot, kilo, agentRegistryPromise) {
  // ── Unified inline keyboard callbacks ──
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data

    // CLI picker from /new
    if (data.startsWith("newcli:")) {
      const [, cli, hash] = data.split(":")
      const directory = resolvePath(hash)
      if (!directory) {
        await ctx.answerCallbackQuery({ text: "This button has expired. Run /new again.", show_alert: true })
        return
      }
      await ctx.answerCallbackQuery(`Creating ${cli} session...`)
      await createNewSession(ctx, cli, directory, agentRegistryPromise)
      return
    }

    // Workspace picker from /new — show CLI picker for chosen workspace
    if (data.startsWith("newws:")) {
      const hash = data.slice("newws:".length)
      const workspace = resolvePath(hash)
      if (!workspace) {
        await ctx.answerCallbackQuery({ text: "This button has expired. Run /new again.", show_alert: true })
        return
      }
      const clis = supportedClis()
      await ctx.answerCallbackQuery()
      if (clis.length === 1) {
        await createNewSession(ctx, clis[0], workspace, agentRegistryPromise)
        return
      }
      const keyboard = new InlineKeyboard()
      // Reuse the original hash — the workspace is already registered under it
      for (const cli of clis) {
        keyboard.text(cli, `newcli:${cli}:${hash}`).row()
      }
      await ctx.editMessageText(`Pick a CLI for ${displayPath(workspace)}:`, { reply_markup: keyboard })
      return
    }

    // "Custom path..." from workspace picker — ask user to type a path
    if (data === "newpath:") {
      await ctx.answerCallbackQuery()
      setPendingCustomPath(String(ctx.chat.id))
      await ctx.reply("Type the workspace path:", {
        reply_markup: { force_reply: true, selective: true },
      })
      return
    }

    // Question response from inline keyboard (mid-turn mcp_question)
    if (data.startsWith("q:")) {
      const chatKey = String(ctx.chat.id)

      // Concurrency guard — must run BEFORE consuming the pending question
      // or answering the callback, so a stale tap during an active turn cannot
      // destroy the pending state, double-answer the callback, or wipe the
      // keyboard message. The user can retry once the in-flight turn finishes.
      if (inFlightChats.has(chatKey)) {
        await ctx.answerCallbackQuery({
          text: "Another turn is in progress. Please wait for it to finish.",
          show_alert: true,
        })
        return
      }

      const pending = pendingQuestions.get(chatKey)
      if (!pending) {
        await ctx.answerCallbackQuery({ text: "No pending question.", show_alert: true })
        return
      }

      const optionIndex = parseInt(data.slice(2), 10)
      const chosen = pending.options?.[optionIndex]
      if (!chosen) {
        await ctx.answerCallbackQuery({ text: "Invalid option.", show_alert: true })
        return
      }

      const answerLabel = chosen.label
      deletePendingQuestion(chatKey)
      await ctx.answerCallbackQuery(`Chosen: ${answerLabel}`)

      // Edit the keyboard message to show the choice (removes the buttons)
      try {
        await ctx.editMessageText(`✅ ${answerLabel}`)
      } catch { /* message may be too old to edit */ }

      // Send the chosen label as a new user message to the backend.
      // The AI sees its own question in the conversation history + this answer.
      const { binding, agent, backend } = pending
      if (!backend?.supported) return

      inFlightChats.add(chatKey)
      let typingInterval = null
      try {
        await ctx.api.sendChatAction(ctx.chat.id, "typing")
        typingInterval = setInterval(() => {
          ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {})
        }, 4000)

        const result = await backend.sendMessage({
          sessionId: binding.session_id,
          directory: binding.directory,
          text: answerLabel,
          agent,
          model: binding.model ?? null,
        })

        if (result.error) {
          await replyChunks(ctx, `${binding.cli} error: ${redactString(result.error)}`)
        } else if (result.question) {
          // Nested question — surface it again
          await surfaceQuestion(ctx, result.question, chatKey, binding, agent, backend)
        } else if (result.text) {
          await replyChunks(ctx, result.text)
        } else {
          await replyChunks(ctx, `${binding.cli} returned no text for this turn.`)
        }
      } catch (error) {
        log.error("telegram.callback", "question_response.exception", {
          chat_id: chatKey,
          cli: binding.cli,
          session_id: binding.session_id,
          error,
          persist: true,
        })
        await replyChunks(ctx, `Error sending answer: ${error.message}`)
      } finally {
        if (typingInterval) clearInterval(typingInterval)
        inFlightChats.delete(chatKey)
      }
      return
    }

    // Permission response from inline keyboard (mid-turn Kilo permission request)
    // ── Allow everything (Kilo only) ──────────────────────────────────────────
    // Format: ae:<scope>:<requestId>  scope = "session" | "global"
    // Calls POST /allow-everything which resolves the current pending request,
    // drains all other pending permissions, and sets a wildcard rule so future
    // tool calls are auto-approved without further prompts.
    if (data.startsWith("ae:")) {
      const chatKey = String(ctx.chat.id)
      const firstColon = data.indexOf(":")
      const secondColon = data.indexOf(":", firstColon + 1)
      const scope = secondColon !== -1 ? data.slice(firstColon + 1, secondColon) : ""
      const requestId = secondColon !== -1 ? data.slice(secondColon + 1) : ""

      // Validate shape and scope before touching any state
      if (secondColon === -1 || !["session", "global"].includes(scope) || !requestId) {
        await ctx.answerCallbackQuery({ text: "Invalid action.", show_alert: true })
        return
      }

      const pending = pendingPermissions.get(chatKey)
      if (!pending || pending.requestId !== requestId) {
        await ctx.answerCallbackQuery({ text: "No pending permission or stale request.", show_alert: true })
        return
      }

      // Capability check — ae: is Kilo-only; a forged callback while a Claude
      // permission is pending would otherwise throw and confuse the user.
      if (typeof pending.backend?.kilo?.allowEverything !== "function") {
        await ctx.answerCallbackQuery({ text: "Unsupported action for this backend.", show_alert: true })
        return
      }

      // Session-scoped allow-everything requires a known session ID
      if (scope === "session" && !pending.sessionId) {
        await ctx.answerCallbackQuery({ text: "No session ID available for session-scoped allow.", show_alert: true })
        return
      }

      if (pending.replying) {
        await ctx.answerCallbackQuery({ text: "Already processing…", show_alert: true })
        return
      }
      pending.replying = true

      const label = scope === "global" ? "🌐 Allow everything (global)" : "⚡ Allow everything (session)"
      await ctx.answerCallbackQuery({ text: label })

      try {
        const opts = { enable: true, requestID: requestId }
        if (scope === "session") opts.sessionID = pending.sessionId
        await pending.backend.kilo.allowEverything(opts)

        // Kilo drains its full pending queue server-side. Clear any stale
        // Kilo permission entries from other chats so their keyboard buttons
        // don't attempt to reply to already-drained requests.
        for (const [key, entry] of pendingPermissions.entries()) {
          if (key !== chatKey && entry.binding?.cli === "kilo") {
            deletePendingPermission(key)
          }
        }

        // Lock inFlightChats before releasing the permission guard (same as perm: path).
        const canResume = pending.sessionId != null && pending.backend?.resumeTurn != null
        if (canResume) inFlightChats.add(chatKey)
        deletePendingPermission(chatKey)
        try { await ctx.editMessageText(`${pending.text}\n\n${label}`) } catch {}
        log.info("telegram.callback", "allow_everything", {
          chat_id: chatKey,
          request_id: requestId,
          scope,
          persist: true,
        })

        if (canResume) {
          try {
            const resumeResult = await pending.backend.resumeTurn(
              pending.sessionId, pending.directory, pending.messageCountBefore,
            )
            if (resumeResult.permission) {
              await surfacePermission(
                ctx, resumeResult.permission, chatKey,
                pending.binding, pending.agent, pending.backend,
                pending.sessionId, pending.directory,
                resumeResult.messageCountBefore ?? pending.messageCountBefore,
              )
            } else if (resumeResult.question) {
              await surfaceQuestion(ctx, resumeResult.question, chatKey, pending.binding, pending.agent, pending.backend)
            } else if (resumeResult.text) {
              await replyChunks(ctx, resumeResult.text)
            } else if (resumeResult.error) {
              await replyChunks(ctx, `kilo error: ${redactString(resumeResult.error)}`)
            }
          } catch (resumeErr) {
            log.error("telegram.callback", "allow_everything_resume_failed", {
              chat_id: chatKey,
              request_id: requestId,
              error: redactString(String(resumeErr)),
              persist: true,
            })
            try {
              await ctx.reply(`Allow everything succeeded but the turn could not be resumed: ${redactString(resumeErr.message)}`)
            } catch { /* best-effort */ }
          } finally {
            inFlightChats.delete(chatKey)
          }
        }
      } catch (err) {
        pending.replying = false
        log.error("telegram.callback", "allow_everything_failed", {
          chat_id: chatKey,
          request_id: requestId,
          error: redactString(String(err)),
          persist: true,
        })
        try {
          await ctx.reply(`Failed to enable allow everything: ${redactString(err.message)}`)
        } catch { /* best-effort */ }
      }
      return
    }

    if (data.startsWith("perm:")) {
      const chatKey = String(ctx.chat.id)
      const parts = data.split(":")
      // Format: perm:<reply>:<requestId> — requestId may contain colons
      const reply = parts[1]
      const requestId = parts.slice(2).join(":")
      const validReplies = new Set(["once", "always", "deny"])

      if (!validReplies.has(reply)) {
        await ctx.answerCallbackQuery({ text: "Invalid action", show_alert: true })
        return
      }

      const pending = pendingPermissions.get(chatKey)
      if (!pending || pending.requestId !== requestId) {
        await ctx.answerCallbackQuery({ text: "No pending permission or stale request.", show_alert: true })
        return
      }

      // Guard against concurrent taps (double-tap / retry while first is in flight).
      // Set replying=true here to block any concurrent taps; the flag is cleared on
      // error so the user can retry after a failure, and omitted on success because
      // the pending entry is deleted (deletePendingPermission) before another tap
      // could arrive.
      if (pending.replying) {
        await ctx.answerCallbackQuery({ text: "Already processing…", show_alert: true })
        return
      }
      pending.replying = true

      // Answer immediately so Telegram doesn't spin — the network POST to Kilo
      // may be slow and Telegram requires a response within ~10 s.
      const label = reply === "once" ? "✅ Allowed once" : reply === "always" ? "✓✓ Always allowed" : "❌ Denied"
      await ctx.answerCallbackQuery({ text: label })

      try {
        // Capability-based routing: streaming backends expose replyPermission()
        // and own the turn lifecycle via their still-running for-await loop.
        // CLI-name checks would break if a future backend reuses the same name.
        const isStreamingBackend = typeof pending.backend?.replyPermission === "function"
        if (isStreamingBackend) {
          // AsyncGenerator path (Claude + future streaming backends): write
          // control_response to active stdin so the for-await loop resumes.
          // No resumeTurn() needed; inFlightChats stays held by that loop.
          // Map "once"/"always" → "allow" so the replyPermission contract is met.
          // Gemini never yields permission events, so this branch is Claude-only in practice.
          const behavior = reply === "deny" ? "deny" : "allow"
          pending.backend.replyPermission(requestId, behavior)
          deletePendingPermission(chatKey)
          try {
            await ctx.editMessageText(`${pending.text}\n\n${label}`)
          } catch { /* message may be too old to edit */ }
          log.info("telegram.callback", "permission_replied", {
            chat_id: chatKey,
            request_id: requestId,
            reply,
            persist: true,
          })
        } else {
          // Kilo (and future backends with resumeTurn): existing round-trip logic.
          await pending.backend.kilo.replyToPermission(
            requestId,
            reply === "deny" ? "reject" : reply,
          )
          // Determine whether we need to resume the paused Kilo turn.
          // Lock inFlightChats before releasing the pending-permission guard so
          // there is never a window where both guards are absent simultaneously.
          const canResume = pending.sessionId != null && pending.backend?.resumeTurn != null
          if (canResume) {
            inFlightChats.add(chatKey)
          }
          // Delete only after a successful reply so the user can retry if it fails.
          deletePendingPermission(chatKey)
          try {
            await ctx.editMessageText(`${pending.text}\n\n${label}`)
          } catch { /* message may be too old to edit */ }
          log.info("telegram.callback", "permission_replied", {
            chat_id: chatKey,
            request_id: requestId,
            reply,
            persist: true,
          })

          // Resume the paused Kilo turn and deliver the model's response.
          if (canResume) {
            try {
              const resumeResult = await pending.backend.resumeTurn(
                pending.sessionId, pending.directory, pending.messageCountBefore,
              )
              if (resumeResult.permission) {
                // Nested permission — surface it; the next perm: tap will resume again.
                // resumeResult.messageCountBefore is always set by resumeTurn; the
                // fallback to pending.messageCountBefore is a last-resort safety net.
                await surfacePermission(
                  ctx, resumeResult.permission, chatKey,
                  pending.binding, pending.agent, pending.backend,
                  pending.sessionId, pending.directory,
                  resumeResult.messageCountBefore ?? pending.messageCountBefore,
                )
              } else if (resumeResult.question) {
                // Mid-resume mcp_question — surface it; the q: callback will handle the reply.
                await surfaceQuestion(ctx, resumeResult.question, chatKey, pending.binding, pending.agent, pending.backend)
              } else if (resumeResult.text) {
                await replyChunks(ctx, resumeResult.text)
              } else if (resumeResult.error) {
                await replyChunks(ctx, `kilo error: ${redactString(resumeResult.error)}`)
              }
            } catch (resumeErr) {
              log.error("telegram.callback", "permission_resume_failed", {
                chat_id: chatKey,
                request_id: requestId,
                error: redactString(String(resumeErr)),
                persist: true,
              })
              try {
                await ctx.reply(`Permission was accepted but the turn could not be resumed: ${redactString(resumeErr.message)}`)
              } catch { /* best-effort */ }
            } finally {
              inFlightChats.delete(chatKey)
            }
          }
        }
      } catch (err) {
        // Clear the in-flight flag so the user can retry by tapping the button again.
        pending.replying = false
        log.error("telegram.callback", "permission_reply_failed", {
          chat_id: chatKey,
          request_id: requestId,
          reply,
          error: redactString(String(err)),
          persist: true,
        })
        // Callback already answered above; send a follow-up message for the error
        try {
          await ctx.reply(`Failed to send permission reply: ${redactString(err.message)}`)
        } catch { /* best-effort */ }
      }
      return
    }

    if (!data.startsWith("bind:")) {
      if (data.startsWith("setmodel:")) {
        const [, ...slugParts] = data.split(":")
        let slug = slugParts.join(":")
        const binding = getChatBinding(ctx.chat.id)
        if (!binding) {
          await ctx.answerCallbackQuery({ text: "No session bound.", show_alert: true })
          return
        }
        const cli = binding.cli
        if (cli !== "claude" && cli !== "codex" && cli !== "lmstudio") {
          await ctx.answerCallbackQuery({ text: `Model selection is not supported for ${cli}.`, show_alert: true })
          return
        }
        // Resolve truncated callback slugs (Telegram 64-byte limit) by matching
        // against the full model list. Falls back to the callback slug as-is.
        if (cli === "lmstudio") {
          const models = await getModelsForCli("lmstudio")
          const match = models?.find((m) => m.slug.startsWith(slug))
          if (match) slug = match.slug
        }
        setChatBinding(ctx.chat.id, { ...binding, model: slug })
        log.info("telegram.callback", "model.set", {
          chat_id: String(ctx.chat.id),
          cli: binding.cli,
          session_id: binding.session_id,
          model: slug,
          persist: true,
        })
        await ctx.answerCallbackQuery(`Model set to ${slug}`)
        await ctx.editMessageText(`Model set to ${slug}. New messages will use it.`)
        return
      }
      await ctx.answerCallbackQuery("Unknown action.")
      return
    }

    const [, cli, ...rest] = data.split(":")
    const sessionId = rest.join(":")
    const row = getCliSessionById(cli, sessionId)

    if (!row) {
      await ctx.answerCallbackQuery({ text: "Session not found in local DB.", show_alert: true })
      return
    }

    // Defense in depth: reject rows whose workspace is a sentinel value.
    // The query filter in recentSessions() already excludes these from the
    // /sessions picker, and the scanner guard refuses to write them, but
    // this final check protects against:
    //   - stale DB rows from pre-migration installations before the bridge
    //     restarts and runs the cleanup migration
    //   - future scanners that might inadvertently introduce sentinels
    //   - direct callback forgery (a compromised bot token could fire
    //     bind:cli:<arbitrary-id> that happens to match a legacy row)
    // Failing loudly at the bind boundary with a clear user-facing message
    // is better than failing later with a cryptic ENOENT from the exec layer.
    if (!row.workspace || row.workspace === "/unknown" || row.workspace === ".") {
      await ctx.answerCallbackQuery({
        text: "This session has no recorded workspace (legacy format). Start fresh with /new.",
        show_alert: true,
      })
      log.warn("telegram.callback", "session.bind_rejected_sentinel_workspace", {
        chat_id: String(ctx.chat.id),
        cli: row.cli,
        session_id: row.session_id,
        workspace: row.workspace,
        persist: true,
      })
      return
    }

    // Answer callback immediately to satisfy Telegram's 10s deadline
    await ctx.answerCallbackQuery(`Bound to [${row.cli}] session`)

    const backend = getBackend(row.cli)
    const registry = await agentRegistryPromise
    const existing = getChatBinding(ctx.chat.id)
    const agent = resolvePreferredAgent(existing, registry)

    setChatBinding(ctx.chat.id, {
      cli: row.cli,
      session_id: row.session_id,
      agent,
      model: null,
      directory: row.workspace,
    })
    log.info("telegram.callback", "session.bound", {
      chat_id: String(ctx.chat.id),
      cli: row.cli,
      session_id: row.session_id,
      directory: row.workspace,
      persist: true,
    })
    await ctx.editMessageText(
      [
        `Bound to [${row.cli}] session.`,
        `Session: ${resolveSessionLabel(row)}`,
        `Workspace: ${displayPath(row.workspace)}`,
        `Agent: ${agent}`,
        "",
        backend?.supported
          ? "Send a message to start chatting."
          : `Live chat not supported for ${row.cli}. Resume: ${row.resume_cmd}`,
      ].join("\n"),
    )

    // Best-effort: surface the last assistant message so the user has
    // immediate context when reopening a session.
    try {
      const lastText = await readLastTurn(row.cli, row.session_id, row.workspace, { kiloClient: kilo })
      if (lastText) {
        await replyChunks(ctx, `↩️ Last message:\n\n${lastText}`)
      }
    } catch {
      // Never let a last-turn read failure block the bind response
    }
  })

  // ── Core message processing (called after fragments are coalesced) ──
  async function processTextMessage(ctx, chatKey, text) {
    // Rate-limit check: applied here (after coalescing) so that a multi-fragment
    // Telegram message counts as a single turn rather than N separate slots.
    const userId = ctx.from?.id
    if (userId) {
      const rl = checkRateLimit(userId)
      if (!rl.allowed) {
        const retrySec = Math.max(1, Math.ceil(rl.retryAfterMs / 1000))
        log.warn("telegram.message", "rate_limit.blocked", {
          user_id: userId,
          chat_id: chatKey,
          kind: "text",
          retry_after_ms: rl.retryAfterMs,
        })
        try {
          await ctx.reply(`⚠️ Rate limit exceeded. Retry in ${retrySec}s.`)
        } catch (err) {
          log.debug("telegram.message", "rate_limit.reply_failed", { error: String(err) })
        }
        return
      }
    }

    const binding = getChatBinding(ctx.chat.id)
    if (!hasBoundSession(binding)) {
      await replyChunks(ctx, "No session bound. Use /sessions or /new first.")
      return
    }

    const backend = getBackend(binding.cli)
    if (!backend?.supported) {
      const supported = supportedClis().join(", ")
      await replyChunks(
        ctx,
        `Live chat not supported for ${binding.cli}. Supported: ${supported}. Use /new to create a supported session.`,
      )
      return
    }

    const registry = await agentRegistryPromise
    const agent = resolvePreferredAgent(binding, registry)
    const traceId = randomUUID()

    if (inFlightChats.has(chatKey)) {
      log.warn("telegram.message", "rejected.concurrent_turn", {
        trace_id: traceId,
        chat_id: chatKey,
        cli: binding.cli,
        session_id: binding.session_id,
        persist: true,
      })
      await replyChunks(ctx, "I am still waiting for the previous turn to finish. Please wait a moment, then send it again.")
      return
    }

    // Block new turns while a permission prompt is awaiting user response.
    // The perm: callback handler holds inFlightChats during resume, so this
    // guard covers the window between those two states.
    if (hasPendingPermission(chatKey)) {
      log.warn("telegram.message", "rejected.permission_pending", {
        trace_id: traceId,
        chat_id: chatKey,
        cli: binding.cli,
        session_id: binding.session_id,
        persist: true,
      })
      await replyChunks(ctx, "A permission request is still pending. Please respond to it first.")
      return
    }

    inFlightChats.add(chatKey)
    let typingInterval = null

    try {
      await ctx.api.sendChatAction(ctx.chat.id, "typing")

      // Keep typing indicator alive for long responses
      typingInterval = setInterval(() => {
        ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {})
      }, 4000)

      const startedAt = Date.now()
      log.info("telegram.message", "backend.send.start", {
        trace_id: traceId,
        chat_id: chatKey,
        cli: binding.cli,
        session_id: binding.session_id,
        agent,
        text_length: text.length,
      })

      const maybeGenerator = backend.sendMessage({
        sessionId: binding.session_id,
        directory: binding.directory,
        text,
        agent,
        model: binding.model ?? null,
      })

      if (maybeGenerator != null && typeof maybeGenerator[Symbol.asyncIterator] === "function") {
        // ── AsyncGenerator path (Claude, Gemini, future streaming backends) ────
        // Events stream in real-time. Permission events naturally pause the loop
        // (Claude blocks on stdin); replyPermission() in the perm: callback resumes it.
        const textParts = []
        let genSessionId = null

        for await (const event of maybeGenerator) {
          if (event.type === "text") {
            textParts.push(event.text)
          } else if (event.type === "thinking") {
            log.debug("telegram.message", "backend.send.thinking", {
              cli: binding.cli,
              session_id: binding.session_id,
              length: event.text?.length ?? 0,
            })
          } else if (event.type === "tool_use") {
            log.debug("telegram.message", "backend.send.tool_use", {
              cli: binding.cli,
              session_id: binding.session_id,
              tool: event.toolName,
              input: event.toolInput.slice(0, 120),
            })
          } else if (event.type === "permission") {
            log.info("telegram.message", "backend.send.permission", {
              trace_id: traceId,
              chat_id: chatKey,
              cli: binding.cli,
              session_id: binding.session_id,
              request_id: event.requestId,
              tool: event.toolName,
              latency_ms: Date.now() - startedAt,
              persist: true,
            })
            // Normalize to the shape surfacePermission expects (matches Kilo's req format).
            await surfacePermission(
              ctx,
              { id: event.requestId, permission: event.toolName, patterns: event.toolInput ? [event.toolInput] : [], metadata: {}, always: [] },
              chatKey, binding, agent, backend,
              null, null, -1,
            )
            // Do NOT return — the loop naturally suspends here because Claude is
            // blocked on stdin. The perm: callback writes the control_response via
            // backend.replyPermission(); Claude resumes and new events flow in.
          } else if (event.type === "question") {
            // Phase 1.1: auto-deny and ask the user to reply in the next message.
            // Full AskUserQuestion round-trip (inline keyboard + proper control_response)
            // is deferred to Phase 1.2.
            log.info("telegram.message", "backend.send.question", {
              trace_id: traceId,
              chat_id: chatKey,
              cli: binding.cli,
              session_id: binding.session_id,
              request_id: event.requestId,
              persist: true,
            })
            const q = event.questions?.[0]
            if (q?.question) {
              // redactString to prevent model-generated content from leaking secrets
              await replyChunks(ctx, `Claude asks: ${redactString(q.question)}\n\nPlease reply in your next message.`)
            }
            backend.replyPermission(event.requestId, "deny")
          } else if (event.type === "result") {
            genSessionId = event.sessionId
            log.info("telegram.message", "backend.send.success", {
              trace_id: traceId,
              chat_id: chatKey,
              cli: binding.cli,
              session_id: genSessionId ?? binding.session_id,
              latency_ms: Date.now() - startedAt,
              reply_length: textParts.reduce((s, t) => s + t.length, 0),
              input_tokens: event.inputTokens,
              output_tokens: event.outputTokens,
            })
          } else if (event.type === "error") {
            // Clear any pending permission entry — the turn is over, the generator will not
            // resume. Without this, a crash or timeout mid-permission would leave the chat
            // permanently blocked by hasPendingPermission (recoverable via /abort, but silent).
            deletePendingPermission(chatKey)
            log.warn("telegram.message", "backend.send.error_result", {
              trace_id: traceId,
              chat_id: chatKey,
              cli: binding.cli,
              session_id: binding.session_id,
              latency_ms: Date.now() - startedAt,
              message: event.message,
              persist: true,
            })
            await replyChunks(ctx, `${binding.cli} error: ${redactString(event.message)}`)
            return
          }
        }

        // Update session ID from result event (compare-and-set, same as legacy path).
        if (genSessionId && genSessionId !== binding.session_id) {
          const currentBinding = getChatBinding(ctx.chat.id)
          const stillSameSession =
            currentBinding !== null &&
            currentBinding.cli === binding.cli &&
            currentBinding.session_id === binding.session_id &&
            currentBinding.directory === binding.directory
          if (stillSameSession) {
            setChatBinding(ctx.chat.id, { ...currentBinding, session_id: genSessionId })
            log.info("telegram.message", "binding.thread_updated", {
              trace_id: traceId,
              chat_id: chatKey,
              cli: binding.cli,
              session_id: genSessionId,
              previous_session_id: binding.session_id,
              persist: true,
            })
          } else {
            log.info("telegram.message", "binding.thread_update_skipped", {
              trace_id: traceId,
              chat_id: chatKey,
              reason: "binding_changed_during_turn",
              original_cli: binding.cli,
              original_session_id: binding.session_id,
              current_cli: currentBinding?.cli ?? null,
              current_session_id: currentBinding?.session_id ?? null,
              new_thread_id: genSessionId,
              persist: true,
            })
          }
        }

        const genReply = textParts.join("\n\n")
        if (genReply) {
          await replyChunks(ctx, genReply)
        } else {
          log.warn("telegram.message", "backend.send.empty_result", {
            trace_id: traceId,
            chat_id: chatKey,
            cli: binding.cli,
            session_id: binding.session_id,
            latency_ms: Date.now() - startedAt,
            persist: true,
          })
          await replyChunks(ctx, `${binding.cli} returned no text for this turn.`)
        }
      } else {
        // ── Legacy Promise path (Kilo, Codex, Copilot, Gemini) ───────────────
        const result = await maybeGenerator

        if (result.error) {
          log.warn("telegram.message", "backend.send.error_result", {
            trace_id: traceId,
            chat_id: chatKey,
            cli: binding.cli,
            session_id: binding.session_id,
            latency_ms: Date.now() - startedAt,
            message: result.error,
            persist: true,
          })
          await replyChunks(ctx, `${binding.cli} error: ${redactString(result.error)}`)
          return
        }

        if (result.question) {
          log.info("telegram.message", "backend.send.question", {
            trace_id: traceId,
            chat_id: chatKey,
            cli: binding.cli,
            session_id: binding.session_id,
            latency_ms: Date.now() - startedAt,
            persist: true,
          })
          await surfaceQuestion(ctx, result.question, chatKey, binding, agent, backend)
          return
        }

        if (result.permission) {
          log.info("telegram.message", "backend.send.permission", {
            trace_id: traceId,
            chat_id: chatKey,
            cli: binding.cli,
            session_id: binding.session_id,
            request_id: result.permission.id,
            permission: result.permission.permission,
            latency_ms: Date.now() - startedAt,
            persist: true,
          })
          await surfacePermission(
            ctx, result.permission, chatKey, binding, agent, backend,
            binding.session_id, binding.directory, result.messageCountBefore ?? -1,
          )
          // Permission prompt surfaced. The finally block releases inFlightChats.
          // New messages are blocked by the hasPendingPermission guard above.
          // The perm: callback handler will re-acquire inFlightChats and resume the turn.
          return
        }

        if (result.text) {
          // Update session ID if backend returned a new one (e.g. Codex thread).
          //
          // Compare-and-set: re-read the binding and verify the chat is still
          // bound to the same session identity we captured at the start of the
          // turn. If the user rebound the chat during the turn so that the cli,
          // session_id, or directory changed (for example via /sessions or /new),
          // the threadId update is stale and must be dropped — applying it would
          // clobber the new binding with the old snapshot.
          if (result.threadId && result.threadId !== binding.session_id) {
            const currentBinding = getChatBinding(ctx.chat.id)
            const stillSameSession =
              currentBinding !== null &&
              currentBinding.cli === binding.cli &&
              currentBinding.session_id === binding.session_id &&
              currentBinding.directory === binding.directory

            if (stillSameSession) {
              setChatBinding(ctx.chat.id, { ...currentBinding, session_id: result.threadId })
              log.info("telegram.message", "binding.thread_updated", {
                trace_id: traceId,
                chat_id: chatKey,
                cli: binding.cli,
                session_id: result.threadId,
                previous_session_id: binding.session_id,
                persist: true,
              })
            } else {
              log.info("telegram.message", "binding.thread_update_skipped", {
                trace_id: traceId,
                chat_id: chatKey,
                reason: "binding_changed_during_turn",
                original_cli: binding.cli,
                original_session_id: binding.session_id,
                current_cli: currentBinding?.cli ?? null,
                current_session_id: currentBinding?.session_id ?? null,
                new_thread_id: result.threadId,
                persist: true,
              })
            }
          }
          log.info("telegram.message", "backend.send.success", {
            trace_id: traceId,
            chat_id: chatKey,
            cli: binding.cli,
            session_id: result.threadId || binding.session_id,
            latency_ms: Date.now() - startedAt,
            reply_length: result.text.length,
          })
          await replyChunks(ctx, result.text)
          return
        }

        log.warn("telegram.message", "backend.send.empty_result", {
          trace_id: traceId,
          chat_id: chatKey,
          cli: binding.cli,
          session_id: binding.session_id,
          latency_ms: Date.now() - startedAt,
          persist: true,
        })
        await replyChunks(ctx, `${binding.cli} returned no text for this turn.`)
      }
    } catch (error) {
      log.error("telegram.message", "backend.send.exception", {
        trace_id: traceId,
        chat_id: chatKey,
        cli: binding.cli,
        session_id: binding.session_id,
        error,
        persist: true,
      })
      if (binding.cli === "kilo") {
        await explainBackendFailure(ctx, binding, error, kilo)
      } else {
        await explainBackendFailure(ctx, binding, error, null)
      }
    } finally {
      if (typingInterval) clearInterval(typingInterval)
      inFlightChats.delete(chatKey)
    }
  }

  // ── Text message routing ──
  bot.on("message:text", async (ctx, next) => {
    // Keep raw text for the Telegram split-boundary length check — trimming
    // can shorten a 4096-char fragment (e.g., one ending in '\n' or spaces)
    // below the boundary, causing it to be dispatched immediately instead of
    // being buffered with the rest of the split.
    const rawText = ctx.message.text ?? ""
    const text = rawText.trim()
    if (!text) return

    const chatKey = String(ctx.chat.id)

    // Handle pending custom path input from "Custom path..." workspace picker button.
    // IMPORTANT: this MUST run before the slash-command filter below — Unix paths
    // always start with "/" (e.g. "/Users/foo/repo"), so the filter would otherwise
    // silently drop every legitimate custom-path input. The pendingCustomPath state
    // is set by the "newpath:" callback handler, so reaching this branch means the
    // user has explicitly opted into typing a workspace path.
    if (hasPendingCustomPath(chatKey)) {
      // If the user typed a recognized bot command (e.g. /sessions, /new) instead
      // of a path, bail out of the pending state without surfacing a confusing
      // "Path does not exist" error. Telegram tags bot commands with a "bot_command"
      // entity at offset 0, so we use that as the authoritative classifier — Unix
      // paths like /Users/foo/repo are NOT tagged as bot_command by Telegram.
      const entities = ctx.message.entities ?? []
      const isBotCommand = entities.some((e) => e.type === "bot_command" && e.offset === 0)
      if (isBotCommand) {
        deletePendingCustomPath(chatKey)
        await next?.()
        return
      }

      // Typing a custom path is a normal text input from the user's POV — clear
      // any pending inline-keyboard question for parity with the normal-text branch.
      deletePendingQuestion(chatKey)
      deletePendingCustomPath(chatKey)

      // Strict parsing: reject ambiguous forms (per-user tilde, relative paths)
      // with a clear user-facing error so the user knows what to retype.
      const parsed = parseUserPath(text)
      if (!parsed.ok) {
        await ctx.reply(`❌ ${parsed.error}\n\nUse /new to try again.`)
        return
      }

      // Filesystem validation: catch typos and stale paths at input time so they
      // don't explode later inside resolveExecCwd with a confusing ENOENT.
      const validated = validateWorkspaceDirectory(parsed.path)
      if (!validated.ok) {
        await ctx.reply(`❌ ${validated.error}\n\nUse /new to try again.`)
        return
      }

      const directory = parsed.path
      const clis = supportedClis()
      if (clis.length === 1) {
        await createNewSession(ctx, clis[0], directory, agentRegistryPromise)
      } else {
        const hash = registerPath(directory)
        const keyboard = new InlineKeyboard()
        for (const cli of clis) {
          keyboard.text(cli, `newcli:${cli}:${hash}`).row()
        }
        await ctx.reply(`Pick a CLI for ${displayPath(directory)}:`, { reply_markup: keyboard })
      }
      return
    }

    // Slash commands (e.g. "/sessions", "/new") are handled by bot.command(...)
    // handlers — ignore them here without touching pendingQuestion state. The
    // user is navigating commands, not responding to a pending AI question, so
    // any inline keyboard from a previous turn should remain valid until the
    // user either taps it, sends a real text message, or the TTL expires.
    //
    // Use Telegram's authoritative `bot_command` entity at offset 0 to detect
    // real commands — NOT a naive `text.startsWith("/")` prefix check, which
    // would silently drop any user prompt that begins with a forward slash
    // (e.g. absolute paths like `/Users/foo/repo/file.js has a typo`, or ad-hoc
    // queries about filesystem paths). Telegram only tags registered bot
    // commands with this entity, so path-like text is correctly passed through
    // to the backend. This aligns with the same classifier used in
    // `rate-limit-middleware.js` and the pendingCustomPath drain above.
    {
      const entities = ctx.message.entities ?? []
      const isBotCommand = entities.some((e) => e.type === "bot_command" && e.offset === 0)
      if (isBotCommand) { await next?.(); return }
    }

    // Clear any pending question when the user sends a normal text message.
    // This prevents stale inline keyboards from submitting conflicting answers later.
    deletePendingQuestion(chatKey)

    // Coalesce consecutive Telegram message fragments into one LLM turn.
    // When a user's input exceeds Telegram's 4096-character limit, Telegram
    // splits it into multiple consecutive messages. Without buffering, each
    // fragment would be forwarded as a separate LLM turn — changing the
    // meaning of the interaction and causing the model to respond prematurely.
    //
    // Strategy: only start a buffer when a message arrives at exactly the
    // Telegram split boundary (4096 chars) — that length is a reliable signal
    // that more fragments are on the way. Once a buffer is open, every
    // subsequent message for that chat is appended (including the final,
    // shorter fragment). When the debounce window closes with no new arrivals,
    // all buffered fragments are concatenated with no delimiter and processed
    // as one turn.
    //
    // Short standalone messages bypass the buffer entirely and are processed
    // immediately, so normal conversation feels instantaneous.
    //
    // Bypass (BRIDGE_MESSAGE_DEBOUNCE_MS=0): process immediately with no
    // buffering. Used in tests and environments where splitting is not a concern.
    if (config.bridgeMessageDebounceMs > 0) {
      const existing = messageBuffer.get(chatKey)

      if (existing) {
        // A buffer is already open for this chat — this message is a continuation
        // fragment. Reset the timer and append regardless of length.
        clearTimeout(existing.timerId)
        existing.texts.push(rawText)
        // Always track the last-received ctx so replies go to the most recent
        // Telegram message. All fragments share the same chat_id, so the
        // context is functionally equivalent for routing — using the last one
        // also means the typing indicator and replies feel natural (they
        // follow the user's most recent message).
        existing.ctx = ctx
      } else if (rawText.length === TELEGRAM_SPLIT_LENGTH) {
        // No existing buffer but the message is at Telegram's split boundary —
        // start a new buffer. Messages shorter than 4096 chars are standalone
        // and processed immediately below.
        messageBuffer.set(chatKey, { texts: [rawText], ctx })
      } else {
        // Short standalone message — skip buffering, dispatch immediately.
        await processTextMessage(ctx, chatKey, text)
        return
      }

      const entry = messageBuffer.get(chatKey)
      const timerId = setTimeout(async () => {
        const flushed = messageBuffer.get(chatKey)
        if (!flushed) return

        try {
          messageBuffer.delete(chatKey)
          const combinedText = flushed.texts.join("")
          log.debug("telegram.message", "fragments.coalesced", {
            chat_id: chatKey,
            fragment_count: flushed.texts.length,
            combined_length: combinedText.length,
          })
          await processTextMessage(flushed.ctx, chatKey, combinedText)
        } catch (error) {
          if (messageBuffer.get(chatKey) === flushed) {
            messageBuffer.delete(chatKey)
          }
          log.error("telegram.message", "fragments.flush_failed", {
            chat_id: chatKey,
            fragment_count: flushed.texts.length,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }, config.bridgeMessageDebounceMs)
      entry.timerId = timerId
      entry.timerId.unref?.()
      return
    }

    await processTextMessage(ctx, chatKey, text)
  })
}
