import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Point all log output at a private temp directory so tests are self-contained
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-rotation-"))
const logFile = path.join(tmpDir, "bridge.ndjson")

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL = "error"
process.env.LOG_FILE_PATH = logFile
process.env.LOG_MAX_FILE_SIZE = "100"
process.env.LOG_MAX_FILES = "3"

// Dynamic import so the modules pick up the env vars set above
const { config } = await import("../src/config.js")
const { log } = await import("../src/log.js")

// Reset the log directory to a clean state before each test
beforeEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
  fs.mkdirSync(tmpDir, { recursive: true })
})

// Helper: make the current log file big enough to trigger rotation
function overfillLog() {
  fs.writeFileSync(config.logFilePath, "x".repeat(150) + "\n")
}

test("log file rotates when size exceeds LOG_MAX_FILE_SIZE", () => {
  overfillLog()
  log.error("test", "rotation_trigger")

  assert.ok(
    fs.existsSync(path.join(tmpDir, "bridge.1.ndjson")),
    ".1.ndjson should exist after first rotation",
  )
  assert.ok(fs.existsSync(logFile), "fresh log file should exist after rotation")

  const rotated = fs.readFileSync(path.join(tmpDir, "bridge.1.ndjson"), "utf8")
  assert.ok(
    rotated.startsWith("x".repeat(150)),
    "rotated file should contain original content",
  )

  const fresh = fs.readFileSync(logFile, "utf8")
  assert.ok(
    fresh.length < config.logMaxFileSize,
    "fresh log file should be below the size limit",
  )
})

test("rotated files shift up and oldest is dropped at LOG_MAX_FILES", () => {
  // Perform logMaxFiles + 1 rotations so that the oldest falls off
  const rotations = config.logMaxFiles + 1
  for (let i = 1; i <= rotations; i++) {
    fs.writeFileSync(logFile, String(i).repeat(150) + "\n")
    log.error("test", `rotation_${i}`)
  }

  // After logMaxFiles+1 rotations there should be exactly logMaxFiles rotated files
  for (let i = 1; i <= config.logMaxFiles; i++) {
    assert.ok(
      fs.existsSync(path.join(tmpDir, `bridge.${i}.ndjson`)),
      `bridge.${i}.ndjson should exist`,
    )
  }

  // No file beyond the limit
  assert.ok(
    !fs.existsSync(path.join(tmpDir, `bridge.${config.logMaxFiles + 1}.ndjson`)),
    `bridge.${config.logMaxFiles + 1}.ndjson should not exist`,
  )

  // .1.ndjson holds the most-recent pre-rotation content (the last overfill)
  const newest = fs.readFileSync(path.join(tmpDir, "bridge.1.ndjson"), "utf8")
  assert.ok(
    newest.startsWith(String(rotations).repeat(150)),
    "bridge.1.ndjson should contain the most-recent overflowed content",
  )
})
