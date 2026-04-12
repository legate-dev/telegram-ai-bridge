import { InlineKeyboard } from "grammy"
import { config } from "./config.js"
import { getChatBinding, setChatBinding, clearChatBinding, recentSessions, sessionCountsByCli, recentWorkspaces, getCliSessionById, renameSession, upsertCliSession, getKiloBridgeSessions } from "./db.js"
import { getBackend, supportedClis } from "./backends.js"
import { refreshKiloMirror } from "./cli-scanner.js"
import { encodeModelCallbackSlug, getModelsForCli } from "./model-discovery.js"
import { log, redactString } from "./log.js"
import { generateSessionTitle } from "./session-title.js"
import {
  replyChunks,
  resolvePreferredAgent,
  hasBoundSession,
  displayPath,
  formatSessionLine,
  resolveDirectory,
  compactPath,
  registerPath,
  resolveSessionLabel,
} from "./telegram-utils.js"

export { generateSessionTitle } from "./session-title.js"

// Telegram inline keyboard limits: callback_data ≤ 64 bytes, practical cap on
// total buttons before the keyboard silently fails or becomes unusable.
const MAX_MODELS_IN_KEYBOARD = 25

function supportsAgentSelection(binding) {
  return !binding?.cli || binding.cli === "kilo"
}

function supportsModelSelection(binding) {
  const cli = binding?.cli
  return cli === "claude" || cli === "codex" || cli === "lmstudio"
}

// For Kilo, cli_sessions.message_count holds the exact user-turn count
// (one row per real user prompt — see scanKilo). No estimation needed.
function getUserTurnCount(messageCount) {
  const numeric = Number(messageCount)
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0
}

function getCleanupMaxRounds() {
  const numeric = Number(config.kiloCleanupMaxRounds)
  if (!Number.isFinite(numeric) || numeric < 0) return 5
  return Math.floor(numeric)
}

/**
 * Splits bridge-owned Kilo sessions into eligible (deletable) and protected
 * (kept by policy) buckets.
 *
 * Inputs come from the local mirror via getKiloBridgeSessions(boundId), so
 * the bound session is already excluded and ownership is deterministic
 * (source='bridge' in cli_sessions). The only volatile lookup is `statuses`,
 * which we pass in from a live kilo.getAllStatuses() call so we know which
 * eligible sessions need to be aborted before deletion.
 */
function classifyCleanupCandidates(bridgeSessions, statuses) {
  const eligible = []
  const protectedSessions = []
  const cleanupMaxRounds = getCleanupMaxRounds()

  for (const row of bridgeSessions) {
    const userTurns = getUserTurnCount(row.message_count)
    const session = { id: row.session_id, title: row.display_name || row.title }

    if (userTurns > cleanupMaxRounds) {
      protectedSessions.push({
        session,
        reason: "too-many-rounds",
        userTurns,
      })
      continue
    }

    eligible.push({
      session,
      userTurns,
      isBusy: statuses[row.session_id]?.type === "busy",
    })
  }

  return { eligible, protectedSessions }
}

export async function createNewSession(ctx, cli, directory, agentRegistryPromise) {
  const existing = getChatBinding(ctx.chat.id)
  const registry = await agentRegistryPromise
  const agent = resolvePreferredAgent(existing, registry)
  const backend = getBackend(cli)

  if (!backend) {
    await replyChunks(ctx, `No backend available for ${cli}.`)
    return
  }

  const title = generateSessionTitle(directory)
  const session = await backend.createSession({
    title,
    directory,
  })

  // Tag bridge-created sessions with a deterministic flag in the local mirror.
  // This is the ground truth /cleanup uses to identify "ours" — replaces the
  // legacy title-pattern heuristic. Only Kilo participates in cleanup, but we
  // tag all CLIs for consistency and forward-compat.
  //
  // Failure mode (R2): the session already exists in the backend (created
  // above), so a DB error here MUST NOT leave the session orphaned without
  // a binding and without the source='bridge' tag. We log the failure with
  // persist=true and tell the user the session ID so they can recover it
  // via /sessions, but we do NOT proceed to setChatBinding (the binding
  // would be useless without the source tag, since /cleanup would never
  // find the session anyway).
  try {
    upsertCliSession({
      cli,
      session_id: session.id,
      workspace: directory || ".",
      title,
      message_count: 0,
      last_activity: new Date().toISOString(),
      resume_cmd: null,
      source: "bridge",
    })
  } catch (upsertError) {
    log.error("telegram.command", "session.upsert_failed", {
      chat_id: String(ctx.chat.id),
      cli,
      session_id: session.id,
      message: upsertError.message,
      persist: true,
    })
    await replyChunks(
      ctx,
      `Session created in ${cli} (id: ${session.id}) but the local mirror could not be updated. `
        + `The session is NOT bound to this chat. You may need to /sessions to find it manually. `
        + `Reason: ${redactString(upsertError.message)}`,
    )
    return
  }

  setChatBinding(ctx.chat.id, {
    cli,
    session_id: session.id,
    agent,
    model: null,
    directory,
  })
  log.info("telegram.command", "session.created", {
    chat_id: String(ctx.chat.id),
    cli,
    session_id: session.id,
    directory,
    agent,
    persist: true,
  })

  await replyChunks(
    ctx,
    [
      `New ${cli} session created.`,
      `Session: ${session.id}`,
      cli === "kilo" ? `Agent: ${agent}` : "",
      `Directory: ${displayPath(directory)}`,
    ].filter(Boolean).join("\n"),
  )
}

export function setupCommands(bot, kilo, agentRegistryPromise) {
  bot.command("start", async (ctx) => {
    const binding = getChatBinding(ctx.chat.id)
    const registry = await agentRegistryPromise
    const preferredAgent = resolvePreferredAgent(binding, registry)
    const lines = ["Telegram Bridge online."]
    if (!hasBoundSession(binding)) {
      lines.push("No session bound. Use /sessions to pick one or /new to create one.")
    } else {
      lines.push(`Session: [${binding.cli}] ${resolveSessionLabel(binding)}`)
      if (binding.cli === "kilo") lines.push(`Agent: ${preferredAgent}`)
    }

    await replyChunks(ctx, lines.join("\n"))
  })

  bot.command("sessions", async (ctx) => {
    const arg = ctx.match?.trim()
    const limitMatch = arg?.match(/^\d+$/)
    const cliFilter = limitMatch ? null : arg || null
    const limit = limitMatch ? parseInt(arg, 10) : 10

    const rows = recentSessions({ cli: cliFilter, limit })
    if (!rows.length) {
      await replyChunks(ctx, cliFilter ? `No sessions found for ${cliFilter}.` : "No sessions found. Run the bridge with CLI tools first.")
      return
    }

    const keyboard = new InlineKeyboard()
    const lines = [`Last ${rows.length} sessions${cliFilter ? ` (${cliFilter})` : ""}:`]

    for (const [i, row] of rows.entries()) {
      lines.push(`${i + 1}. ${formatSessionLine(row)}`)
      keyboard.text(
        `${i + 1}. [${row.cli}] ${redactString(row.display_name || row.title || row.session_id).slice(0, 20)}`,
        `bind:${row.cli}:${row.session_id}`,
      ).row()
    }

    await ctx.reply(lines.join("\n"), { reply_markup: keyboard })
  })

  bot.command("clis", async (ctx) => {
    const counts = sessionCountsByCli()
    if (!counts.length) {
      await replyChunks(ctx, "No CLI sessions discovered yet.")
      return
    }

    const lines = ["Discovered CLIs:"]
    for (const row of counts) {
      lines.push(`- ${row.cli}: ${row.count} sessions`)
    }
    lines.push("", "Use /sessions <cli> to filter.")

    await replyChunks(ctx, lines.join("\n"))
  })

  bot.command("agents", async (ctx) => {
    const binding = getChatBinding(ctx.chat.id)
    if (!supportsAgentSelection(binding)) {
      await replyChunks(ctx, `Agent selection is not available for ${binding.cli}. Model configuration is managed in the CLI directly.`)
      return
    }

    const registry = await agentRegistryPromise
    const preferredAgent = resolvePreferredAgent(binding, registry)

    const lines = [
      `Bridge default agent: ${registry.bridgeDefault}`,
      `Current chat agent: ${preferredAgent}`,
      config.bridgeAgentFallbacks.length ? `Fallback suggestions: ${config.bridgeAgentFallbacks.join(", ")}` : "",
      "Available primary agents:",
      ...registry.primaryAgents.map((agent) => `- ${agent}`),
    ].filter(Boolean)

    await replyChunks(ctx, lines.join("\n"))
  })

  bot.command("agent", async (ctx) => {
    const binding = getChatBinding(ctx.chat.id)
    if (!supportsAgentSelection(binding)) {
      await replyChunks(ctx, `Agent selection is not supported for ${binding.cli} sessions. Model selection is configured directly in ${binding.cli}.`)
      return
    }

    const requestedAgent = ctx.match?.trim()
    if (!requestedAgent) {
      const registry = await agentRegistryPromise
      const preferredAgent = resolvePreferredAgent(binding, registry)
      await replyChunks(
        ctx,
        [
          `Current chat agent: ${preferredAgent}`,
          "Usage: /agent <name>. Use /agents to list primary agents.",
        ].join("\n"),
      )
      return
    }

    const registry = await agentRegistryPromise
    if (!registry.primaryAgents.includes(requestedAgent)) {
      await replyChunks(
        ctx,
        `Unknown or unsupported agent: ${requestedAgent}. Use /agents and pick a primary agent, not a subagent.`,
      )
      return
    }

    setChatBinding(ctx.chat.id, {
      ...(binding ?? { cli: "kilo", session_id: "", directory: config.defaultDirectory }),
      agent: requestedAgent,
    })
    log.info("telegram.command", "agent.updated", {
      chat_id: String(ctx.chat.id),
      cli: binding?.cli || "kilo",
      session_id: binding?.session_id || null,
      agent: requestedAgent,
      persist: true,
    })

    await replyChunks(ctx, `Preferred agent set to ${requestedAgent}. New messages will use it.`)
  })

  bot.command("models", async (ctx) => {
    const binding = getChatBinding(ctx.chat.id)
    if (!hasBoundSession(binding)) {
      await replyChunks(ctx, "No session bound. Use /sessions or /new first.")
      return
    }

    const cli = binding.cli
    if (cli === "kilo") {
      await replyChunks(ctx, "Use /agents for Kilo model selection.")
      return
    }

    const models = await getModelsForCli(cli)
    if (!models) {
      await replyChunks(ctx, `Model selection is not supported for ${cli}.`)
      return
    }

    if (!models.length) {
      const hint = cli === "lmstudio"
        ? `No models available. Make sure LM Studio is running and at least one model is loaded.`
        : `No models available for ${cli}. Run ${cli} at least once to populate the models cache.`
      await replyChunks(ctx, hint)
      return
    }

    // Telegram limits callback_data to 64 bytes. LM Studio model keys can
    // exceed this (e.g., "dolphin-mistral-glm-4.7-flash-24b-venice-edition-...").
    // Use numeric index for LM Studio to avoid truncation ambiguity; the handler
    // resolves the index back to the full slug via getModelsForCli.
    const keyboard = new InlineKeyboard()
    const lines = [`Available models for ${cli}:`]
    const displayed = models.slice(0, MAX_MODELS_IN_KEYBOARD)
    for (const [i, m] of displayed.entries()) {
      lines.push(`${i + 1}. ${m.displayName}`)
      const cbData = `setmodel:${encodeModelCallbackSlug(cli, m.slug, i)}`
      keyboard.text(`${i + 1}. ${m.displayName}`, cbData).row()
    }
    if (models.length > MAX_MODELS_IN_KEYBOARD) {
      lines.push(`\n…and ${models.length - MAX_MODELS_IN_KEYBOARD} more (showing top ${MAX_MODELS_IN_KEYBOARD} by priority).`)
    }
    if (binding.model) lines.push(`\nCurrent: ${binding.model}`)

    await ctx.reply(lines.join("\n"), { reply_markup: keyboard })
  })

  bot.command("model", async (ctx) => {
    const binding = getChatBinding(ctx.chat.id)
    if (!hasBoundSession(binding)) {
      await replyChunks(ctx, "No session bound. Use /sessions or /new first.")
      return
    }

    const cli = binding.cli
    if (cli === "kilo") {
      await replyChunks(ctx, "Use /agents for Kilo model selection.")
      return
    }

    if (!supportsModelSelection(binding)) {
      await replyChunks(ctx, `Model selection is not supported for ${cli}.`)
      return
    }

    const requestedModel = ctx.match?.trim()
    if (!requestedModel) {
      await replyChunks(
        ctx,
        [
          binding.model ? `Current model: ${binding.model}` : "No model set (using CLI default).",
          "Usage:",
          "  /model <name>  — set a model",
          "  /model clear   — reset to CLI default",
          "  /models        — list available models",
        ].join("\n"),
      )
      return
    }

    if (requestedModel === "clear") {
      setChatBinding(ctx.chat.id, { ...binding, model: null })
      log.info("telegram.command", "model.cleared", {
        chat_id: String(ctx.chat.id),
        cli,
        session_id: binding.session_id,
        persist: true,
      })
      await replyChunks(ctx, "Model cleared. New messages will use the CLI default.")
      return
    }

    setChatBinding(ctx.chat.id, { ...binding, model: requestedModel })
    log.info("telegram.command", "model.updated", {
      chat_id: String(ctx.chat.id),
      cli,
      session_id: binding.session_id,
      model: requestedModel,
      persist: true,
    })

    await replyChunks(ctx, `Model set to ${requestedModel}. New messages will use it.`)
  })

  bot.command("abort", async (ctx) => {
    const binding = getChatBinding(ctx.chat.id)
    if (!hasBoundSession(binding)) {
      await replyChunks(ctx, "No session bound. Nothing to abort.")
      return
    }

    const backend = getBackend(binding.cli)
    if (!backend) {
      await replyChunks(ctx, `No backend for ${binding.cli}. Nothing to abort.`)
      return
    }

    try {
      const status = await backend.getSessionStatus(binding.session_id)
      await backend.abortSession(binding.session_id)
      log.info("telegram.command", "session.aborted", {
        chat_id: String(ctx.chat.id),
        cli: binding.cli,
        session_id: binding.session_id,
        status: status?.type ?? "unknown",
        persist: true,
      })
      await replyChunks(
        ctx,
        `Aborted [${binding.cli}] session ${resolveSessionLabel(binding)} (was: ${status?.type ?? "unknown"}).`,
      )
    } catch (error) {
      await replyChunks(ctx, `Abort failed: ${redactString(error.message)}`)
    }
  })

  bot.command("cleanup", async (ctx) => {
    try {
      if (!kilo) {
        await replyChunks(ctx, "Kilo is not available on this machine. The /cleanup command only manages Kilo sessions.")
        return
      }

      // Defensive: ctx.match?.trim().toLowerCase() crashes if ctx.match is
      // undefined because the optional chain only short-circuits .trim(),
      // not .toLowerCase(). Use a safe default instead.
      const requestedAction = (ctx.match ?? "").trim().toLowerCase()
      const confirmed = requestedAction === "confirm"
      const binding = getChatBinding(ctx.chat.id)
      const boundId = binding?.cli === "kilo" ? binding.session_id : null

      // Refresh the Kilo mirror specifically so preview and confirm see the
      // same fresh world. We call refreshKiloMirror() (not scanAll()) for
      // two reasons:
      //
      //   1. R4: /cleanup is Kilo-specific; scanAll() would also walk Claude,
      //      Codex, Copilot, Qwen, Gemini filesystems on every invocation,
      //      adding multi-second latency and risking Telegram timeouts for
      //      users with large non-Kilo workspace histories.
      //
      //   2. B1/N1 (THE IMPORTANT ONE): scanAll() swallows per-CLI failures
      //      silently — when scanKilo returns ok=false, scanAll completes
      //      normally without throwing and without updating/reconciling the
      //      Kilo mirror. A try/catch around scanAll() would never catch
      //      this case, meaning /cleanup confirm could proceed on a stale
      //      mirror and delete the wrong session. refreshKiloMirror() returns
      //      an explicit {ok} boolean so the handler can fail-closed.
      //
      // Safety contract: the refresh result is FATAL on the confirm path.
      // /cleanup confirm is destructive — operating on stale mirror data
      // could mis-classify a now-protected session as eligible and delete
      // real conversational history. We fail closed on either a throw OR
      // ok=false. On the preview path we degrade gracefully with a warning.
      let refreshOk = true
      let refreshError = null
      try {
        const refresh = await refreshKiloMirror()
        refreshOk = refresh.ok
      } catch (error) {
        refreshOk = false
        refreshError = error
      }

      if (!refreshOk) {
        log.warn("telegram.command", "cleanup.refresh_degraded", {
          chat_id: String(ctx.chat.id),
          confirmed,
          message: refreshError?.message ?? "kilo scan returned ok=false",
        })
        if (confirmed) {
          await replyChunks(
            ctx,
            "Cleanup aborted: failed to refresh the local Kilo mirror, so the eligible "
              + "session list may be stale. Run `/cleanup` again (preview) to recheck."
              + (refreshError ? ` Reason: ${redactString(refreshError.message)}` : ""),
          )
          return
        }
      }
      const scanFailed = !refreshOk

      // Source of truth: local mirror filtered by source='bridge'.
      // Pre-migration sessions and externally-created Kilo sessions have
      // source=NULL and are intentionally invisible to /cleanup.
      const bridgeSessions = getKiloBridgeSessions(boundId)
      const statuses = await kilo.getAllStatuses()
      const { eligible, protectedSessions } = classifyCleanupCandidates(bridgeSessions, statuses)

      if (!eligible.length && !protectedSessions.length) {
        await replyChunks(ctx, "No bridge-created Kilo sessions found.")
        return
      }

      if (!confirmed) {
        const busyCount = eligible.filter(({ isBusy }) => isBusy).length
        const preview = eligible
          .slice(0, 5)
          .map(({ session, userTurns }) => `- ${redactString(session.title || session.id).slice(0, 48)} (${userTurns} user turns)`)
        const hiddenCount = eligible.length - preview.length
        const cleanupMaxRounds = getCleanupMaxRounds()
        const protectedByRounds = protectedSessions.filter(({ reason }) => reason === "too-many-rounds").length
        // .filter(line => line != null) drops only null/undefined (from the
        // conditional expressions above) while keeping intentional "" entries
        // that produce blank-line separators. .filter(Boolean) would also
        // strip "" and collapse the preview into a single dense block.
        // R6: only show the "Run /cleanup confirm" footer when there is
        // actually something to confirm. With 0 eligible (e.g., all sessions
        // are protected by the user-turn threshold), the previous behavior
        // told the user to confirm an action that would delete nothing,
        // which is confusing UX.
        const hasDeletable = eligible.length > 0
        await replyChunks(
          ctx,
          [
            scanFailed ? "⚠️ Mirror refresh failed — preview may be stale. Re-run /cleanup before confirming." : null,
            scanFailed ? "" : null,
            `Cleanup preview: ${eligible.length} bridge-created Kilo session(s) would be deleted${busyCount ? ` (${busyCount} busy)` : ""}.`,
            boundId ? `Current bound session kept: ${boundId.slice(0, 12)}.` : "No current session is protected by binding.",
            protectedByRounds ? `${protectedByRounds} bridge-created session(s) are protected because they exceed ${cleanupMaxRounds} user turns.` : null,
            preview.length ? "" : null,
            ...preview,
            hiddenCount > 0 ? `- …and ${hiddenCount} more` : null,
            hasDeletable ? "" : null,
            hasDeletable
              ? "Run `/cleanup confirm` to delete them."
              : "No deletions would occur. All bridge-created sessions are protected.",
          ].filter((line) => line != null).join("\n"),
        )
        return
      }

      // Race protection (R1): re-read the binding immediately before the
      // delete loop. A concurrent /new can have created and bound a fresh
      // bridge session AFTER the initial getKiloBridgeSessions() snapshot
      // but BEFORE we start deleting. The new session lives in the local
      // mirror with source='bridge' and would be eligible for deletion
      // unless we exclude its id at delete time.
      const refreshedBinding = getChatBinding(ctx.chat.id)
      const refreshedBoundId = refreshedBinding?.cli === "kilo" ? refreshedBinding.session_id : null
      const protectedDuringRace = refreshedBoundId && refreshedBoundId !== boundId

      let aborted = 0
      let deleted = 0
      let raceSkipped = 0
      for (const { session, isBusy } of eligible) {
        // Belt-and-braces: skip the freshly-bound session even though it
        // wasn't in our original eligible list (because it was created
        // after our snapshot). The id may or may not be present in
        // `eligible`, but if it is, never touch it.
        if (refreshedBoundId && session.id === refreshedBoundId) {
          raceSkipped++
          continue
        }
        try {
          if (isBusy) {
            await kilo.abortSession(session.id)
            aborted++
          }
          await kilo.deleteSession(session.id)
          deleted++
        } catch {}
      }

      await replyChunks(
        ctx,
        `Cleanup: ${deleted} zombie sessions deleted${aborted ? ` (${aborted} aborted first)` : ""}.`
          + ` Kept current: ${(refreshedBoundId ?? boundId)?.slice(0, 12) ?? "none"}.`
          + (protectedSessions.length ? ` Protected by policy: ${protectedSessions.length}.` : "")
          + (protectedDuringRace ? ` Protected from race: 1 newly-bound session.` : ""),
      )
      log.info("telegram.command", "session.cleanup_completed", {
        chat_id: String(ctx.chat.id),
        cli: "kilo",
        deleted_count: deleted,
        aborted_count: aborted,
        protected_count: protectedSessions.length,
        race_skipped: raceSkipped,
        kept_session_id: refreshedBoundId ?? boundId ?? null,
        binding_changed_during_cleanup: protectedDuringRace,
        persist: true,
      })
    } catch (error) {
      await replyChunks(ctx, `Cleanup failed: ${redactString(error.message)}`)
    }
  })

  bot.command("new", async (ctx) => {
    const raw = ctx.match?.trim()
    const clis = supportedClis()

    // Parse: /new codex ~/my-project  OR  /new ~/my-project  OR  /new codex  OR  /new
    const parts = raw ? raw.split(/\s+/) : []
    const firstIsCliName = parts.length > 0 && clis.includes(parts[0])
    const requestedCli = firstIsCliName ? parts[0] : null
    const pathArg = firstIsCliName ? parts.slice(1).join(" ") || null : raw || null

    // /new <cli> [path] → skip workspace picker (existing shortcut behavior)
    if (requestedCli) {
      const directory = resolveDirectory(pathArg, ctx.chat.id)
      await createNewSession(ctx, requestedCli, directory, agentRegistryPromise)
      return
    }

    // /new <path> (path provided but no CLI) → skip workspace picker, show CLI picker
    if (pathArg) {
      const directory = resolveDirectory(pathArg, ctx.chat.id)
      if (clis.length > 1) {
        const hash = registerPath(directory)
        const keyboard = new InlineKeyboard()
        for (const cli of clis) {
          keyboard.text(cli, `newcli:${cli}:${hash}`).row()
        }
        await ctx.reply(`Pick a CLI for ${displayPath(directory)}:`, { reply_markup: keyboard })
      } else {
        await createNewSession(ctx, clis[0], directory, agentRegistryPromise)
      }
      return
    }

    // /new (no args) → show workspace picker if history exists, else fall back to CLI picker
    const workspaces = recentWorkspaces(8)
    if (!workspaces.length) {
      const directory = resolveDirectory(null, ctx.chat.id)
      if (clis.length > 1) {
        const hash = registerPath(directory)
        const keyboard = new InlineKeyboard()
        for (const cli of clis) {
          keyboard.text(cli, `newcli:${cli}:${hash}`).row()
        }
        await ctx.reply("Pick a CLI for the new session:", { reply_markup: keyboard })
      } else {
        await createNewSession(ctx, clis[0], directory, agentRegistryPromise)
      }
      return
    }

    const keyboard = new InlineKeyboard()
    for (const ws of workspaces) {
      const label = `${compactPath(ws.workspace)} (${ws.count})`
      const hash = registerPath(ws.workspace)
      keyboard.text(label, `newws:${hash}`).row()
    }
    keyboard.text("Custom path...", "newpath:").row()
    await ctx.reply("Pick a workspace:", { reply_markup: keyboard })
  })

  // Note: newcli: callback handled in message-handler.js alongside bind: callbacks

  bot.command("detach", async (ctx) => {
    const binding = getChatBinding(ctx.chat.id)
    if (!hasBoundSession(binding)) {
      await replyChunks(ctx, "No session bound.")
      return
    }
    clearChatBinding(ctx.chat.id)
    log.info("telegram.command", "session.detached", {
      chat_id: String(ctx.chat.id),
      cli: binding.cli,
      session_id: binding.session_id,
      persist: true,
    })
    await replyChunks(ctx, `Detached from [${binding.cli}] ${resolveSessionLabel(binding)}.`)
  })

  bot.command("rename", async (ctx) => {
    const binding = getChatBinding(ctx.chat.id)
    if (!hasBoundSession(binding)) {
      await replyChunks(ctx, "No session bound. Use /sessions or /new first.")
      return
    }

    const rawName = ctx.match?.trim()
    if (!rawName) {
      const session = getCliSessionById(binding.cli, binding.session_id)
      const currentName = session?.display_name || session?.title || binding.session_id.slice(0, 12)
      await replyChunks(ctx, `Usage: /rename <name>\n\nCurrent: ${currentName}`)
      return
    }

    // Normalize: collapse whitespace, strip control chars, cap length
    const newName = rawName.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, 64)

    const result = renameSession(binding.cli, binding.session_id, newName)
    if (!result.changes) {
      await replyChunks(ctx, "Session not found in local database. Try /sessions to rebind.")
      return
    }

    log.info("telegram.command", "session.renamed", {
      chat_id: String(ctx.chat.id),
      cli: binding.cli,
      session_id: binding.session_id,
      display_name: newName,
      persist: true,
    })

    await replyChunks(ctx, `Session renamed to: ${newName}`)
  })

  bot.command("status", async (ctx) => {
    const binding = getChatBinding(ctx.chat.id)
    const registry = await agentRegistryPromise
    const preferredAgent = resolvePreferredAgent(binding, registry)

    if (!hasBoundSession(binding)) {
      await replyChunks(ctx, "No session bound. Use /sessions or /new.")
      return
    }

    const lines = [
      "Current binding:",
      `CLI: ${binding.cli}`,
      `Session: ${resolveSessionLabel(binding)}`,
      `Directory: ${displayPath(binding.directory)}`,
    ]

    if (binding.cli === "kilo") {
      lines.splice(3, 0, `Agent: ${preferredAgent}`)
    }

    if (supportsModelSelection(binding) && binding.model) {
      lines.push(`Model: ${binding.model}`)
    }

    await replyChunks(ctx, lines.join("\n"))
  })
}
