import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

// Set all env vars before importing config.js — it evaluates at import time.
process.env.TELEGRAM_BOT_TOKEN = "111111:CONFIGTESTTOKEN"
process.env.TELEGRAM_ALLOWED_USER_ID = "  99999  " // extra whitespace → should be trimmed
process.env.BRIDGE_DRY_RUN = "1" // bool: "1" → true
process.env.BRIDGE_AGENT_FALLBACKS = " alpha , beta , gamma " // list with whitespace
process.env.KILO_TIMEOUT_MS = "55555" // parseInt
process.env.KILO_RETRIES = "3" // parseInt
process.env.BRIDGE_DEFAULT_AGENT = "  my-agent  " // string value — should be trimmed
process.env.COPILOT_ALLOW_ALL_TOOLS = "false" // → false
process.env.KILO_SERVE_URL = "http://my-server:1234/" // trailing slash must be removed
process.env.LOG_LEVEL = "INFO" // uppercase → should be lowercased
process.env.SCAN_PATH_CLAUDE = "~/custom/claude" // expandHome: ~/… → absolute path
process.env.BRIDGE_DB_PATH = "~/custom/sessions.db" // expandHome: ~/… → absolute path
process.env.KILO_VARIANT = "low" // custom variant
process.env.KILO_CLEANUP_MAX_ROUNDS = "7" // custom cleanup threshold
process.env.BIN_CLAUDE = "/usr/local/bin/claude" // custom binary path
process.env.RATE_LIMIT_MAX = "50" // parseInt
process.env.LOG_DB_PATH = path.join(os.tmpdir(), "config-test-bridge-events.db")
process.env.LOG_FILE_PATH = path.join(os.tmpdir(), "config-test-bridge.ndjson")

const { config } = await import("../src/config.js")

// ── required value ──

test("config.telegramBotToken reads the required env var", () => {
  assert.equal(config.telegramBotToken, "111111:CONFIGTESTTOKEN")
})

// ── value() with whitespace trimming ──

test("config.telegramAllowedUserId trims surrounding whitespace", () => {
  assert.equal(config.telegramAllowedUserId, "99999")
})

test("config.bridgeDefaultAgent trims surrounding whitespace", () => {
  assert.equal(config.bridgeDefaultAgent, "my-agent")
})

// ── bool() via dryRun ──

test("config.dryRun is true when BRIDGE_DRY_RUN is '1'", () => {
  assert.equal(config.dryRun, true)
})

// ── copilotAllowAllTools special logic ──

test("config.copilotAllowAllTools is false when COPILOT_ALLOW_ALL_TOOLS is 'false'", () => {
  assert.equal(config.copilotAllowAllTools, false)
})

// ── list() via bridgeAgentFallbacks ──

test("config.bridgeAgentFallbacks splits CSV and trims each entry", () => {
  assert.deepEqual(config.bridgeAgentFallbacks, ["alpha", "beta", "gamma"])
})

// ── parseInt() via kiloTimeoutMs ──

test("config.kiloTimeoutMs parses KILO_TIMEOUT_MS as an integer", () => {
  assert.equal(config.kiloTimeoutMs, 55555)
})

test("config.kiloRetries parses KILO_RETRIES as an integer", () => {
  assert.equal(config.kiloRetries, 3)
})

test("config.rateLimitMax parses RATE_LIMIT_MAX as an integer", () => {
  assert.equal(config.rateLimitMax, 50)
})

// ── string value with trailing slash removal ──

test("config.kiloServeUrl removes trailing slash from the URL", () => {
  assert.equal(config.kiloServeUrl, "http://my-server:1234")
})

// ── logLevel toLowerCase ──

test("config.logLevel converts env var value to lowercase", () => {
  assert.equal(config.logLevel, "info")
})

// ── expandHome() via scanPathClaude ──

test("config.scanPathClaude expands ~/ to the home directory", () => {
  const expected = path.join(os.homedir(), "custom", "claude")
  assert.equal(config.scanPathClaude, expected)
})

// ── dbPath: BRIDGE_DB_PATH expandHome ──

test("config.dbPath expands ~/ to the home directory", () => {
  const expected = path.join(os.homedir(), "custom", "sessions.db")
  assert.equal(config.dbPath, expected)
})

// ── custom string values ──

test("config.kiloVariant uses the custom KILO_VARIANT value", () => {
  assert.equal(config.kiloVariant, "low")
})

test("config.kiloCleanupMaxRounds uses the custom KILO_CLEANUP_MAX_ROUNDS value", () => {
  assert.equal(config.kiloCleanupMaxRounds, 7)
})

test("config.binClaude uses the custom BIN_CLAUDE value", () => {
  assert.equal(config.binClaude, "/usr/local/bin/claude")
})

// ── default values when env vars are not set ──

test("config.kiloServerUsername defaults to 'kilo' when KILO_SERVER_USERNAME is not set", () => {
  assert.equal(config.kiloServerUsername, "kilo")
})

test("config.rateLimitWindowMs defaults to 60000 when RATE_LIMIT_WINDOW_MS is not set", () => {
  assert.equal(config.rateLimitWindowMs, 60000)
})

test("config.logRetentionDays defaults to 14 when LOG_RETENTION_DAYS is not set", () => {
  assert.equal(config.logRetentionDays, 14)
})

test("config.kiloStatusTimeoutMs defaults to 5000 when KILO_STATUS_TIMEOUT_MS is not set", () => {
  assert.equal(config.kiloStatusTimeoutMs, 5000)
})

test("config.binCodex defaults to 'codex' when BIN_CODEX is not set", () => {
  assert.equal(config.binCodex, "codex")
})

test("config.binGemini defaults to 'gemini' when BIN_GEMINI is not set", () => {
  assert.equal(config.binGemini, "gemini")
})

test("config.binCopilot defaults to 'copilot' when BIN_COPILOT is not set", () => {
  assert.equal(config.binCopilot, "copilot")
})

test("config.kiloAbortTimeoutMs defaults to 10000 when KILO_ABORT_TIMEOUT_MS is not set", () => {
  assert.equal(config.kiloAbortTimeoutMs, 10000)
})

test("config.kiloPollIntervalMs defaults to 3000 when KILO_POLL_INTERVAL_MS is not set", () => {
  assert.equal(config.kiloPollIntervalMs, 3000)
})

// ── bridgeMessageDebounceMs ──

test("config.bridgeMessageDebounceMs defaults to 1500 when BRIDGE_MESSAGE_DEBOUNCE_MS is not set", () => {
  assert.equal(config.bridgeMessageDebounceMs, 1500)
})
