import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import Database from "better-sqlite3"
import { reconcileCliSessions, upsertCliSession, getCliSessionById } from "./db.js"
import { config } from "./config.js"
import { log } from "./log.js"

const HOME = os.homedir()
// Resolve $HOME itself through any symlinks once at startup. This guards
// against the unlikely-but-valid case where $HOME is a symlink: without this,
// "real.startsWith(HOME + '/')" would fail for paths under the real target.
let REAL_HOME = HOME
try { REAL_HOME = fs.realpathSync(HOME) } catch {}

// De-dup cache for "workspace unrecoverable" warnings.
//
// Background: startWatcher() re-runs scanAll() on every .json change under
// the Qwen/Gemini paths with a 5 s debounce. During an active Gemini session
// the CLI writes to logs.json (and other files) multiple times per turn, so
// scanAll() can fire dozens of times per minute. Without de-dup, a user with
// N legacy hash-directories would emit N persisted log rows per scan, flooding
// the logs DB with identical warnings (on my test machine: 32 legacy dirs ×
// ~12 scans/min = ~23k rows/hour of log noise for a stable, unchanging fact).
//
// One-warn-per-dirPath-per-process is the right granularity:
//   - preserves diagnostic value (which specific directories were skipped)
//   - eliminates repetition (the legacy state doesn't change between scans)
//   - resets on bridge restart (rare, gives a fresh snapshot when it matters)
//
// We key on the full dirPath (not the basename) so two CLIs with same-named
// directories don't collide in the cache.
const warnedUnrecoverableDirs = new Set()

// Test-only seam: reset the de-dup cache so tests can exercise the
// "warn once then never again" behavior in isolation from each other.
// Production code must never call this — persistent de-dup is the point.
export function _resetWarnedUnrecoverableDirsForTest() {
  warnedUnrecoverableDirs.clear()
}

function cliPaths() {
  return {
    claude: config.scanPathClaude,
    codex: config.scanPathCodex,
    copilot: config.scanPathCopilot,
    copilotDb: path.join(config.scanPathCopilot, "session-store.db"),
    qwen: config.scanPathQwen,
    gemini: config.scanPathGemini,
    kilo: config.scanPathKilo,
  }
}

function normalizeWorkspace(ws) {
  if (!ws || typeof ws !== "string") return "/unknown"
  let s = ws.trim().replace(/\\/g, "/")
  if (s.startsWith("~")) s = path.join(HOME, s.slice(1))
  if (!s.startsWith("/")) s = "/" + s.replace(/^\/+/, "")
  return s.replace(/\/+/g, "/") || "/unknown"
}

/**
 * Decode a Claude project folder name back to the original filesystem path.
 * Claude encodes paths by replacing `/`, `.`, and `_` all with `-`, making
 * the encoding lossy. We rebuild the path segment-by-segment, listing
 * directory entries at each level and matching candidates in-memory.
 *
 * Join characters tried (longest match wins): `-`, `_`, `.`
 * Dotfiles/dotdirs: `--config` → `.config` (empty part from double-dash)
 *
 * Example: "-home-user-my-project" → "/home/user/my-project"
 *
 * Security: symbolic links encountered during traversal are silently skipped.
 * A symlink inside `~/.claude/projects/` whose target lies outside HOME would
 * pass the final `startsWith(HOME)` boundary check (because `path.resolve`
 * does not follow symlinks) but cause the backend to `chdir` outside HOME at
 * runtime. Filtering symlinks at readdir time prevents this traversal entirely.
 * The homedir boundary check is retained as defense-in-depth.
 */
export async function decodeClaudeFolder(folder, readdirCache = new Map()) {
  // Strip leading "-" (represents root "/")
  const raw = folder.slice(1)
  const parts = raw.split("-")

  /**
   * Tie-break priority for ambiguous decode candidates of the same length.
   *
   * Claude encodes path separators by replacing `/`, `.`, and `_` all with `-`,
   * making the encoding lossy. When a directory has multiple variants at the
   * same level (e.g., "go-server" AND "go_server"), the decoder must choose
   * one without information from the encoded form.
   *
   * Priority rationale:
   * - `-` first: hyphens in directory names are by far the most common in
   *   real-world projects (npm packages, kebab-case repos)
   * - `_` second: underscores are common in language conventions (Python,
   *   Ruby) but less so as directory separators
   * - `.` last: dots are typically reserved for dotfiles, handled separately
   *   via empty-string parts from `--` encoding
   *
   * Changing this order will change the decoder's output on ambiguous inputs
   * and may break user workspaces — bump and document a migration plan.
   */
  const JOIN_CHARS = ["-", "_", "."]
  const MAX_DEPTH = 20

  let resolved = "/"
  let i = 0
  let depth = 0
  while (i < parts.length) {
    if (++depth > MAX_DEPTH) return "/unknown"

    // Per-iteration symlink guard: the readdir filter below excludes symlinks
    // from greedy candidates, but the fallback `bestSegment = parts[i]` is
    // unconditional. If a prior iteration landed on a symlink entry via that
    // fallback, the upcoming readdir call would follow it into an external
    // target. lstat (which does not follow symlinks) detects this and rejects
    // before any directory listing can leak information outside HOME.
    try {
      if ((await fsp.lstat(resolved)).isSymbolicLink()) return "/unknown"
    } catch {
      // resolved does not exist or is inaccessible; the readdir call below
      // has its own .catch(() => []) that handles this case
    }

    // List current directory once per level for O(1) lookups, using the
    // caller-supplied cache to avoid redundant readdir calls across folders
    // that share common path prefixes (e.g. "/" and "<home>").
    let entries
    if (readdirCache.has(resolved)) {
      entries = readdirCache.get(resolved)
    } else {
      // Read entries excluding symlinks — traversing into a symlink whose target
      // is outside HOME would produce a path that passes the string-based boundary
      // check below but lands outside HOME when the OS follows it at runtime.
      entries = new Set(
        (await fsp.readdir(resolved, { withFileTypes: true }).catch(() => []))
          .filter((dirent) => !dirent.isSymbolicLink())
          .map((dirent) => dirent.name)
      )
      readdirCache.set(resolved, entries)
    }

    // Greedy: try joining progressively more parts to find the longest
    // segment that exists on disk. Try all join characters.
    // Dotfiles are handled naturally: `--config` splits to ["","config"],
    // and `["","config"].join(".")` produces `.config` which matches.
    let bestLen = 1
    let bestSegment = parts[i]
    for (let len = parts.length - i; len > 1; len--) {
      const slice = parts.slice(i, i + len)
      let found = false
      for (const join of JOIN_CHARS) {
        const candidate = slice.join(join)
        if (entries.has(candidate)) {
          bestLen = len
          bestSegment = candidate
          found = true
          break
        }
      }
      if (found) break
    }
    resolved = path.join(resolved, bestSegment)
    i += bestLen
  }

  // Security boundary: decoded paths must be under the user's home directory.
  // Claude projects are always under home; paths resolving elsewhere indicate
  // a crafted folder name or a decoding error.
  const canonical = path.resolve(resolved)
  if (!canonical.startsWith(HOME + "/") && canonical !== HOME) {
    return "/unknown"
  }
  // Defense-in-depth: use realpath to follow any symlinks remaining in the
  // resolved path. path.resolve() above is string-only and does not follow
  // symlinks, so a symlink whose name is under HOME but whose target is
  // outside HOME would pass the check above.
  //
  // Error handling is intentionally fail-closed:
  // - ENOENT / ENOTDIR: path does not exist on disk — this is expected for
  //   decode artifacts (Claude encodes the path, not necessarily one that
  //   exists today). Return canonical from the string-based check above.
  // - Any other error (EACCES, EPERM, ELOOP, …): we cannot verify the target
  //   is inside HOME, so reject to be safe.
  let real
  try {
    real = await fsp.realpath(resolved)
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return canonical
    return "/unknown"
  }
  if (!real.startsWith(REAL_HOME + "/") && real !== REAL_HOME) {
    return "/unknown"
  }
  return canonical
}

function toIsoTimestamp(value, fallback = new Date()) {
  if (!value) return fallback.toISOString()
  const ts = new Date(value)
  return Number.isNaN(ts.getTime()) ? fallback.toISOString() : ts.toISOString()
}

// ── Claude ──

async function scanClaude(basePath) {
  const sessions = []
  if (!fs.existsSync(basePath)) return sessions

  const workspaces = await fsp.readdir(basePath).catch(() => [])
  const readdirCache = new Map()
  for (const folder of workspaces) {
    if (!folder.startsWith("-")) continue
    const workspace = await decodeClaudeFolder(folder, readdirCache)
    const wsPath = path.join(basePath, folder)
    const files = await fsp.readdir(wsPath).catch(() => [])

    for (const file of files) {
      if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue
      const filePath = path.join(wsPath, file)
      const stat = await fsp.stat(filePath).catch(() => null)
      if (!stat) continue

      const content = await fsp.readFile(filePath, "utf8").catch(() => "")
      const lines = content.trim().split("\n").filter(Boolean)

      let title = null
      for (const line of lines.slice(0, 5)) {
        try {
          const entry = JSON.parse(line)
          if (entry.type === "user" && entry.message?.content) {
            const text = typeof entry.message.content === "string"
              ? entry.message.content
              : entry.message.content?.[0]?.text ?? ""
            title = text.slice(0, 120) || null
            break
          }
        } catch {}
      }

      sessions.push({
        cli: "claude",
        session_id: file.replace(".jsonl", ""),
        workspace: normalizeWorkspace(workspace),
        title,
        message_count: lines.length,
        last_activity: stat.mtime.toISOString(),
        resume_cmd: `claude -r ${file.replace(".jsonl", "")}`,
      })
    }
  }
  return sessions
}

// ── Codex ──

async function scanCodex(basePath) {
  const sessions = []
  if (!fs.existsSync(basePath)) return sessions

  // Build a title index from ~/.codex/history.jsonl (one read for all sessions).
  // Each line is { session_id, ts, text } — the first prompt of a session is its title.
  const historyPath = path.join(path.dirname(basePath), "history.jsonl")
  const titleIndex = new Map() // session_id → first user prompt text
  try {
    const historyRaw = await fsp.readFile(historyPath, "utf8")
    for (const line of historyRaw.trim().split("\n")) {
      try {
        const entry = JSON.parse(line)
        if (entry.session_id && entry.text && !titleIndex.has(entry.session_id)) {
          titleIndex.set(entry.session_id, entry.text.slice(0, 120))
        }
      } catch {}
    }
  } catch {} // history.jsonl absent or unreadable — titles degrade to null

  const years = await fsp.readdir(basePath).catch(() => [])
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    const months = await fsp.readdir(path.join(basePath, year)).catch(() => [])
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      const days = await fsp.readdir(path.join(basePath, year, month)).catch(() => [])
      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue
        const dayPath = path.join(basePath, year, month, day)
        const files = await fsp.readdir(dayPath).catch(() => [])

        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue
          const filePath = path.join(dayPath, file)
          const content = await fsp.readFile(filePath, "utf8").catch(() => "")
          const lines = content.trim().split("\n").filter(Boolean)

          let sessionId = null
          let workspace = "/unknown"
          let lastActivity = null
          let messageCount = 0

          for (const line of lines) {
            try {
              const entry = JSON.parse(line)
              if (entry.type === "session_meta" && entry.payload) {
                sessionId = entry.payload.id
                workspace = entry.payload.cwd || "/unknown"
                lastActivity = new Date(entry.payload.timestamp || entry.timestamp)
              }
              if (entry.type === "response_item" && entry.payload?.role === "user") {
                messageCount++
              }
              if (entry.timestamp) {
                const ts = new Date(entry.timestamp)
                if (!lastActivity || ts > lastActivity) lastActivity = ts
              }
            } catch {}
          }

          if (sessionId) {
            sessions.push({
              cli: "codex",
              session_id: sessionId,
              workspace: normalizeWorkspace(workspace),
              title: titleIndex.get(sessionId) ?? null,
              message_count: messageCount,
              last_activity: (lastActivity || new Date()).toISOString(),
              resume_cmd: `codex resume ${sessionId}`,
            })
          }
        }
      }
    }
  }
  return sessions
}

// ── Copilot (SQLite via better-sqlite3) ──

function scanCopilot(dbPath) {
  const sessions = []
  if (!fs.existsSync(dbPath)) return sessions

  let db
  try {
    db = new Database(dbPath, { readonly: true })
  } catch {
    return sessions
  }

  try {
    const rows = db.prepare(`
      SELECT s.id, s.cwd, s.summary, s.created_at, s.updated_at,
        COALESCE(t.turn_count, 0) AS message_count
      FROM sessions s
      LEFT JOIN (
        SELECT session_id, COUNT(*) AS turn_count
        FROM turns
        GROUP BY session_id
      ) t ON t.session_id = s.id
      ORDER BY s.updated_at DESC, s.created_at DESC
    `).all()

    for (const row of rows) {
      sessions.push({
        cli: "copilot",
        session_id: row.id,
        workspace: normalizeWorkspace(row.cwd),
        title: row.summary || null,
        message_count: row.message_count || 0,
        last_activity: toIsoTimestamp(row.updated_at || row.created_at),
        resume_cmd: `copilot --resume=${row.id}`,
      })
    }
  } catch (error) {
    log.warn("scanner", "copilot.scan_failed", {
      cli: "copilot",
      message: error.message,
    })
  } finally {
    db.close()
  }

  return sessions
}

// ── Qwen / Gemini ──

async function scanQwenGemini(cli, basePath) {
  const sessions = []
  if (!fs.existsSync(basePath)) return sessions

  const dirs = await fsp.readdir(basePath).catch(() => [])
  for (const dir of dirs) {
    if (dir.startsWith(".") || dir === "bin") continue
    const dirPath = path.join(basePath, dir)
    const stat = await fsp.stat(dirPath).catch(() => null)
    if (!stat?.isDirectory()) continue

    const logsPath = path.join(dirPath, "logs.json")
    if (!fs.existsSync(logsPath)) continue

    let workspace = "/unknown"

    // Source of truth 1: .project_root file
    const projectRootPath = path.join(dirPath, ".project_root")
    if (fs.existsSync(projectRootPath)) {
      try {
        const rootContent = await fsp.readFile(projectRootPath, "utf8")
        if (rootContent.trim()) workspace = rootContent.trim()
      } catch {}
    }

    // Source of truth 2: checkpoints (if .project_root missing or empty)
    if (workspace === "/unknown" || workspace === ".") {
      const checkpoints = await fsp.readdir(dirPath).catch(() => [])
      for (const cp of checkpoints) {
        if (!cp.startsWith("checkpoint-") || !cp.endsWith(".json")) continue
        try {
          const data = JSON.parse(await fsp.readFile(path.join(dirPath, cp), "utf8"))
          // Handle both old array format and current object with history
          let text = ""
          if (Array.isArray(data)) {
            text = data[0]?.parts?.[0]?.text || ""
          } else if (data?.history && Array.isArray(data.history)) {
            text = data.history[0]?.parts?.[0]?.text || ""
          }

          const match = text.match(/directory:\s*([^\n]+)/) || text.match(/working in the directory:\s*([^\n]+)/)
          if (match) { workspace = match[1].trim(); break }
        } catch {}
      }
    }

    // Final guard: if neither .project_root nor the checkpoint fallback
    // yielded a real workspace, this directory is legacy storage from an
    // older CLI version that has no workspace metadata we can recover
    // (typical case: Gemini/Qwen's pre-2026 hash-named dirs containing
    // only logs.json and chats/, with no .project_root and no checkpoints).
    //
    // Skip it entirely: do NOT emit session records that would poison the
    // DB with unbindable rows. The downstream layers (recentSessions filter,
    // bind reject handler, cleanup migration in db.js) exist as defense in
    // depth, but refusing at the scanner boundary is the most honest place:
    // "if we can't determine where this session lives, we can't help the
    // user resume it, so we don't pretend it exists in /sessions".
    //
    // The warning is de-duplicated per dirPath for the process lifetime
    // (see warnedUnrecoverableDirs above for the rationale): the legacy
    // state is stable across scans, so logging it on every scan tick would
    // flood the persistent log DB with identical rows.
    if (workspace === "/unknown" || workspace === ".") {
      if (!warnedUnrecoverableDirs.has(dirPath)) {
        warnedUnrecoverableDirs.add(dirPath)
        log.warn("scanner", `${cli}.workspace.unrecoverable`, {
          cli,
          dir,
          reason: "no_workspace_metadata",
          persist: true,
        })
      }
      continue
    }

    try {
      const logs = JSON.parse(await fsp.readFile(logsPath, "utf8"))
      const bySession = new Map()
      for (const msg of logs) {
        const sid = msg.sessionId || "unknown"
        if (!bySession.has(sid)) bySession.set(sid, [])
        bySession.get(sid).push(msg)
      }

      for (const [sid, msgs] of bySession) {
        const last = msgs[msgs.length - 1]
        const lastActivity = last?.timestamp ? new Date(last.timestamp) : stat.mtime

        sessions.push({
          cli,
          session_id: sid,
          workspace: normalizeWorkspace(workspace),
          title: null,
          message_count: msgs.length,
          last_activity: lastActivity.toISOString(),
          resume_cmd: `${cli} -r ${sid}`,
        })
      }
    } catch {}
  }
  return sessions
}

// ── Kilo (SQLite via better-sqlite3) ──

function scanKilo(dbPath) {
  const sessions = []
  if (!fs.existsSync(dbPath)) return { sessions, ok: false }

  let db
  try {
    db = new Database(dbPath, { readonly: true })
  } catch {
    return { sessions, ok: false }
  }

  try {
    // message_count for Kilo = number of user turns (one row per real user prompt).
    // Kilo writes one `message` row per atomic step (text chunk, tool call, thinking
    // block, etc.), so COUNT(*) would inflate by ~5-12x. Counting role='user' gives
    // the actual conversational round count, which is what /cleanup reasons about.
    //
    // Per-row counts are cached in cli_sessions.kilo_messages_seen_at (which stores
    // session.time_updated at the last scan). On cache hit we reuse the stored
    // message_count; on cache miss we run the user-role count query for that
    // session only. This avoids running json_extract on every message every
    // 5 s debounce tick, keeping /cleanup classification cheap even on users
    // with large Kilo histories.
    //
    // The entire db-touching block is wrapped in its own try/catch so any
    // SQLite failure (missing JSON1 extension, malformed JSON in `data`,
    // schema drift on the Kilo side, cache row corruption) degrades gracefully
    // to ok=false. scanAll() must never crash bridge startup just because
    // Kilo's local DB shape changed under us, and /cleanup must never operate
    // on a stale mirror that was silently half-updated by a partial scan.
    try {
      const rows = db.prepare(`
        SELECT s.id, s.title, s.directory, p.worktree,
          s.time_updated as updated_epoch_ms
        FROM session s
        LEFT JOIN project p ON s.project_id = p.id
        WHERE s.parent_id IS NULL
        ORDER BY s.time_updated DESC
      `).all()

      const countStmt = db.prepare(
        `SELECT COUNT(*) as cnt FROM message
         WHERE session_id = ? AND json_extract(data, '$.role') = 'user'`,
      )

      for (const row of rows) {
        const cached = getCliSessionById("kilo", row.id)
        let message_count
        if (
          cached != null &&
          cached.kilo_messages_seen_at != null &&
          cached.kilo_messages_seen_at === row.updated_epoch_ms
        ) {
          message_count = cached.message_count ?? 0
        } else {
          message_count = countStmt.get(row.id)?.cnt ?? 0
        }

        const workspace = row.worktree || row.directory || "/unknown"
        const lastActivity = row.updated_epoch_ms
          ? new Date(row.updated_epoch_ms).toISOString()
          : new Date().toISOString()
        const title = row.title && row.title !== "New session" ? row.title : null

        sessions.push({
          cli: "kilo",
          session_id: row.id,
          workspace: normalizeWorkspace(workspace),
          title,
          message_count,
          last_activity: lastActivity,
          resume_cmd: `kilo --session ${row.id}`,
          kilo_messages_seen_at: row.updated_epoch_ms ?? null,
        })
      }
    } catch (queryError) {
      log.warn("scanner", "kilo.query_failed", {
        cli: "kilo",
        message: queryError.message,
        persist: true,
      })
      return { sessions: [], ok: false }
    }

    return { sessions, ok: true }
  } finally {
    db.close()
  }
}

// ── Public API ──

/**
 * Targeted Kilo-only mirror refresh — does NOT touch Claude/Codex/Copilot/Qwen/Gemini.
 *
 * Used by /cleanup so that:
 *   1. The destructive command doesn't pay the latency of walking unrelated
 *      CLI filesystems (integration-assumption risk R4 from PR #59 review)
 *   2. The caller gets an explicit `ok` boolean signaling whether the Kilo
 *      mirror was successfully refreshed (state-concurrency blocker B1/N1
 *      from PR #59 review — scanAll() swallows per-CLI failures silently,
 *      which meant /cleanup confirm could proceed on a stale mirror without
 *      noticing).
 *
 * Returns: {sessions, ok}
 *   - sessions: the Kilo sessions read from disk (empty array if ok=false)
 *   - ok: true if scanKilo read the Kilo DB successfully AND upsert/reconcile
 *         completed; false on any failure (missing DB, locked, query error,
 *         upsert/reconcile throw)
 */
export async function refreshKiloMirror() {
  const paths = cliPaths()
  const kiloScan = scanKilo(paths.kilo)

  if (!kiloScan.ok) {
    log.warn("scanner", "kilo.refresh_degraded", {
      session_count: 0,
      ok: false,
      persist: true,
    })
    return { sessions: [], ok: false }
  }

  try {
    for (const session of kiloScan.sessions) {
      upsertCliSession(session)
    }
    reconcileCliSessions("kilo", kiloScan.sessions.map((session) => session.session_id))
  } catch (error) {
    log.error("scanner", "kilo.refresh_failed", {
      session_count: kiloScan.sessions.length,
      message: error.message,
      persist: true,
    })
    return { sessions: kiloScan.sessions, ok: false }
  }

  log.info("scanner", "kilo.refresh_completed", {
    session_count: kiloScan.sessions.length,
  })
  return { sessions: kiloScan.sessions, ok: true }
}

export async function scanAll() {
  const paths = cliPaths()
  const kiloScan = scanKilo(paths.kilo)
  const all = [
    ...await scanClaude(paths.claude),
    ...await scanCodex(paths.codex),
    ...scanCopilot(paths.copilotDb),
    ...await scanQwenGemini("qwen", paths.qwen),
    ...await scanQwenGemini("gemini", paths.gemini),
    ...kiloScan.sessions,
  ]

  for (const session of all) {
    upsertCliSession(session)
  }

  if (kiloScan.ok) {
    reconcileCliSessions("kilo", kiloScan.sessions.map((session) => session.session_id))
  }

  log.info("scanner", "scan.completed", { session_count: all.length })
  return all.length
}

export function startWatcher() {
  const paths = cliPaths()
  const debounceMs = 5000
  let timeout = null

  const triggerScan = () => {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      scanAll().catch((error) => {
        log.error("scanner", "scan.failed", { error, persist: true })
      })
    }, debounceMs)
  }

  const watchTargets = [
    { dir: paths.claude, filter: (f) => f?.endsWith(".jsonl") },
    { dir: paths.codex, filter: (f) => f?.endsWith(".jsonl") },
    {
      dir: paths.copilot,
      filter: (f) => {
        const normalized = f?.replace(/\\/g, "/")
        return /(^|\/)(session-store\.db|events\.jsonl|workspace\.yaml)$/.test(normalized || "")
      },
    },
    { dir: paths.qwen, filter: (f) => f?.endsWith(".json") },
    { dir: paths.gemini, filter: (f) => f?.endsWith(".json") },
  ]

  for (const { dir, filter } of watchTargets) {
    if (!fs.existsSync(dir)) continue
    fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (filter(filename)) triggerScan()
    })
  }

  log.info("scanner", "watcher.started", { debounce_ms: debounceMs })
}
