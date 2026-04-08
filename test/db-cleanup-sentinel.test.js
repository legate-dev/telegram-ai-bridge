import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { after, test } from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// This test exercises the cleanup migration block in getDb() that runs
// on the first database open. It pre-seeds a sessions.db file with both
// sentinel-workspace garbage rows (the kind of legacy data the bridge
// needs to purge on upgrade) and legitimate rows that must be preserved,
// then imports src/db.js to trigger the migration and verifies the result.
//
// The cleanup migration was introduced as part of the fix for the
// "/sessions rebind gives ENOENT on /unknown" bug — see DECISION_LOG.

// Pre-seed the DB BEFORE importing src/db.js. The schema we write here
// must match the CREATE TABLE statements in db.js (including the
// display_name / source / kilo_messages_seen_at / model columns), because
// the migration block in getDb() runs after CREATE TABLE IF NOT EXISTS.
const testDir = await mkdtemp(join(tmpdir(), "tbridge-cleanup-"))
const dbFile = join(testDir, "sessions.db")

const seed = new Database(dbFile)
seed.exec(`
  CREATE TABLE cli_sessions (
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

  CREATE TABLE chat_bindings (
    chat_id    TEXT PRIMARY KEY,
    cli        TEXT NOT NULL DEFAULT 'kilo',
    session_id TEXT NOT NULL,
    agent      TEXT,
    model      TEXT,
    directory  TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Sentinel rows that MUST be cleaned up by the migration.
  INSERT INTO cli_sessions (cli, session_id, workspace, last_activity)
    VALUES ('gemini', 'legacy-unknown', '/unknown', '2024-01-01T00:00:00Z');
  INSERT INTO cli_sessions (cli, session_id, workspace, last_activity)
    VALUES ('qwen', 'legacy-dot', '.', '2024-01-02T00:00:00Z');

  -- Valid row that MUST be preserved.
  INSERT INTO cli_sessions (cli, session_id, workspace, last_activity)
    VALUES ('gemini', 'real', '/home/user/project', '2024-01-03T00:00:00Z');

  -- Binding to the sentinel row: MUST go.
  INSERT INTO chat_bindings (chat_id, cli, session_id, directory)
    VALUES ('chat-A-sentinel', 'gemini', 'legacy-unknown', '/unknown');

  -- Preference-only binding (session_id=''): MUST be preserved even though
  -- its directory is NULL. This is the reserved "no active session, preferences
  -- only" sentinel documented in reconcileCliSessions — the cleanup migration
  -- must not touch rows where session_id = ''.
  INSERT INTO chat_bindings (chat_id, cli, session_id, directory)
    VALUES ('chat-B-preference-only', 'kilo', '', NULL);

  -- Binding to the valid session: MUST be preserved.
  INSERT INTO chat_bindings (chat_id, cli, session_id, directory)
    VALUES ('chat-C-real', 'gemini', 'real', '/home/user/project');
`)
seed.close()

// Import src/db.js with the test dir as cwd so config.dbPath resolves to
// the pre-seeded file. getDb() runs on first function call, triggering
// the cleanup migration against the seeded rows.
const originalCwd = process.cwd()
process.chdir(testDir)

const { getCliSessionById, getChatBinding } = await import("../src/db.js")

process.chdir(originalCwd)

// Async cleanup via node:test `after()` hook. Using process.on("exit") here
// would silently leak the temp directory because exit handlers must be
// synchronous — any pending Promise (including the one from fs.promises.rm)
// is abandoned when the process exits.
after(async () => {
  await rm(testDir, { recursive: true }).catch(() => {})
})

test("cleanup migration removes cli_sessions rows with workspace='/unknown'", () => {
  assert.equal(
    getCliSessionById("gemini", "legacy-unknown"),
    undefined,
    "/unknown-workspace row must be deleted by the cleanup migration",
  )
})

test("cleanup migration removes cli_sessions rows with workspace='.'", () => {
  assert.equal(
    getCliSessionById("qwen", "legacy-dot"),
    undefined,
    "'.' workspace row must be deleted by the cleanup migration",
  )
})

test("cleanup migration preserves cli_sessions rows with a real workspace", () => {
  const row = getCliSessionById("gemini", "real")
  assert.ok(row, "row with a real workspace must be preserved")
  assert.equal(row.workspace, "/home/user/project")
})

test("cleanup migration removes chat_bindings pointing to sentinel directories", () => {
  assert.equal(
    getChatBinding("chat-A-sentinel"),
    null,
    "binding with sentinel directory must be deleted by the cleanup migration",
  )
})

test("cleanup migration preserves preference-only session_id='' bindings (invariant)", () => {
  // This is the critical invariant: even if a preference-only binding has a
  // NULL directory, the cleanup migration must NOT touch it. Deleting it
  // would silently wipe per-CLI agent preferences set via /agent before any
  // active session exists.
  const binding = getChatBinding("chat-B-preference-only")
  assert.ok(binding, "preference-only binding (session_id='') must be preserved")
  assert.equal(binding.session_id, "", "session_id sentinel must remain empty string")
})

test("cleanup migration preserves bindings pointing to valid sessions", () => {
  const binding = getChatBinding("chat-C-real")
  assert.ok(binding, "binding to a real session must be preserved")
  assert.equal(binding.directory, "/home/user/project")
})
