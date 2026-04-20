import { Bot, GrammyError, HttpError } from "grammy"
import { createAgentRegistry } from "./agent-registry.js"
import { scanAll, startWatcher } from "./cli-scanner.js"
import { config } from "./config.js"
import { KiloClient } from "./kilo-client.js"
import { KiloBackend, CodexBackend, CopilotBackend, GeminiBackend, ClaudeBackend, LmStudioBackend, registerBackend, detectAvailableClis } from "./backends.js"
import { authorizedUserId, displayPath } from "./telegram-utils.js"
import { setupCommands } from "./commands.js"
import { setupHandlers, clearMessageBuffer, clearPendingPermission, deletePendingCustomPath } from "./message-handler.js"
import { log, redactString, flushLogFile } from "./log.js"
import { rateLimitMiddleware } from "./rate-limit-middleware.js"
import { closeLogStore, pruneLogStore, flushLogStore } from "./log-store.js"
import { startKiloServer, stopKiloServer } from "./kilo-server.js"

const bot = new Bot(config.telegramBotToken)
const agentRegistry = createAgentRegistry(config)

// ── Auth middleware ──

bot.use(async (ctx, next) => {
  if (!ctx.from) return

  const allowed = authorizedUserId()
  if (!allowed) {
    await ctx.reply(
      [
        "Bridge bootstrap mode.",
        `Your Telegram user ID is: ${ctx.from.id}`,
        "Set TELEGRAM_ALLOWED_USER_ID in .env, then restart the bot.",
      ].join("\n"),
    )
    return
  }

  if (String(ctx.from.id) !== allowed) {
    await ctx.reply("Not authorized.")
    return
  }

  await next()
})

// ── Rate-limit middleware ──
// MUST be registered AFTER the auth middleware above so that unauthorised
// users are rejected before consuming a rate-limit bucket slot.

bot.use(rateLimitMiddleware)

// ── Slash-command buffer middleware ──
// Runs before all command handlers so that buffered text fragments from a prior
// debounce window are discarded when the user sends a slash command. Without
// this, the timer could fire after /detach, /new, or /cleanup and flush stale
// fragments against an already-changed binding or conversational state.
// Also clears any pending permission so that /abort or /detach does not leave
// the chat stuck behind the hasPendingPermission guard, and any pending
// custom-path prompt so that the next plain-text message is not consumed as
// a workspace path after the user has changed their mind.
//
// Command detection uses Telegram's authoritative `bot_command` entity at
// offset 0 (not `text.startsWith("/")`) so that absolute paths the user might
// paste (e.g. `/Users/foo/repo`) are NOT misclassified as commands and do not
// trigger pending-state cleanup.
bot.use(async (ctx, next) => {
  if (!ctx.chat?.id) return next()
  const entities = ctx.message?.entities ?? []
  const isBotCommand = entities.some((e) => e.type === "bot_command" && e.offset === 0)
  if (isBotCommand) {
    const chatKey = String(ctx.chat.id)
    clearMessageBuffer(chatKey)
    clearPendingPermission(chatKey)
    deletePendingCustomPath(chatKey)
  }
  return next()
})

// ── Error handler ──

// Redact secrets from error strings before logging or user display.
function redact(input) {
  if (!input) return input
  return redactString(typeof input === "string" ? input : String(input))
}

bot.catch((error) => {
  const ctx = error.ctx
  log.error("telegram.bot", "update.failed", {
    update_id: ctx.update.update_id,
    persist: true,
  })
  const inner = error.error
  if (inner instanceof GrammyError) {
    log.error("telegram.bot", "api_error", {
      message: redact(inner.description),
      persist: true,
    })
    return
  }
  if (inner instanceof HttpError) {
    log.error("telegram.bot", "http_error", {
      message: redact(inner.message),
      persist: true,
    })
    return
  }
  log.error("telegram.bot", "unexpected_error", {
    message: redact(inner?.message || inner),
    persist: true,
  })
})

// ── Main ──

function installShutdownHandlers(getPruneTimer) {
  let shuttingDown = false

  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true

    const timer = getPruneTimer()
    if (timer) clearInterval(timer)

    try {
      log.info("shutdown", "signal.received", {
        signal,
        persist: true,
      })
    } finally {
      try {
        bot.stop()
      } catch {}
      await stopKiloServer({ gracePeriodMs: 5000 })
      flushLogStore()
      await flushLogFile()
      closeLogStore()
      process.exit(0)
    }
  }

  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

async function main() {
  if (config.dryRun) {
    log.info("startup", "dry_run.ok", { message: "Bridge configuration loaded successfully." })
    return
  }

  // Install signal handlers early — before startKiloServer — so that a SIGINT/SIGTERM
  // received during the up-to-30s readiness probe still triggers cleanup.
  // pruneTimer is captured by reference; it will be populated below once the interval is set.
  let pruneTimer = null
  installShutdownHandlers(() => pruneTimer)

  // ── Kilo server lifecycle ──
  // Kilo is optional: if it cannot start (binary missing, config error, port conflict),
  // the bridge boots with non-Kilo backends only and logs a warning instead of exiting.
  // All Kilo-specific code paths in commands/handlers are gated on `kilo !== null`
  // (or on `binding.cli === "kilo"`, which can never be true for new sessions when
  // Kilo is not registered as a backend).
  let kilo = null
  let kiloBaseUrl = null // retained only for the startup log below

  const externalUrl = config.kiloServeUrlExplicit
  if (externalUrl) {
    kiloBaseUrl = externalUrl
    kilo = new KiloClient({
      baseUrl: kiloBaseUrl,
      username: config.kiloServerUsername,
      password: config.kiloServerPassword,
    })
    registerBackend(new KiloBackend(kilo))
    log.info("bridge.startup", "kilo_external_mode", { url: kiloBaseUrl, persist: true })
  } else {
    try {
      const kiloHandle = await startKiloServer({ port: config.kiloServePort })
      kiloBaseUrl = kiloHandle.baseUrl
      kilo = new KiloClient({
        baseUrl: kiloBaseUrl,
        username: config.kiloServerUsername,
        password: "",
      })
      registerBackend(new KiloBackend(kilo))
      log.info("bridge.startup", "kilo_server_ready", {
        pid: kiloHandle.pid,
        base_url: kiloBaseUrl,
        persist: true,
      })
    } catch (error) {
      log.warn("bridge.startup", "kilo_unavailable", {
        error: error.message,
        persist: true,
      })
      // kilo remains null; Kilo backend is disabled for this session.
    }
  }

  // Register non-Kilo backends unconditionally.
  registerBackend(new CodexBackend())
  registerBackend(new CopilotBackend())
  registerBackend(new GeminiBackend())
  registerBackend(new ClaudeBackend())
  registerBackend(new LmStudioBackend())

  const initialRegistry = await agentRegistry.refresh()
  if (agentRegistry.hasLoaded()) {
    log.info("startup", "agent_registry.loaded", { agent_count: initialRegistry.primaryAgents.length })
  }

  // Mount routes (must happen before bot.start())
  setupCommands(bot, kilo, agentRegistry)
  setupHandlers(bot, kilo, agentRegistry)

  const pruned = pruneLogStore()
  if (pruned) {
    log.info("startup", "log_store.pruned", { deleted_count: pruned, persist: true })
  }

  pruneTimer = setInterval(() => {
    try {
      const deleted = pruneLogStore()
      if (deleted) {
        log.info("maintenance", "log_store.pruned", { deleted_count: deleted, persist: true })
      }
    } catch (error) {
      log.warn("maintenance", "log_store.prune_failed", { error, persist: true })
    }
  }, 60 * 60 * 1000)
  pruneTimer.unref?.()

  // Scan CLI sessions into local SQLite
  const count = await scanAll()
  log.info("startup", "sessions.indexed", { session_count: count })
  startWatcher()
  detectAvailableClis()

  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Show bridge status" },
      { command: "sessions", description: "Browse recent sessions (all CLIs)" },
      { command: "clis", description: "List discovered CLIs and session counts" },
      { command: "new", description: "Create a new session" },
      { command: "agents", description: "List available agents (Kilo only)" },
      { command: "agent", description: "Set preferred agent (Kilo only)" },
      { command: "models", description: "List available models (Claude/Codex)" },
      { command: "model", description: "Set model for current session (Claude/Codex)" },
      { command: "rename", description: "Rename current session" },
      { command: "status", description: "Show current session status" },
      { command: "abort", description: "Abort current session" },
      { command: "cleanup", description: "Preview/delete old bridge sessions" },
      { command: "detach", description: "Unbind current session" },
    ])
  } catch (error) {
    log.warn("startup", "telegram.command_registration_failed", {
      error,
      persist: true,
    })
  }

  log.info("startup", "bridge.starting", {
    kilo_url: kiloBaseUrl ?? "disabled",
    default_directory: displayPath(config.defaultDirectory),
    default_agent: config.bridgeDefaultAgent,
    log_level: config.logLevel,
    log_file_path: config.logFilePath,
    log_db_path: config.logDbPath,
  })

  if (!authorizedUserId()) {
    log.info("startup", "bootstrap_mode.enabled", { persist: true })
  }

  await bot.start()
}

main().catch((error) => {
  log.error("startup", "bridge.crashed", { error, persist: true })
  process.exit(1)
})

