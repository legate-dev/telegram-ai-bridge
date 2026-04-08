import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { config } from "./config.js"
import { getChatBinding, recentSessions } from "./db.js"
import { chunkText, formatForTelegram, formatSessionStatus } from "./format.js"
import { log, redactString } from "./log.js"

// ── Path registry: maps short hashes to filesystem paths ──
// Telegram callback_data is capped at 64 bytes. Embedding raw paths would
// exceed that limit for common project paths. Instead, we register each path
// under a 12-hex-char hash (48-bit space) and store only the hash in the button.

const PATH_REGISTRY_TTL_MS = 10 * 60 * 1000 // 10 minutes
const _pathRegistry = new Map() // hash → { path, expiresAt, timer }

export function registerPath(filePath) {
  const hash = crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 12)
  // Clear any existing cleanup timer so re-registration always reschedules from now.
  const existing = _pathRegistry.get(hash)
  if (existing?.timer) clearTimeout(existing.timer)
  const expiresAt = Date.now() + PATH_REGISTRY_TTL_MS
  const timer = setTimeout(() => {
    const entry = _pathRegistry.get(hash)
    if (entry && entry.expiresAt <= Date.now()) _pathRegistry.delete(hash)
  }, PATH_REGISTRY_TTL_MS + 1000)
  // Don't block process exit — these timers are cleanup-only
  if (timer.unref) timer.unref()
  _pathRegistry.set(hash, { path: filePath, expiresAt, timer })
  return hash
}

export function resolvePath(hash) {
  const entry = _pathRegistry.get(hash)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    _pathRegistry.delete(hash)
    return null
  }
  return entry.path
}

export function authorizedUserId() {
  return config.telegramAllowedUserId ? String(config.telegramAllowedUserId) : ""
}

export function resolveDirectory(argument, chatId) {
  if (argument) {
    // Tilde expansion: "~/foo" → "$HOME/foo". Node.js does NOT expand tilde
    // (it is a shell convention), so we have to do it ourselves for inline
    // command arguments such as `/new ~/repo`. The separate "Custom path..."
    // flow is handled by `parseUserPath()`, which should keep the same
    // shell-style shorthand behavior.
    if (argument.startsWith("~/")) {
      return path.join(os.homedir(), argument.slice(2))
    }
    return path.isAbsolute(argument) ? argument : path.resolve(process.cwd(), argument)
  }
  // 1. Explicit env default
  if (config.defaultDirectory !== process.cwd()) return config.defaultDirectory
  // 2. Last bound session's directory
  if (chatId) {
    const existing = getChatBinding(chatId)
    if (existing?.directory) return existing.directory
  }
  // 3. Most recent CLI session's workspace
  const recent = recentSessions({ limit: 1 })
  if (recent.length && recent[0].workspace && recent[0].workspace !== "/unknown") {
    return recent[0].workspace
  }
  // 4. Bridge repo dir as last resort
  return process.cwd()
}

/**
 * Strict parser for user-typed workspace paths from the "Custom path..." flow.
 *
 * Unlike `resolveDirectory` which accepts anything (including bug-prone relative
 * paths that resolve against the bridge cwd), this function rejects ambiguous
 * input with a clear, user-facing error message. Used only by the pendingCustomPath
 * branch in `message-handler.js` — `/new <path>` inline commands keep their
 * permissive behavior via `resolveDirectory` for backward compatibility with
 * power-user habits.
 *
 * Accepted forms:
 *   - Absolute path:    /Users/foo/repo
 *   - Tilde expansion:  ~/repo  →  $HOME/repo
 *
 * Rejected forms:
 *   - Per-user tilde:   ~alice/repo
 *   - Relative path:    repo, ./repo, ../repo
 *   - Empty string, null, undefined
 *
 * @param {string | null | undefined} raw
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function parseUserPath(raw) {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) {
    return { ok: false, error: "Path is empty. Please type an absolute path or one starting with ~/" }
  }
  // ~/foo → $HOME/foo
  if (trimmed.startsWith("~/")) {
    return { ok: true, path: path.join(os.homedir(), trimmed.slice(2)) }
  }
  // ~user/foo and bare ~ are not supported (Node has no per-user home expansion)
  if (trimmed.startsWith("~")) {
    return {
      ok: false,
      error: "Per-user tilde (~user/...) is not supported. Use an absolute path or ~/ for your own home directory.",
    }
  }
  // Absolute path is the happy path
  if (path.isAbsolute(trimmed)) {
    return { ok: true, path: trimmed }
  }
  // Anything else is a relative path — reject explicitly so we never silently
  // resolve against the bridge's cwd (which is almost never what the user wants).
  return {
    ok: false,
    error: `Relative paths are not supported here. Type an absolute path (e.g. /Users/you/repo) or use ~/ shorthand.`,
  }
}

/**
 * Filesystem-level validation for a workspace directory before it is persisted
 * to a session. Catches typos and stale paths at input time so they don't
 * explode later inside `resolveExecCwd` with a confusing ENOENT.
 *
 * Same family as the `/unknown` sentinel guard added in PR #106 — both prevent
 * unbindable workspace strings from reaching the backend.
 *
 * @param {string} directory
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateWorkspaceDirectory(directory) {
  try {
    const stat = fs.statSync(directory)
    if (!stat.isDirectory()) {
      return { ok: false, error: `Path exists but is not a directory: ${directory}` }
    }
    return { ok: true }
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { ok: false, error: `Path does not exist: ${directory}` }
    }
    if (err?.code === "EACCES") {
      return { ok: false, error: `Permission denied: ${directory}` }
    }
    return { ok: false, error: `Cannot access path (${err?.code ?? "unknown"}): ${directory}` }
  }
}

export function displayPath(input) {
  if (!input) return "."
  const absolute = path.resolve(input)
  const home = os.homedir()
  if (absolute === process.cwd()) return "."
  if (absolute.startsWith(`${process.cwd()}${path.sep}`)) {
    return path.relative(process.cwd(), absolute) || "."
  }
  if (absolute === home) return "~"
  if (absolute.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, absolute)}`
  }
  return absolute
}

export function hasBoundSession(binding) {
  return Boolean(binding?.session_id && binding?.directory)
}

export function resolvePreferredAgent(binding, registry) {
  const candidate = binding?.agent || registry.bridgeDefault
  if (registry.primaryAgents.includes(candidate)) return candidate
  return registry.bridgeDefault
}

export async function explainBackendFailure(ctx, binding, error, kilo) {
  const cli = binding?.cli ?? "the backend"

  if (error?.cause?.code === "ECONNREFUSED") {
    await replyChunks(
      ctx,
      `${cli} is unreachable. Check that it is running and the URL is correct, then resend.`,
    )
    return
  }

  // For submit failures (not timeout/busy), check current status for context
  let status = null
  if (hasBoundSession(binding) && kilo) {
    try {
      status = await kilo.getSessionStatus(binding.session_id)
    } catch {
      status = null
    }
  }

  if (status?.type === "busy") {
    await replyChunks(
      ctx,
      `${cli} is still processing a previous turn. Use /status to check progress, or /abort then resend.`,
    )
    return
  }

  const detail = formatSessionStatus(status)
  if (detail) {
    await replyChunks(ctx, `${cli} could not respond right now. ${detail}`)
    return
  }

  await replyChunks(ctx, `${cli} request failed: ${redactString(error.message)}`)
}

export async function replyChunks(ctx, text) {
  // Chunk the original plain text first, then format each chunk individually.
  // This gives exact 1:1 alignment: plainChunks[i] and its formatted version always
  // cover the same logical content, so the fallback index is always correct.
  const plainChunks = chunkText(text)

  for (let i = 0; i < plainChunks.length; i++) {
    try {
      await ctx.reply(formatForTelegram(plainChunks[i]), { parse_mode: "MarkdownV2" })
    } catch (error) {
      // If MarkdownV2 parsing fails (unbalanced backticks etc), fall back to plain text
      // for this chunk and all remaining chunks — already-sent chunks stay as-is
      if (error?.description?.includes("parse")) {
        log.warn("telegram.reply", "markdown_fallback_plain_text", {
          message: error.description,
          chunk_index: i,
          total_chunks: plainChunks.length,
          chunk_length: plainChunks[i].length,
        })
        for (let j = i; j < plainChunks.length; j++) {
          await ctx.reply(plainChunks[j])
        }
        return
      }
      throw error
    }
  }
}

export function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function compactPath(input) {
  if (!input || input === "/unknown") return "?"
  const absolute = path.resolve(input)
  const home = os.homedir()
  // Show last directory name (repo name) — much more useful on mobile than "." or full path
  const name = path.basename(absolute)
  if (absolute === home) return "~"
  if (absolute.startsWith(`${home}${path.sep}`)) {
    // One level deep: ~/foo → foo. Deeper: ~/a/b/c → c (~/a/b)
    const rel = path.relative(home, absolute)
    const segments = rel.split(path.sep)
    if (segments.length <= 1) return name
    return `${name} (~/${segments.slice(0, -1).join("/")})`
  }
  return name
}

export function formatSessionLine(session) {
  const ws = compactPath(session.workspace)
  const title = redactString(session.display_name || session.title || session.session_id.slice(0, 12)).slice(0, 50)
  const msgs = session.message_count || 0
  const age = session.last_activity
    ? timeAgo(new Date(session.last_activity))
    : "?"
  return `[${session.cli}] ${title} (${ws}, ${msgs} msgs, ${age})`
}
