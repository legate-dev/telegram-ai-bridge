import { mock, test } from "node:test"
import assert from "node:assert/strict"
import { writeFile, rm, mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

const warnEvents = []

await mock.module("../src/log.js", {
  namedExports: {
    log: {
      debug: () => {},
      info: () => {},
      warn: (domain, event, meta) => { warnEvents.push({ domain, event, meta }) },
      error: () => {},
    },
    redactString: (s) => s,
  },
})

await mock.module("../src/config.js", {
  namedExports: {
    config: {
      kiloConfigPath: "/nonexistent/kilo/opencode.json",
      bridgeDefaultAgent: "codex",
      defaultDirectory: "/tmp",
      bridgeAgentFallbacks: [],
      logLevel: "error",
    },
  },
})

await mock.module("../src/db.js", {
  namedExports: {
    getChatBinding: () => null,
    setChatBinding: () => {},
    clearChatBinding: () => {},
    recentSessions: () => [],
    sessionCountsByCli: () => [],
    recentWorkspaces: () => [],
    getCliSessionById: (cli, sessionId) => ({ cli, session_id: sessionId, title: "test", display_name: null, message_count: 0 }),
    renameSession: () => ({ changes: 1 }),
    upsertCliSession: () => {},
    getKiloBridgeSessions: () => [],
  },
})

const capturedReplies = []

await mock.module("../src/telegram-utils.js", {
  namedExports: {
    replyChunks: async (_ctx, text) => { capturedReplies.push(text) },
    resolvePreferredAgent: () => "codex",
    hasBoundSession: (binding) => !!(binding?.session_id),
    displayPath: (p) => p ?? "/",
    formatSessionLine: (row) => `[${row.cli}] ${row.session_id}`,
    resolveDirectory: (p) => p ?? "/tmp",
    compactPath: (p) => p ?? ".",
    registerPath: () => "fakehash",
    resolvePath: () => null,
    resolveSessionLabel: (binding) => binding?.session_id?.slice(0, 12) ?? "unknown",
  },
})

await mock.module("../src/backends.js", {
  namedExports: {
    getBackend: () => null,
    supportedClis: () => ["codex", "claude", "copilot", "gemini"],
  },
})

await mock.module("../src/model-discovery.js", {
  namedExports: {
    getModelsForCli: () => null,
    encodeModelCallbackSlug: (_cli, slug) => slug,
  },
})

await mock.module("grammy", {
  namedExports: {
    InlineKeyboard: class {
      text() { return this }
      row() { return this }
    },
  },
})

await mock.module("../src/cli-scanner.js", {
  namedExports: {
    refreshKiloMirror: async () => ({ sessions: [], ok: true }),
    scanAll: async () => 0,
  },
})

const { createAgentRegistry } = await import("../src/agent-registry.js")
const { config } = await import("../src/config.js")

const agentRegistry = createAgentRegistry(config)
await agentRegistry.refresh()

const { setupCommands } = await import("../src/commands.js")

function makeMockBot() {
  const handlers = {}
  return {
    command(name, handler) { handlers[name] = handler },
    handlers,
  }
}

function makeCtx(chatId = 1, match = "") {
  return {
    chat: { id: chatId },
    match,
    reply: async (text) => { capturedReplies.push(text) },
  }
}

const fakeKilo = {
  listSessions: async () => [],
  getAllStatuses: async () => ({}),
  getSession: async () => ({ title: "test-session" }),
  deleteSession: async () => {},
  abortSession: async () => {},
}

const bot = makeMockBot()
setupCommands(bot, fakeKilo, agentRegistry)

// ── Fallback registry shape ──────────────────────────────────────────────────

test("agentRegistry.get() returns fallback registry when initial refresh fails", () => {
  const registry = agentRegistry.get()
  assert.deepEqual(registry.primaryAgents, ["codex"])
  assert.equal(registry.configuredDefault, "")
  assert.equal(registry.bridgeDefault, "codex")
})

test("initial refresh failure emits a warn log event with persist: true", () => {
  const event = warnEvents.find((e) => e.event === "load_failed_using_fallback")
  assert.ok(event, "warn event load_failed_using_fallback should be emitted")
  assert.equal(event.domain, "agent-registry")
  assert.equal(event.meta.code, "ENOENT")
  assert.equal(event.meta.persist, true)
  assert.ok(event.meta.config_path, "config_path should be included in log event")
})

// ── /start works when kilo config is missing ─────────────────────────────────

test("/start replies with a non-empty string when kilo config is absent (no silence)", async () => {
  capturedReplies.length = 0
  await bot.handlers.start(makeCtx())
  assert.ok(capturedReplies.length > 0, "ctx.reply must be called — bridge must not be silent")
  assert.ok(typeof capturedReplies[0] === "string" && capturedReplies[0].length > 0, "reply must be a non-empty string")
})

// ── /agents shows guard message for non-Kilo bindings with fallback registry ─

test("/agents shows 'not available' message for codex session with empty fallback registry", async () => {
  capturedReplies.length = 0
  await bot.handlers.agents(makeCtx())
  assert.ok(capturedReplies.length > 0, "ctx.reply must be called")
  assert.ok(capturedReplies[0].includes("Bridge default agent:"), "reply must show bridge default agent")
  assert.ok(capturedReplies[0].includes("Available primary agents:"), "reply must list available agents section")
})

// ── repeated refresh while in fallback does not re-emit load_failed_using_fallback ──

test("repeated refresh() while never-loaded emits load_failed_using_fallback once, then refresh_failed_still_fallback", async () => {
  const scoped = createAgentRegistry({
    kiloConfigPath: "/nonexistent/opencode.json",
    bridgeDefaultAgent: "codex",
  })

  warnEvents.length = 0
  await scoped.refresh()
  await scoped.refresh()
  await scoped.refresh()

  const firstWarns = warnEvents.filter((e) => e.event === "load_failed_using_fallback")
  const repeatWarns = warnEvents.filter((e) => e.event === "refresh_failed_still_fallback")

  assert.equal(firstWarns.length, 1, "load_failed_using_fallback must be emitted exactly once")
  assert.equal(firstWarns[0].meta.persist, true, "first-time warning must persist")
  assert.equal(repeatWarns.length, 2, "subsequent failures must emit refresh_failed_still_fallback")
  assert.ok(repeatWarns.every((e) => e.meta.persist === false), "repeat failures must not persist (avoid log spam)")
  assert.equal(scoped.hasLoaded(), false, "hasLoaded() stays false while never successfully loaded")
})

// ── refresh() keeps last-good registry when reload fails ─────────────────────

test("refresh() retains last-good registry when a subsequent reload fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tbridge-agent-keeplast-"))
  const configPath = join(dir, "kilo.json")
  await writeFile(configPath, JSON.stringify({
    agent: { primary1: {}, primary2: { mode: "chat" } },
    default_agent: "primary1",
  }))

  const scopedConfig = {
    kiloConfigPath: configPath,
    bridgeDefaultAgent: "primary1",
  }
  const scoped = createAgentRegistry(scopedConfig)

  const first = await scoped.refresh()
  assert.deepEqual(first.primaryAgents, ["primary1", "primary2"])
  assert.equal(first.bridgeDefault, "primary1")
  assert.equal(scoped.hasLoaded(), true, "hasLoaded() must be true after a successful refresh")

  // Remove the config file so the next refresh fails.
  await rm(dir, { recursive: true })

  warnEvents.length = 0
  const second = await scoped.refresh()

  assert.deepEqual(second.primaryAgents, ["primary1", "primary2"], "last-good primaryAgents must be retained")
  assert.equal(second.bridgeDefault, "primary1", "last-good bridgeDefault must be retained")
  assert.strictEqual(scoped.get(), second, "get() must return the same reference refresh() resolved with")

  const warn = warnEvents.find((e) => e.event === "refresh_failed_keeping_last")
  assert.ok(warn, "warn event refresh_failed_keeping_last must be emitted")
  assert.equal(warn.meta.code, "ENOENT")
  assert.equal(warn.meta.persist, true)
})
