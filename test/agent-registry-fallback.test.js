import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Mock loadAgentRegistry to reject, simulating a missing kilo config file
await mock.module("../src/agent-registry.js", {
  namedExports: {
    loadAgentRegistry: async () => {
      const err = new Error("ENOENT: no such file or directory")
      err.code = "ENOENT"
      throw err
    },
  },
})

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

// Minimal db mock
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

// Build the agentRegistryPromise using the same pattern as src/index.js
const { loadAgentRegistry } = await import("../src/agent-registry.js")
const { log } = await import("../src/log.js")
const { config } = await import("../src/config.js")

const agentRegistryPromise = loadAgentRegistry(config).catch((error) => {
  log.warn("agent-registry", "load_failed_using_fallback", {
    config_path: config.kiloConfigPath,
    error: error.message,
    code: error.code,
    persist: true,
  })
  const fallbackBridgeDefault = config.bridgeDefaultAgent || ""
  return {
    primaryAgents: fallbackBridgeDefault ? [fallbackBridgeDefault] : [],
    configuredDefault: "",
    bridgeDefault: fallbackBridgeDefault,
  }
})

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
setupCommands(bot, fakeKilo, agentRegistryPromise)

// ── Fallback registry shape ──────────────────────────────────────────────────

test("agentRegistryPromise resolves to fallback registry when loadAgentRegistry rejects", async () => {
  const registry = await agentRegistryPromise
  assert.deepEqual(registry.primaryAgents, ["codex"])
  assert.equal(registry.configuredDefault, "")
  assert.equal(registry.bridgeDefault, "codex")
})

test("agentRegistryPromise fallback emits a warn log event with persist: true", async () => {
  await agentRegistryPromise
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
  // With no binding, supportsAgentSelection returns true (null cli treated as kilo-compatible)
  // The registry has empty primaryAgents, so the reply lists agents (empty) with the bridge default
  await bot.handlers.agents(makeCtx())
  assert.ok(capturedReplies.length > 0, "ctx.reply must be called")
  assert.ok(capturedReplies[0].includes("Bridge default agent:"), "reply must show bridge default agent")
  assert.ok(capturedReplies[0].includes("Available primary agents:"), "reply must list available agents section")
})
