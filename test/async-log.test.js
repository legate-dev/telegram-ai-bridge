import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Point all log output at a private temp directory so tests are self-contained
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "async-log-"))
const logFile = path.join(tmpDir, "bridge.ndjson")
const logDbFile = path.join(tmpDir, "bridge-events.db")

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL = "info"
process.env.LOG_FILE_PATH = logFile
process.env.LOG_DB_PATH = logDbFile

// Dynamic import so the modules pick up the env vars set above
const { log, flushLogFile } = await import("../src/log.js")
const { flushLogStore, closeLogStore, getLogDb } = await import("../src/log-store.js")

test("all N log events appear in file after flushLogFile", async () => {
  const N = 20
  for (let i = 0; i < N; i++) {
    log.info("test", "file_event", { index: i })
  }
  await flushLogFile()

  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
  assert.equal(lines.length, N, `expected ${N} lines in log file, got ${lines.length}`)

  for (let i = 0; i < N; i++) {
    const entry = JSON.parse(lines[i])
    assert.equal(entry.event, "file_event")
    assert.equal(entry.index, i)
  }
})

test("all N log events appear in DB after flushLogStore", () => {
  const N = 10
  for (let i = 0; i < N; i++) {
    // warn level auto-persists to the DB
    log.warn("test", "db_event", { index: i })
  }
  flushLogStore()

  const rows = getLogDb()
    .prepare("SELECT * FROM log_events WHERE event = 'db_event' ORDER BY id")
    .all()
  assert.equal(rows.length, N, `expected ${N} rows in DB, got ${rows.length}`)

  for (let i = 0; i < N; i++) {
    assert.equal(rows[i].event, "db_event")
  }

  closeLogStore()
})
