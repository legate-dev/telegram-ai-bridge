import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { config } from "./config.js"

const BATCH_SIZE = 50
const BATCH_INTERVAL_MS = 5000

let db = null
let insertStmt = null
let pruneStmt = null
let logDbDirectoryReady = false
let pendingEvents = []
let flushTimer = null

function ensureParent(filePath) {
  if (logDbDirectoryReady) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  logDbDirectoryReady = true
}

export function getLogDb() {
  if (db) return db

  ensureParent(config.logDbPath)
  db = new Database(config.logDbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("busy_timeout = 3000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS log_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      level      TEXT NOT NULL,
      scope      TEXT NOT NULL,
      event      TEXT NOT NULL,
      trace_id   TEXT,
      cli        TEXT,
      chat_id    TEXT,
      session_id TEXT,
      message    TEXT,
      data_json  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_log_events_created_at
      ON log_events (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_log_events_level
      ON log_events (level, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_log_events_event
      ON log_events (event, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_log_events_trace_id
      ON log_events (trace_id, created_at DESC);
  `)

  return db
}

function getInsertStmt() {
  if (insertStmt) return insertStmt
  insertStmt = getLogDb().prepare(`
    INSERT INTO log_events (
      created_at,
      level,
      scope,
      event,
      trace_id,
      cli,
      chat_id,
      session_id,
      message,
      data_json
    ) VALUES (
      @created_at,
      @level,
      @scope,
      @event,
      @trace_id,
      @cli,
      @chat_id,
      @session_id,
      @message,
      @data_json
    )
  `)
  return insertStmt
}

function getPruneStmt() {
  if (pruneStmt) return pruneStmt
  pruneStmt = getLogDb().prepare(`
    DELETE FROM log_events
    WHERE created_at < datetime('now', ?)
  `)
  return pruneStmt
}

function getExtraData(entry) {
  const {
    ts,
    level,
    scope,
    event,
    trace_id,
    cli,
    chat_id,
    session_id,
    message,
    ...extra
  } = entry

  return Object.keys(extra).length ? JSON.stringify(extra) : null
}

function toSqliteDateTime(isoString) {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return isoString
  return date.toISOString().replace("T", " ").replace("Z", "")
}

export function pruneLogStore() {
  const result = getPruneStmt().run(`-${config.logRetentionDays} days`)
  return result.changes
}

function startFlushTimer() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushLogStore()
  }, BATCH_INTERVAL_MS)
  flushTimer.unref?.()
}

export function flushLogStore() {
  if (!pendingEvents.length) return
  const batch = pendingEvents
  pendingEvents = []
  const insert = getInsertStmt()
  const runBatch = getLogDb().transaction((events) => {
    for (const event of events) insert.run(event)
  })
  runBatch(batch)
}

export function persistLogEvent(entry) {
  pendingEvents.push({
    created_at: toSqliteDateTime(entry.ts),
    level: entry.level,
    scope: entry.scope,
    event: entry.event,
    trace_id: entry.trace_id ?? null,
    cli: entry.cli ?? null,
    chat_id: entry.chat_id ?? null,
    session_id: entry.session_id ?? null,
    message: entry.message ?? null,
    data_json: getExtraData(entry),
  })
  if (pendingEvents.length >= BATCH_SIZE) {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flushLogStore()
    return
  }
  startFlushTimer()
}

export function closeLogStore() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushLogStore()
  if (!db) return
  db.close()
  db = null
  insertStmt = null
  pruneStmt = null
}
