import { mock, test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Mock log-store to avoid the better-sqlite3 native dependency, while keeping
// the real log.js (and therefore the real redactString) in scope.
await mock.module("../src/log-store.js", {
  namedExports: { persistLogEvent: () => {} },
})

// Mock db and config, but use the REAL redactString so that pattern-based
// redaction is actually exercised (not stubbed away).
await mock.module("../src/db.js", {
  namedExports: {
    getChatBinding: () => null,
    recentSessions: () => [],
    getCliSessionById: () => null,
  },
})

await mock.module("../src/config.js", {
  namedExports: {
    config: {
      telegramAllowedUserId: "12345",
      defaultDirectory: process.cwd(),
      logLevel: "error",
      telegramBotToken: null,
      kiloServerPassword: null,
    },
  },
})

const { formatSessionLine } = await import("../src/telegram-utils.js")

// ── formatSessionLine redaction ──

test("formatSessionLine redacts sk- API key in session title", () => {
  const session = {
    cli: "claude",
    session_id: "abc123defghi0001",
    workspace: path.join(os.homedir(), "project"),
    title: "my key is sk-abc123def456ghi789jklmnopqrstu",
    message_count: 5,
    last_activity: new Date(Date.now() - 3_600_000).toISOString(),
  }
  const result = formatSessionLine(session)
  assert.ok(result.includes("sk-<REDACTED>"), "should contain redacted key placeholder")
  assert.ok(!result.includes("sk-abc123def456"), "should not contain the raw API key")
})

test("formatSessionLine redacts sk- API key in display_name", () => {
  const session = {
    cli: "claude",
    session_id: "abc123defghi0002",
    workspace: path.join(os.homedir(), "project"),
    display_name: "session sk-secretkeyabcdef12345678901",
    title: null,
    message_count: 3,
    last_activity: new Date(Date.now() - 7_200_000).toISOString(),
  }
  const result = formatSessionLine(session)
  assert.ok(result.includes("sk-<REDACTED>"), "should contain redacted key placeholder")
  assert.ok(!result.includes("sk-secretkeyabcdef"), "should not contain the raw key in display_name")
})

test("formatSessionLine does not alter plain titles with no secrets", () => {
  const session = {
    cli: "kilo",
    session_id: "abc123defghi0003",
    workspace: path.join(os.homedir(), "project"),
    title: "My normal project session",
    message_count: 10,
    last_activity: new Date(Date.now() - 10_800_000).toISOString(),
  }
  const result = formatSessionLine(session)
  assert.ok(result.includes("My normal project session"), "should include plain title unchanged")
})

test("formatSessionLine redacts GitHub personal access token in title", () => {
  const session = {
    cli: "codex",
    session_id: "abc123defghi0004",
    workspace: path.join(os.homedir(), "project"),
    title: "token ghp_" + "A".repeat(36),
    message_count: 1,
    last_activity: new Date(Date.now() - 1_800_000).toISOString(),
  }
  const result = formatSessionLine(session)
  // Unified gh[pusro]_ pattern collapses to gh_<REDACTED>
  assert.ok(result.includes("gh_<REDACTED>"), "should redact GitHub PAT in title")
  assert.ok(!result.includes("ghp_" + "A".repeat(36)), "should not contain the raw token")
})
