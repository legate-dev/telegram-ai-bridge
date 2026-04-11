import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { config } from "./config.js"

let _db = null

export function getDb() {
  if (_db) return _db
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
  _db = new Database(config.dbPath)
  _db.pragma("journal_mode = WAL")
  _db.pragma("busy_timeout = 3000")

  _db.exec(`
    CREATE TABLE IF NOT EXISTS lmstudio_response_ids (
      session_id  TEXT PRIMARY KEY,
      response_id TEXT NOT NULL
    );

    -- Privacy migration: drop legacy conversation-content table from pre-v1 API.
    -- lmstudio_response_ids stores only an opaque ID, no content.
    DROP TABLE IF EXISTS lmstudio_messages;

    CREATE TABLE IF NOT EXISTS cli_sessions (
      cli                   TEXT NOT NULL,
      session_id            TEXT NOT NULL,
      workspace             TEXT NOT NULL DEFAULT '.',
      title                 TEXT,
      display_name          TEXT,
      message_count         INTEGER DEFAULT 0,
      last_activity         TEXT,
      resume_cmd            TEXT,
      source                TEXT,
      scanned_at            TEXT NOT NULL DEFAULT (datetime('now')),
      kilo_messages_seen_at INTEGER,
      PRIMARY KEY (cli, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cli_sessions_activity
      ON cli_sessions (last_activity DESC);

    CREATE TABLE IF NOT EXISTS chat_bindings (
      chat_id    TEXT PRIMARY KEY,
      cli        TEXT NOT NULL DEFAULT 'kilo',
      session_id TEXT NOT NULL,
      agent      TEXT,
      model      TEXT,
      directory  TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Migrate: add display_name column for existing databases
  const cols = _db.prepare("PRAGMA table_info(cli_sessions)").all()
  if (!cols.some((c) => c.name === "display_name")) {
    _db.exec("ALTER TABLE cli_sessions ADD COLUMN display_name TEXT")
  }

  // Migrate: add source column. NULL means "external / pre-migration session"
  // and is intentionally never touched by /cleanup. Only sessions explicitly
  // tagged source='bridge' (set by createNewSession) are eligible.
  if (!cols.some((c) => c.name === "source")) {
    _db.exec("ALTER TABLE cli_sessions ADD COLUMN source TEXT")
  }

  // Migrate: add kilo_messages_seen_at column for existing databases.
  // Caches the Kilo session.time_updated value seen at the last scan so
  // scanKilo can skip the per-row json_extract user-role count on cache hit.
  if (!cols.some((c) => c.name === "kilo_messages_seen_at")) {
    _db.exec("ALTER TABLE cli_sessions ADD COLUMN kilo_messages_seen_at INTEGER")
  }

  // Migrate: add model column for existing chat_bindings databases
  const bindingCols = _db.prepare("PRAGMA table_info(chat_bindings)").all()
  if (!bindingCols.some((c) => c.name === "model")) {
    _db.exec("ALTER TABLE chat_bindings ADD COLUMN model TEXT")
  }

  // Migrate: cleanup rows with sentinel workspace / directory values.
  //
  // Background: before the scanner guard in cli-scanner.js was added,
  // scanQwenGemini would emit sessions with workspace='/unknown' whenever
  // it encountered legacy Gemini/Qwen hash-directory storage (no
  // .project_root, no checkpoint files). Those rows polluted the
  // /sessions picker — clicking them bound the chat to a non-existent
  // directory and the next message exploded with ENOENT at the exec
  // boundary (backends.js:resolveExecCwd).
  //
  // This cleanup is idempotent and safe to run on every startup:
  //   - cli_sessions: delete every row with a sentinel workspace. The
  //     scanner guard now refuses to write these, so this DELETE drains
  //     legacy data on upgraded installations and is a no-op afterwards.
  //   - chat_bindings: delete rows whose directory is sentinel BUT only
  //     when session_id != ''. The empty-session_id sentinel is a
  //     reserved "preference only" binding (see reconcileCliSessions
  //     docstring below) that may carry a NULL directory legitimately
  //     and MUST NOT be touched here.
  _db.prepare(
    `DELETE FROM cli_sessions
     WHERE workspace IS NULL OR workspace IN ('/unknown', '.')`,
  ).run()
  _db.prepare(
    `DELETE FROM chat_bindings
     WHERE session_id != ''
       AND (directory IS NULL OR directory IN ('/unknown', '.'))`,
  ).run()

  return _db
}

// -- cli_sessions queries --

export function upsertCliSession(row) {
  const db = getDb()
  // `source` is preserved across upserts via COALESCE: once createNewSession
  // tags a session as 'bridge', subsequent scanner upserts (which never know
  // about source) must not clobber it back to NULL.
  db.prepare(`
    INSERT INTO cli_sessions (cli, session_id, workspace, title, message_count, last_activity, resume_cmd, source, scanned_at, kilo_messages_seen_at)
    VALUES (@cli, @session_id, @workspace, @title, @message_count, @last_activity, @resume_cmd, @source, datetime('now'), @kilo_messages_seen_at)
    ON CONFLICT (cli, session_id) DO UPDATE SET
      workspace             = excluded.workspace,
      title                 = COALESCE(excluded.title, cli_sessions.title),
      message_count         = excluded.message_count,
      last_activity         = excluded.last_activity,
      resume_cmd            = excluded.resume_cmd,
      source                = COALESCE(excluded.source, cli_sessions.source),
      scanned_at            = datetime('now'),
      kilo_messages_seen_at = excluded.kilo_messages_seen_at
  `).run({ source: null, kilo_messages_seen_at: null, ...row })
}

export function recentSessions({ cli, limit = 10 } = {}) {
  const db = getDb()
  // Filter out sessions whose workspace is a sentinel value ('/unknown', '.')
  // or NULL. These rows used to come from the scanner fallback when the CLI's
  // on-disk metadata didn't reveal a real workspace (e.g. Gemini's legacy
  // hash-directory storage with no .project_root and no checkpoint files).
  // Surfacing them in the /sessions picker is a UX trap: the user clicks, the
  // bind succeeds, then the first message fails with ENOENT at exec because
  // there's no real directory to cd into. Keep them out of the listing
  // entirely — same contract as recentWorkspaces() below. The scanner guard
  // in cli-scanner.js now refuses to write them in the first place, but this
  // filter is the last line of defense for pre-existing data and any future
  // scanner that might re-introduce sentinels.
  if (cli) {
    return db
      .prepare(
        `SELECT * FROM cli_sessions
         WHERE cli = ?
           AND workspace IS NOT NULL
           AND workspace NOT IN ('/unknown', '.')
         ORDER BY last_activity DESC
         LIMIT ?`,
      )
      .all(cli, limit)
  }
  return db
    .prepare(
      `SELECT * FROM cli_sessions
       WHERE workspace IS NOT NULL
         AND workspace NOT IN ('/unknown', '.')
       ORDER BY last_activity DESC
       LIMIT ?`,
    )
    .all(limit)
}

export function getCliSessionById(cli, sessionId) {
  const db = getDb()
  return db
    .prepare("SELECT * FROM cli_sessions WHERE cli = ? AND session_id = ?")
    .get(cli, sessionId)
}

export function recentWorkspaces(limit = 8) {
  const db = getDb()
  return db
    .prepare(
      `SELECT workspace, count(*) as count, max(last_activity) as last_activity
       FROM cli_sessions
       WHERE workspace IS NOT NULL AND workspace != '.' AND workspace != '/unknown'
       GROUP BY workspace
       ORDER BY last_activity DESC
       LIMIT ?`,
    )
    .all(limit)
}

export function sessionCountsByCli() {
  const db = getDb()
  return db
    .prepare(
      "SELECT cli, count(*) as count FROM cli_sessions GROUP BY cli ORDER BY count DESC",
    )
    .all()
}

export function renameSession(cli, sessionId, displayName) {
  const db = getDb()
  return db
    .prepare("UPDATE cli_sessions SET display_name = ? WHERE cli = ? AND session_id = ?")
    .run(displayName, cli, sessionId)
}

/**
 * Returns the bridge-owned Kilo sessions from the local mirror, optionally
 * excluding the currently bound session. Used by /cleanup as the deterministic
 * source of truth — replaces the legacy title-pattern heuristic that was
 * removed in PR #59.
 *
 * Sessions with source = NULL (pre-migration / external) are intentionally
 * excluded so /cleanup can never touch them.
 */
export function getKiloBridgeSessions(boundSessionId = null) {
  const db = getDb()
  if (boundSessionId) {
    return db
      .prepare(
        `SELECT session_id, title, display_name, message_count, last_activity
         FROM cli_sessions
         WHERE cli = 'kilo'
           AND source = 'bridge'
           AND session_id != ?
         ORDER BY last_activity DESC`,
      )
      .all(boundSessionId)
  }
  return db
    .prepare(
      `SELECT session_id, title, display_name, message_count, last_activity
       FROM cli_sessions
       WHERE cli = 'kilo'
         AND source = 'bridge'
       ORDER BY last_activity DESC`,
    )
    .all()
}

/**
 * Removes stale cli_sessions and their chat_bindings for the given CLI,
 * keeping only the sessions whose IDs appear in `sessionIds`.
 *
 * Session-binding contract:
 * - `session_id = ''` is a reserved sentinel, not a real CLI session ID
 * - it means "no active session bound, preferences only"
 * - it is written when a user stores per-CLI preferences before any active
 *   session exists (for example via `/agent <name>`)
 *
 * Reconcile must preserve that sentinel in chat_bindings instead of treating
 * it as stale state. Deleting `session_id = ''` rows would silently discard
 * preference-only bindings and violate the bridge's binding semantics.
 */
export function reconcileCliSessions(cli, sessionIds) {
  const db = getDb()
  const ids = Array.isArray(sessionIds) ? [...new Set(sessionIds.filter(Boolean))] : []

  // Wrap both DELETE statements in a single SQLite transaction so they
  // either both succeed or both roll back. Without this, better-sqlite3
  // auto-commits each .run() individually; if the second DELETE fails
  // (SQLITE_IOERR, SQLITE_FULL), chat_bindings rows pointing to deleted
  // cli_sessions remain, corrupting the mirror invariant that bindings
  // always reference an existing session.
  if (!ids.length) {
    const wipeAll = db.transaction(() => {
      // Only delete rows with a real session_id; skip session_id='' sentinel
      // rows so that preference-only bindings (set by /agent before any
      // session exists) are not wiped. See JSDoc above.
      db.prepare("DELETE FROM chat_bindings WHERE cli = ? AND session_id != ''").run(cli)
      db.prepare("DELETE FROM cli_sessions WHERE cli = ?").run(cli)
    })
    wipeAll()
    return
  }

  // Use SQLite's json_each to bypass the parameter limit on `IN (?, ?, ...)`.
  // Default SQLite SQLITE_MAX_VARIABLE_NUMBER is 32766 and V8 caps function
  // arguments at 65535; a power user with thousands of Kilo sessions could
  // crash scanAll() with RangeError: too many parameters, permanently halting
  // the watcher loop. json_each accepts a single stringified array regardless
  // of length and always uses exactly one bound parameter.
  const idsJson = JSON.stringify(ids)
  const reconcile = db.transaction((cliName, idsArrayJson) => {
    // Only delete rows with a real session_id; skip session_id='' sentinel
    // rows so that preference-only bindings (set by /agent before any
    // session exists) are not wiped. See JSDoc above.
    db.prepare(
      `DELETE FROM chat_bindings
       WHERE cli = ?
         AND session_id != ''
         AND session_id NOT IN (SELECT value FROM json_each(?))`,
    ).run(cliName, idsArrayJson)
    db.prepare(
      `DELETE FROM cli_sessions
       WHERE cli = ?
         AND session_id NOT IN (SELECT value FROM json_each(?))`,
    ).run(cliName, idsArrayJson)
  })
  reconcile(cli, idsJson)
}

// -- chat_bindings queries --

export function getChatBinding(chatId) {
  const db = getDb()
  return db
    .prepare("SELECT * FROM chat_bindings WHERE chat_id = ?")
    .get(String(chatId)) ?? null
}

export function setChatBinding(chatId, binding) {
  const db = getDb()
  db.prepare(`
    INSERT INTO chat_bindings (chat_id, cli, session_id, agent, model, directory, updated_at)
    VALUES (@chat_id, @cli, @session_id, @agent, @model, @directory, datetime('now'))
    ON CONFLICT (chat_id) DO UPDATE SET
      cli        = excluded.cli,
      session_id = excluded.session_id,
      agent      = COALESCE(excluded.agent, chat_bindings.agent),
      model      = excluded.model,
      directory  = excluded.directory,
      updated_at = datetime('now')
  `).run({ chat_id: String(chatId), agent: null, model: null, ...binding })
}

export function clearChatBinding(chatId) {
  const db = getDb()
  db.prepare("DELETE FROM chat_bindings WHERE chat_id = ?").run(String(chatId))
}

// -- lmstudio_response_ids queries --
// Stores only an opaque response_id per session for thread continuity.
// No conversation content is persisted — LM Studio manages history server-side.

/**
 * Returns the last response_id for an LM Studio session, or null if none.
 * Used as `previous_response_id` in the next request.
 * @param {string} sessionId
 * @returns {string|null}
 */
export function getLmStudioResponseId(sessionId) {
  const row = getDb()
    .prepare("SELECT response_id FROM lmstudio_response_ids WHERE session_id = ?")
    .get(sessionId)
  return row?.response_id ?? null
}

/**
 * Stores the latest response_id for an LM Studio session.
 * Called after each successful turn to enable thread continuity.
 * @param {string} sessionId
 * @param {string} responseId
 */
export function setLmStudioResponseId(sessionId, responseId) {
  getDb()
    .prepare("INSERT OR REPLACE INTO lmstudio_response_ids (session_id, response_id) VALUES (?, ?)")
    .run(sessionId, responseId)
}
