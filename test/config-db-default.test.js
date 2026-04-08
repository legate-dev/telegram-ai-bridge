import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

// Only the required var is set — BRIDGE_DB_PATH intentionally omitted.
process.env.TELEGRAM_BOT_TOKEN = "111111:DBDEFAULTTOKEN"
process.env.LOG_LEVEL = "error"

const { config } = await import("../src/config.js")

test("config.dbPath defaults to sessions.db in process.cwd() when BRIDGE_DB_PATH is not set", () => {
  const expected = path.join(process.cwd(), "sessions.db")
  assert.equal(config.dbPath, expected)
})
