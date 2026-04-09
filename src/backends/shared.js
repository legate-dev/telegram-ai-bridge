import { statSync } from "node:fs"
import { config } from "../config.js"
import { log } from "../log.js"

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

export function sanitizedEnv() {
  const env = { ...process.env }
  for (const key of REDACTED_KEYS) delete env[key]
  return env
}

export function resolveExecCwd(cli, directory) {
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
