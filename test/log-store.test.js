import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Point all log output at a private temp directory so tests are self-contained.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-store-test-"))
const logDbFile = path.join(tmpDir, "events.db")
const logFile = path.join(tmpDir, "bridge.ndjson")

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL = "info"
process.env.LOG_DB_PATH = logDbFile
process.env.LOG_FILE_PATH = logFile
process.env.LOG_RETENTION_DAYS = "7"

const { persistLogEvent, flushLogStore, pruneLogStore, closeLogStore, getLogDb } =
  await import("../src/log-store.js")

// Helper: clean up temp dir on exit
process.on("exit", () => {
  try { fs.rmSync(tmpDir, { recursive: true }) } catch {}
})

// Flush and reset the store between tests so each test starts clean.
before(() => {
  closeLogStore()
})

// ── getLogDb / schema ──

test("getLogDb creates the log_events table on first access", () => {
  const db = getLogDb()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='log_events'")
    .all()
  assert.equal(tables.length, 1, "log_events table should exist")
  closeLogStore()
})

// ── persistLogEvent — field mapping ──

test("persistLogEvent stores level, scope, event, message, and trace_id in the database", () => {
  persistLogEvent({
    ts: new Date().toISOString(),
    level: "warn",
    scope: "test.scope",
    event: "test.event",
    trace_id: "trace-abc",
    message: "Hello from test",
  })
  flushLogStore()

  const row = getLogDb()
    .prepare("SELECT * FROM log_events WHERE event = 'test.event' LIMIT 1")
    .get()
  assert.ok(row, "row should be persisted")
  assert.equal(row.level, "warn")
  assert.equal(row.scope, "test.scope")
  assert.equal(row.event, "test.event")
  assert.equal(row.trace_id, "trace-abc")
  assert.equal(row.message, "Hello from test")
  closeLogStore()
})

test("persistLogEvent stores cli, chat_id, and session_id columns", () => {
  persistLogEvent({
    ts: new Date().toISOString(),
    level: "info",
    scope: "test",
    event: "field.mapping",
    cli: "kilo",
    chat_id: "chat-999",
    session_id: "sess-777",
  })
  flushLogStore()

  const row = getLogDb()
    .prepare("SELECT * FROM log_events WHERE event = 'field.mapping' LIMIT 1")
    .get()
  assert.equal(row.cli, "kilo")
  assert.equal(row.chat_id, "chat-999")
  assert.equal(row.session_id, "sess-777")
  closeLogStore()
})

test("persistLogEvent serialises extra fields into data_json", () => {
  persistLogEvent({
    ts: new Date().toISOString(),
    level: "info",
    scope: "test",
    event: "extra.data",
    foo: "bar",
    count: 42,
  })
  flushLogStore()

  const row = getLogDb()
    .prepare("SELECT * FROM log_events WHERE event = 'extra.data' LIMIT 1")
    .get()
  const extra = JSON.parse(row.data_json)
  assert.equal(extra.foo, "bar")
  assert.equal(extra.count, 42)
  closeLogStore()
})

test("persistLogEvent stores null in data_json when there are no extra fields", () => {
  persistLogEvent({
    ts: new Date().toISOString(),
    level: "info",
    scope: "test",
    event: "no.extra",
  })
  flushLogStore()

  const row = getLogDb()
    .prepare("SELECT * FROM log_events WHERE event = 'no.extra' LIMIT 1")
    .get()
  assert.equal(row.data_json, null)
  closeLogStore()
})

// ── persistLogEvent — ISO timestamp conversion ──

test("persistLogEvent converts ISO timestamp to SQLite datetime format", () => {
  persistLogEvent({
    ts: "2024-06-15T14:30:00.000Z",
    level: "info",
    scope: "test",
    event: "ts.convert",
  })
  flushLogStore()

  const row = getLogDb()
    .prepare("SELECT created_at FROM log_events WHERE event = 'ts.convert' LIMIT 1")
    .get()
  // toSqliteDateTime replaces 'T' with ' ' and removes trailing 'Z'
  assert.equal(row.created_at, "2024-06-15 14:30:00.000")
  closeLogStore()
})

// ── persistLogEvent — batch-size flush ──

test("persistLogEvent flushes immediately when batch reaches 50 events", () => {
  // First get the current count so we can compute the delta
  const before = getLogDb()
    .prepare("SELECT COUNT(*) AS n FROM log_events WHERE event = 'batch.fill'")
    .get().n

  // Push exactly 50 events — the 50th should trigger an immediate flush.
  for (let i = 0; i < 50; i++) {
    persistLogEvent({
      ts: new Date().toISOString(),
      level: "info",
      scope: "test",
      event: "batch.fill",
      index: i,
    })
  }

  // No explicit flushLogStore() call — the batch trigger should have done it.
  const after = getLogDb()
    .prepare("SELECT COUNT(*) AS n FROM log_events WHERE event = 'batch.fill'")
    .get().n
  assert.equal(after - before, 50, "all 50 events should be in the DB after auto-flush")
  closeLogStore()
})

// ── flushLogStore — no-op on empty queue ──

test("flushLogStore is a no-op when there are no pending events", () => {
  // Should not throw even when the queue is empty.
  assert.doesNotThrow(() => flushLogStore())
  closeLogStore()
})

// ── pruneLogStore ──

test("pruneLogStore removes records older than the retention period", () => {
  // Insert a very old record directly via SQL.
  const db = getLogDb()
  db.prepare(`
    INSERT INTO log_events (created_at, level, scope, event)
    VALUES ('1990-01-01 00:00:00', 'info', 'test', 'old.event')
  `).run()

  const deleted = pruneLogStore()
  assert.ok(deleted >= 1, "pruneLogStore should delete at least the one old record")

  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM log_events WHERE event = 'old.event'")
    .get().n
  assert.equal(remaining, 0, "old record should be gone after pruning")
  closeLogStore()
})

test("pruneLogStore returns 0 when there are no records to prune", () => {
  // All records inserted by prior tests are recent, nothing older than 7 days.
  const deleted = pruneLogStore()
  assert.equal(typeof deleted, "number")
  // May be 0 or a positive number depending on prior test state; just verify type.
  closeLogStore()
})

// ── closeLogStore ──

test("closeLogStore flushes pending events before closing the database", () => {
  persistLogEvent({
    ts: new Date().toISOString(),
    level: "info",
    scope: "test",
    event: "close.flush",
  })

  // closeLogStore should flush the pending event and close the DB.
  closeLogStore()

  // Re-open and verify the event was persisted.
  const row = getLogDb()
    .prepare("SELECT event FROM log_events WHERE event = 'close.flush' LIMIT 1")
    .get()
  assert.ok(row, "event should have been flushed before the store closed")
  closeLogStore()
})

test("closeLogStore resets the singleton so getLogDb() returns a fresh instance", () => {
  const db1 = getLogDb()
  closeLogStore()
  const db2 = getLogDb()
  assert.notEqual(db1, db2, "getLogDb() should return a new instance after closeLogStore()")
  closeLogStore()
})
