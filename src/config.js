import "dotenv/config"
import os from "node:os"
import path from "node:path"
import process from "node:process"

function value(name, fallback = "") {
  const raw = process.env[name]
  return typeof raw === "string" ? raw.trim() || fallback : fallback
}

function required(name) {
  const raw = value(name)
  if (!raw) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return raw
}

function bool(name) {
  return value(name) === "1" || value(name).toLowerCase() === "true"
}

function port(name, fallback) {
  const raw = value(name, String(fallback))
  const n = parseInt(raw, 10)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port for ${name}: "${raw}". Must be an integer between 1 and 65535.`)
  }
  return n
}

function list(name, fallback = []) {
  const raw = value(name)
  if (!raw) return fallback
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function expandHome(input) {
  if (!input.startsWith("~/")) return path.resolve(input)
  return path.join(os.homedir(), input.slice(2))
}

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramAllowedUserId: value("TELEGRAM_ALLOWED_USER_ID"),
  // KILO_SERVE_URL is an explicit external-mode escape hatch. If unset, the bridge uses its
  // built-in local serve flow and this default URL is just the legacy default value, not a
  // signal that external mode was requested.
  kiloServeUrl: value("KILO_SERVE_URL", "http://127.0.0.1:4096").replace(/\/$/, ""),
  // Non-null only when KILO_SERVE_URL is explicitly provided in the environment. This lets the
  // rest of the app distinguish "user requested external serve URL" from "using the built-in
  // default URL string".
  kiloServeUrlExplicit: process.env.KILO_SERVE_URL ? process.env.KILO_SERVE_URL.trim().replace(/\/$/, "") : null,
  // KILO_SERVE_PORT controls the local bridge-managed Kilo serve port. It is separate from
  // KILO_SERVE_URL, which only overrides the endpoint in explicit external mode.
  kiloServePort: port("KILO_SERVE_PORT", 4097),
  // Shell used to spawn `kilo serve`. Defaults to $SHELL, then /bin/sh.
  // Override with KILO_SERVE_SHELL if kilo requires a specific login shell.
  kiloServeShell: value("KILO_SERVE_SHELL", process.env.SHELL || "/bin/sh"),
  kiloServerUsername: value("KILO_SERVER_USERNAME", "kilo"),
  kiloServerPassword: value("KILO_SERVER_PASSWORD"),
  kiloConfigPath: expandHome(value("KILO_CONFIG_PATH", "~/.config/kilo/opencode.json")),
  defaultDirectory: path.resolve(value("BRIDGE_DEFAULT_DIRECTORY", process.cwd())),
  dbPath: expandHome(value("BRIDGE_DB_PATH", path.join(process.cwd(), "sessions.db"))),
  bridgeDefaultAgent: value("BRIDGE_DEFAULT_AGENT", "codex"),
  bridgeAgentFallbacks: list("BRIDGE_AGENT_FALLBACKS", ["sonnet"]),
  bridgePendingQuestionTtlMs: parseInt(value("BRIDGE_PENDING_QUESTION_TTL_MS", "600000"), 10),
  bridgePendingPermissionTtlMs: parseInt(value("BRIDGE_PENDING_PERMISSION_TTL_MS", "300000"), 10),
  bridgePendingPathTtlMs: parseInt(value("BRIDGE_PENDING_PATH_TTL_MS", "300000"), 10),
  // Delay, in milliseconds, before dispatching buffered bridge message updates. This debounces
  // bursts of incoming content so rapid partial updates can be coalesced into a single send.
  bridgeMessageDebounceMs: parseInt(value("BRIDGE_MESSAGE_DEBOUNCE_MS", "1500"), 10),
  // Legacy: only used by the deprecated sendMessage() method.
  kiloTimeoutMs: parseInt(value("KILO_TIMEOUT_MS", "120000"), 10),
  // Legacy: only used by the deprecated sendMessage() method.
  kiloRetries: parseInt(value("KILO_RETRIES", "2"), 10),
  kiloStatusTimeoutMs: parseInt(value("KILO_STATUS_TIMEOUT_MS", "5000"), 10),
  kiloAbortTimeoutMs: parseInt(value("KILO_ABORT_TIMEOUT_MS", "10000"), 10),
  kiloSubmitTimeoutMs: parseInt(value("KILO_SUBMIT_TIMEOUT_MS", "15000"), 10),
  kiloTurnTimeoutMs: parseInt(value("KILO_TURN_TIMEOUT_MS", "1800000"), 10),
  kiloStaleTimeoutMs: parseInt(value("KILO_STALE_TIMEOUT_MS", "120000"), 10),
  kiloPollIntervalMs: parseInt(value("KILO_POLL_INTERVAL_MS", "3000"), 10),
  kiloPollInitialDelayMs: parseInt(value("KILO_POLL_INITIAL_DELAY_MS", "5000"), 10),
  kiloCleanupMaxRounds: parseInt(value("KILO_CLEANUP_MAX_ROUNDS", "5"), 10),
  kiloVariant: value("KILO_VARIANT", "high"),
  rateLimitMax: parseInt(value("RATE_LIMIT_MAX", "20"), 10),
  rateLimitWindowMs: parseInt(value("RATE_LIMIT_WINDOW_MS", "60000"), 10),
  copilotAllowAllTools: value("COPILOT_ALLOW_ALL_TOOLS", "true").toLowerCase() !== "false",
  logLevel: value("LOG_LEVEL", "info").toLowerCase(),
  logFilePath: expandHome(value("LOG_FILE_PATH", path.join(process.cwd(), "logs", "bridge.ndjson"))),
  logDbPath: expandHome(value("LOG_DB_PATH", path.join(process.cwd(), "logs", "bridge-events.db"))),
  logRetentionDays: parseInt(value("LOG_RETENTION_DAYS", "14"), 10),
  logMaxFileSize: parseInt(value("LOG_MAX_FILE_SIZE", "10485760"), 10),
  logMaxFiles: parseInt(value("LOG_MAX_FILES", "5"), 10),

  // Model discovery paths
  codexModelsCachePath: expandHome(value("CODEX_MODELS_CACHE_PATH", "~/.codex/models_cache.json")),
  claudeConfigPath: expandHome(value("CLAUDE_CONFIG_PATH", "~/.claude.json")),

  // CLI session scanner paths (override if CLIs store data in non-standard locations)
  scanPathClaude: expandHome(value("SCAN_PATH_CLAUDE", "~/.claude/projects")),
  scanPathCodex: expandHome(value("SCAN_PATH_CODEX", "~/.codex/sessions")),
  scanPathCopilot: expandHome(value("SCAN_PATH_COPILOT", "~/.copilot")),
  scanPathQwen: expandHome(value("SCAN_PATH_QWEN", "~/.qwen/tmp")),
  scanPathGemini: expandHome(value("SCAN_PATH_GEMINI", "~/.gemini/tmp")),
  scanPathKilo: expandHome(value("SCAN_PATH_KILO", "~/.local/share/kilo/kilo.db")),

  // Per-backend exec timeouts (ms)
  codexTimeoutMs: parseInt(value("CODEX_TIMEOUT_MS", "300000"), 10),
  copilotTimeoutMs: parseInt(value("COPILOT_TIMEOUT_MS", "300000"), 10),
  geminiTimeoutMs: parseInt(value("GEMINI_TIMEOUT_MS", "300000"), 10),
  claudeTimeoutMs: parseInt(value("CLAUDE_TIMEOUT_MS", "300000"), 10),
  // When true (default): passes --permission-mode bypassPermissions — all tools auto-approved.
  // When false: passes --permission-prompt-tool stdio — permission requests surface via Telegram.
  // Set to "false" to opt into interactive permission handling.
  claudeDangerousSkipPermissions: value("BRIDGE_CLAUDE_DANGEROUS_SKIP_PERMISSIONS", "true") !== "false",

  // CLI binary paths (override for launchd / non-interactive environments)
  binCodex: value("BIN_CODEX", "codex"),
  binCopilot: value("BIN_COPILOT", "copilot"),
  binGemini: value("BIN_GEMINI", "gemini"),
  binClaude: value("BIN_CLAUDE", "claude"),

  dryRun: bool("BRIDGE_DRY_RUN"),
}
