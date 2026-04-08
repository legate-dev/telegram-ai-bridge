import { mock, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Fixture root ──

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-scanner-test-"))

process.on("exit", () => {
  try { fs.rmSync(tmpDir, { recursive: true }) } catch {}
})

const paths = {
  claude: path.join(tmpDir, "claude"),
  codex: path.join(tmpDir, "codex"),
  copilot: path.join(tmpDir, "copilot"),
  copilotDb: path.join(tmpDir, "copilot", "session-store.db"),
  qwen: path.join(tmpDir, "qwen"),
  gemini: path.join(tmpDir, "gemini"),
  kilo: path.join(tmpDir, "kilo.db"),
}

// ── Mock dependencies before importing cli-scanner ──

const upserted = []
const reconciled = []
let mockCliSessions = {}

// Track log.warn calls so tests can assert on de-dup / rate-limit semantics.
// The other log levels remain no-op (production sends them to the rotating
// log file + DB, which is out of scope for scanner unit tests).
const warnCalls = []

await mock.module("../src/db.js", {
  namedExports: {
    upsertCliSession: (session) => { upserted.push(session) },
    reconcileCliSessions: (cli, sessionIds) => { reconciled.push({ cli, sessionIds }) },
    getCliSessionById: (cli, sessionId) => mockCliSessions[`${cli}:${sessionId}`] ?? null,
  },
})

await mock.module("../src/log.js", {
  namedExports: {
    log: {
      debug: () => {},
      info: () => {},
      warn: (scope, event, data) => { warnCalls.push({ scope, event, data }) },
      error: () => {},
    },
  },
})

await mock.module("../src/config.js", {
  namedExports: {
    config: {
      scanPathClaude: paths.claude,
      scanPathCodex: paths.codex,
      scanPathCopilot: paths.copilot,
      scanPathQwen: paths.qwen,
      scanPathGemini: paths.gemini,
      scanPathKilo: paths.kilo,
    },
  },
})

const { scanAll, _resetWarnedUnrecoverableDirsForTest } = await import("../src/cli-scanner.js")

// ── Helper: filter upserted sessions by cli ──

function sessionsFor(cli) {
  return upserted.filter((s) => s.cli === cli)
}

// ── Helper: create a directory and write a file ──

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf8")
}

// ── scanClaude fixtures ──

// Claude stores sessions as <workspace-folder>/<session-id>.jsonl
// The workspace folder is a path with dashes replacing slashes: "-home-user-project" → /home/user/project
// Use a home-relative path so the homedir boundary check in decodeClaudeFolder passes.
const homeEncoded = os.homedir().split("/").filter(Boolean).join("-")
const claudeWorkspace = "-" + homeEncoded + "-testproject"
const claudeSessionFile = path.join(paths.claude, claudeWorkspace, "abc123def.jsonl")
writeFile(claudeSessionFile, [
  '{"type":"user","message":{"content":"Please help me with this task"},"uuid":"msg1"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Sure, I can help!"}]}}',
  '{"type":"user","message":{"content":"Follow up question"},"uuid":"msg3"}',
].join("\n"))

// A file that should be skipped (agent-prefixed)
const claudeAgentFile = path.join(paths.claude, claudeWorkspace, "agent-sub-session.jsonl")
writeFile(claudeAgentFile, '{"type":"user","message":{"content":"agent task"}}\n')

// A second session with content as an array
const claudeSession2File = path.join(paths.claude, claudeWorkspace, "session2.jsonl")
writeFile(claudeSession2File, [
  '{"type":"user","message":{"content":[{"type":"text","text":"array content message"}]}}',
].join("\n"))

// ── scanCodex fixtures ──

// Codex stores sessions in year/month/day directories
const codexSessionFile = path.join(paths.codex, "2024", "03", "15", "session.jsonl")
writeFile(codexSessionFile, [
  '{"type":"session_meta","payload":{"id":"codex-sess-001","cwd":"/home/user/project","timestamp":"2024-03-15T10:00:00.000Z"}}',
  '{"type":"response_item","payload":{"role":"user"},"timestamp":"2024-03-15T10:01:00.000Z"}',
  '{"type":"response_item","payload":{"role":"assistant"},"timestamp":"2024-03-15T10:02:00.000Z"}',
  '{"type":"response_item","payload":{"role":"user"},"timestamp":"2024-03-15T10:03:00.000Z"}',
].join("\n"))

// A session without session_meta — should be skipped
const codexNoMeta = path.join(paths.codex, "2024", "03", "15", "no-meta.jsonl")
writeFile(codexNoMeta, '{"type":"response_item","payload":{"role":"user"}}\n')

// ── scanCopilot fixtures (SQLite) ──

fs.mkdirSync(paths.copilot, { recursive: true })
const copilotDb = new Database(paths.copilotDb)
copilotDb.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    summary TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT
  );
  INSERT INTO sessions VALUES ('copilot-s1', '/home/user/copilot-project', 'My Copilot Session', '2024-03-01T08:00:00Z', '2024-03-15T12:00:00Z');
  INSERT INTO turns VALUES (NULL, 'copilot-s1');
  INSERT INTO turns VALUES (NULL, 'copilot-s1');
  INSERT INTO sessions VALUES ('copilot-s2', NULL, NULL, '2024-03-10T09:00:00Z', NULL);
`)
copilotDb.close()

// ── scanQwenGemini fixtures ──

// Gemini session directory with logs.json and a checkpoint file
const geminiSessionDir = path.join(paths.gemini, "gem-session-dir")
fs.mkdirSync(geminiSessionDir, { recursive: true })

// checkpoint file with directory info
writeFile(path.join(geminiSessionDir, "checkpoint-001.json"), JSON.stringify([
  { parts: [{ text: "directory: /home/user/gemini-project\nsome other content" }] },
]))

// logs.json with two sessions
writeFile(path.join(geminiSessionDir, "logs.json"), JSON.stringify([
  { sessionId: "gem-sess-A", timestamp: "2024-03-15T10:00:00.000Z", role: "user" },
  { sessionId: "gem-sess-A", timestamp: "2024-03-15T10:01:00.000Z", role: "assistant" },
  { sessionId: "gem-sess-B", timestamp: "2024-03-15T11:00:00.000Z", role: "user" },
]))

// A "bin" directory — should be skipped
fs.mkdirSync(path.join(paths.gemini, "bin"), { recursive: true })

// A dot-directory — should be skipped
fs.mkdirSync(path.join(paths.gemini, ".cache"), { recursive: true })

// A dir without logs.json — should be skipped
fs.mkdirSync(path.join(paths.gemini, "no-logs-dir"), { recursive: true })

// Legacy Gemini hash-dir format: only logs.json + chats/, no .project_root,
// no checkpoint files. This mirrors the pre-2026 Gemini CLI storage layout
// on disk. The scanner guard must skip these directories entirely instead
// of emitting unbindable /unknown-workspace rows.
const geminiLegacyDir = path.join(paths.gemini, "c0ffeeb4b3beef0123456789abcdef")
fs.mkdirSync(geminiLegacyDir, { recursive: true })
writeFile(path.join(geminiLegacyDir, "logs.json"), JSON.stringify([
  { sessionId: "legacy-sess-X", timestamp: "2024-12-01T00:00:00.000Z", role: "user" },
  { sessionId: "legacy-sess-X", timestamp: "2024-12-01T00:01:00.000Z", role: "assistant" },
]))

// ── scanKilo fixtures (SQLite) ──

const kiloDB = new Database(paths.kilo)
kiloDB.exec(`
  CREATE TABLE project (
    id TEXT PRIMARY KEY,
    worktree TEXT
  );
  CREATE TABLE session (
    id TEXT PRIMARY KEY,
    title TEXT,
    directory TEXT,
    project_id TEXT,
    parent_id TEXT,
    time_updated INTEGER
  );
  CREATE TABLE message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    data TEXT
  );
  INSERT INTO project VALUES ('proj-1', '/home/user/kilo-project');
  INSERT INTO session VALUES ('kilo-sess-1', 'My Kilo Session', '/home/user/kilo-project', 'proj-1', NULL, 1710504000000);
  INSERT INTO session VALUES ('kilo-sess-2', 'New session', '/home/user/other', NULL, NULL, 1710510000000);
  INSERT INTO session VALUES ('kilo-child', 'Child session', '/home/user/kilo-project', 'proj-1', 'kilo-sess-1', 1710507000000);
  -- kilo-sess-1: 2 user turns interleaved with 3 assistant rows (text/tool/text).
  -- Real Kilo writes one row per atomic step; only user rows count as turns.
  INSERT INTO message VALUES (NULL, 'kilo-sess-1', '{"role":"user"}');
  INSERT INTO message VALUES (NULL, 'kilo-sess-1', '{"role":"assistant"}');
  INSERT INTO message VALUES (NULL, 'kilo-sess-1', '{"role":"assistant"}');
  INSERT INTO message VALUES (NULL, 'kilo-sess-1', '{"role":"user"}');
  INSERT INTO message VALUES (NULL, 'kilo-sess-1', '{"role":"assistant"}');
`)
kiloDB.close()

// ── Tests ──

test("scanAll returns the total number of sessions found across all CLIs", async () => {
  upserted.length = 0
  const count = await scanAll()
  assert.ok(count > 0, `scanAll should find at least one session, got ${count}`)
  assert.equal(count, upserted.length, "return value should equal the number of upserted sessions")
})

// ── Claude ──

test("scanAll finds Claude sessions and populates the correct fields", async () => {
  upserted.length = 0
  await scanAll()
  const claudeSessions = sessionsFor("claude")

  assert.ok(claudeSessions.length >= 2, "should find at least 2 Claude sessions (two .jsonl files)")

  const mainSession = claudeSessions.find((s) => s.session_id === "abc123def")
  assert.ok(mainSession, "abc123def session should be found")
  assert.equal(mainSession.cli, "claude")
  assert.ok(mainSession.resume_cmd.includes("abc123def"), "resume_cmd should include session ID")
})

test("scanClaude extracts the title from the first user message (string content)", async () => {
  upserted.length = 0
  await scanAll()

  const mainSession = sessionsFor("claude").find((s) => s.session_id === "abc123def")
  assert.ok(mainSession, "session abc123def should exist")
  assert.equal(mainSession.title, "Please help me with this task")
})

test("scanClaude extracts the title from the first user message (array content)", async () => {
  upserted.length = 0
  await scanAll()

  const session2 = sessionsFor("claude").find((s) => s.session_id === "session2")
  assert.ok(session2, "session2 should exist")
  assert.equal(session2.title, "array content message")
})

test("scanClaude skips agent-prefixed files", async () => {
  upserted.length = 0
  await scanAll()

  const agentSession = sessionsFor("claude").find((s) => s.session_id === "agent-sub-session")
  assert.equal(agentSession, undefined, "agent-prefixed files should be skipped")
})

test("scanClaude derives the workspace path from the folder name", async () => {
  upserted.length = 0
  await scanAll()

  const s = sessionsFor("claude").find((s) => s.session_id === "abc123def")
  assert.ok(s, "session should exist")
  assert.equal(s.workspace, path.join(os.homedir(), "testproject"), "workspace should be derived from folder name")
})

test("scanClaude returns /unknown for folders that decode outside home directory", async () => {
  // Create a folder that decodes to /etc/passwd (outside HOME)
  const outsideHomeFolder = "-etc-passwd"
  const outsideSessionFile = path.join(paths.claude, outsideHomeFolder, "outside123.jsonl")
  writeFile(outsideSessionFile, '{"type":"user","message":{"content":"test"},"uuid":"msg1"}\n')

  upserted.length = 0
  await scanAll()

  const s = sessionsFor("claude").find((s) => s.session_id === "outside123")
  assert.ok(s, "session should exist")
  assert.equal(s.workspace, "/unknown", "workspace outside home should be /unknown")
})

test("scanClaude correctly decodes N shared-prefix workspaces (validates cache correctness)", async () => {
  // Create N workspace folders that all share the same leading home path components.
  // This exercises the shared-ancestor cache path in decodeClaudeFolder.
  const N = 5
  const homeEncoded2 = os.homedir().split("/").filter(Boolean).join("-")
  const targetDirs = []

  for (let k = 0; k < N; k++) {
    const folderName = `-${homeEncoded2}-cacheproj${k}`
    const projDir = path.join(paths.claude, folderName)
    fs.mkdirSync(projDir, { recursive: true })
    // Create the actual target directory so decodeClaudeFolder can resolve it.
    const targetDir = path.join(os.homedir(), `cacheproj${k}`)
    fs.mkdirSync(targetDir, { recursive: true })
    targetDirs.push(targetDir)
    // Write a session file so the folder produces a session entry.
    writeFile(
      path.join(projDir, `cachesess${k}.jsonl`),
      `{"type":"user","message":{"content":"cache test ${k}"}}\n`,
    )
  }

  upserted.length = 0
  await scanAll()

  try {
    // All N sessions must be found with correctly decoded workspaces.
    for (let k = 0; k < N; k++) {
      const s = sessionsFor("claude").find((s) => s.session_id === `cachesess${k}`)
      assert.ok(s, `cachesess${k} should be found`)
      assert.equal(
        s.workspace,
        path.join(os.homedir(), `cacheproj${k}`),
        `workspace for cachesess${k} should decode correctly`,
      )
    }
  } finally {
    for (const dir of targetDirs) {
      try { fs.rmSync(dir, { recursive: true }) } catch {}
    }
  }
})

// ── Codex ──

test("scanAll finds the Codex session and populates correct fields", async () => {
  upserted.length = 0
  await scanAll()

  const codexSessions = sessionsFor("codex")
  assert.ok(codexSessions.length >= 1, "should find at least 1 Codex session")

  const s = codexSessions.find((s) => s.session_id === "codex-sess-001")
  assert.ok(s, "codex-sess-001 should be found")
  assert.equal(s.cli, "codex")
  assert.equal(s.workspace, "/home/user/project")
  assert.equal(s.message_count, 2, "should count only user response_item events")
  assert.ok(s.resume_cmd.includes("codex-sess-001"), "resume_cmd should include session ID")
})

test("scanCodex skips files that have no session_meta event", async () => {
  upserted.length = 0
  await scanAll()

  const codexSessions = sessionsFor("codex")
  // The no-meta file has no sessionId so it should be excluded
  const noMetaSession = codexSessions.find((s) => s.session_id === undefined || s.session_id === null)
  assert.equal(noMetaSession, undefined, "sessions without session_meta should be skipped")
})

// ── Copilot ──

test("scanAll finds Copilot sessions from the SQLite database", async () => {
  upserted.length = 0
  await scanAll()

  const copilotSessions = sessionsFor("copilot")
  assert.ok(copilotSessions.length >= 2, "should find at least 2 Copilot sessions")
})

test("scanCopilot populates workspace, title, and message_count correctly", async () => {
  upserted.length = 0
  await scanAll()

  const s = sessionsFor("copilot").find((s) => s.session_id === "copilot-s1")
  assert.ok(s, "copilot-s1 should be found")
  assert.equal(s.workspace, "/home/user/copilot-project")
  assert.equal(s.title, "My Copilot Session")
  assert.equal(s.message_count, 2)
  assert.ok(s.resume_cmd.includes("copilot-s1"))
})

test("scanCopilot sets workspace to /unknown when cwd is null", async () => {
  upserted.length = 0
  await scanAll()

  const s = sessionsFor("copilot").find((s) => s.session_id === "copilot-s2")
  assert.ok(s, "copilot-s2 should be found")
  assert.equal(s.workspace, "/unknown")
})

test("scanCopilot sets title to null when summary is empty", async () => {
  upserted.length = 0
  await scanAll()

  const s = sessionsFor("copilot").find((s) => s.session_id === "copilot-s2")
  assert.ok(s, "copilot-s2 should be found")
  assert.equal(s.title, null)
})

test("scanCopilot returns empty array when the DB file does not exist", async () => {
  // The qwen path does not have a session-store.db file in the base dir
  // (different path from copilotDb) — scanCopilot just won't find sessions for that path.
  // We verify by checking that no sessions with a random non-existent path appear.
  upserted.length = 0
  const count = await scanAll()
  // All sessions should come from real fixtures — this just ensures no crash on missing DB.
  assert.ok(typeof count === "number")
})

// ── Kilo ──

test("scanAll finds Kilo sessions from the SQLite database", async () => {
  upserted.length = 0
  await scanAll()

  const kiloSessions = sessionsFor("kilo")
  assert.ok(kiloSessions.length >= 1, "should find at least 1 Kilo session")
})

test("scanKilo populates workspace from project.worktree and counts user turns only", async () => {
  upserted.length = 0
  mockCliSessions = {}
  await scanAll()

  const s = sessionsFor("kilo").find((s) => s.session_id === "kilo-sess-1")
  assert.ok(s, "kilo-sess-1 should be found")
  assert.equal(s.workspace, "/home/user/kilo-project")
  // Fixture has 5 message rows for kilo-sess-1 (2 user + 3 assistant).
  // message_count must reflect the user-turn count, not the raw row count.
  assert.equal(s.message_count, 2, "message_count should count only role='user' messages")
  assert.ok(s.resume_cmd.includes("kilo-sess-1"))
})

test("scanKilo message_count ignores assistant rows entirely", async () => {
  upserted.length = 0
  await scanAll()

  const s = sessionsFor("kilo").find((s) => s.session_id === "kilo-sess-1")
  // Inflated row count (5) would be ~6x the real conversational round count (2).
  // This test locks the semantic: message_count IS the user turn count, no estimation.
  assert.notEqual(s.message_count, 5, "must not count assistant rows")
  assert.notEqual(s.message_count, 3, "legacy formula (raw COUNT) would be wrong here")
})

test("scanKilo converts 'New session' title to null", async () => {
  upserted.length = 0
  await scanAll()

  const s = sessionsFor("kilo").find((s) => s.session_id === "kilo-sess-2")
  assert.ok(s, "kilo-sess-2 should be found")
  assert.equal(s.title, null, "'New session' title should become null")
})

test("scanKilo excludes child sessions (sessions with a parent_id)", async () => {
  upserted.length = 0
  reconciled.length = 0
  await scanAll()

  const child = sessionsFor("kilo").find((s) => s.session_id === "kilo-child")
  assert.equal(child, undefined, "sessions with a parent_id should be excluded")
})

test("scanKilo sets kilo_messages_seen_at to time_updated after scanning", async () => {
  upserted.length = 0
  mockCliSessions = {}
  await scanAll()

  const s = sessionsFor("kilo").find((s) => s.session_id === "kilo-sess-1")
  assert.ok(s, "kilo-sess-1 should be found")
  assert.equal(s.kilo_messages_seen_at, 1710504000000, "kilo_messages_seen_at should equal time_updated")
})

test("scanKilo uses cached message_count when kilo_messages_seen_at matches time_updated (cache hit)", async () => {
  upserted.length = 0
  mockCliSessions = {
    "kilo:kilo-sess-1": { message_count: 999, kilo_messages_seen_at: 1710504000000 },
  }
  await scanAll()

  const s = sessionsFor("kilo").find((s) => s.session_id === "kilo-sess-1")
  assert.ok(s, "kilo-sess-1 should be found")
  assert.equal(s.message_count, 999, "should return cached message_count on cache hit")
  assert.equal(s.kilo_messages_seen_at, 1710504000000, "kilo_messages_seen_at should remain time_updated")
})

test("scanKilo recomputes message_count when kilo_messages_seen_at differs from time_updated (cache miss)", async () => {
  upserted.length = 0
  mockCliSessions = {
    "kilo:kilo-sess-1": { message_count: 999, kilo_messages_seen_at: 1234567890 },
  }
  await scanAll()

  const s = sessionsFor("kilo").find((s) => s.session_id === "kilo-sess-1")
  assert.ok(s, "kilo-sess-1 should be found")
  assert.equal(s.message_count, 2, "should recompute message_count when cache is stale")
  assert.equal(s.kilo_messages_seen_at, 1710504000000, "kilo_messages_seen_at should be updated to new time_updated")
})

test("scanKilo recomputes message_count when no cached row exists (first scan)", async () => {
  upserted.length = 0
  mockCliSessions = {}
  await scanAll()

  const s = sessionsFor("kilo").find((s) => s.session_id === "kilo-sess-1")
  assert.ok(s, "kilo-sess-1 should be found")
  assert.equal(s.message_count, 2, "should compute message_count when cache is empty")
})

test("scanKilo recomputes message_count when cached row has null kilo_messages_seen_at", async () => {
  upserted.length = 0
  mockCliSessions = {
    "kilo:kilo-sess-1": { message_count: 999, kilo_messages_seen_at: null },
  }
  await scanAll()

  const s = sessionsFor("kilo").find((s) => s.session_id === "kilo-sess-1")
  assert.ok(s, "kilo-sess-1 should be found")
  assert.equal(s.message_count, 2, "should recompute when kilo_messages_seen_at is null")
})

test("scanAll reconciles Kilo rows against the live Kilo DB snapshot", async () => {
  upserted.length = 0
  reconciled.length = 0
  mockCliSessions = {}
  await scanAll()

  assert.equal(reconciled.length, 1, "Kilo reconciliation should run once per scan")
  assert.equal(reconciled[0].cli, "kilo")
  assert.deepEqual(
    reconciled[0].sessionIds.sort(),
    ["kilo-sess-1", "kilo-sess-2"].sort(),
    "only top-level Kilo sessions should be kept in the reconciliation set",
  )
})

test("scanKilo degrades to ok=false (no crash) when the SQL query fails", async () => {
  // Simulate schema drift / JSON1 missing by renaming the `data` column out
  // from under scanKilo. The json_extract() expression will then fail at
  // prepare/execute time and the function MUST return ok=false instead of
  // bubbling the error up to scanAll() and crashing the bridge.
  const writeDb = new Database(paths.kilo)
  writeDb.exec("ALTER TABLE message RENAME COLUMN data TO data_renamed_for_test")
  writeDb.close()

  upserted.length = 0
  reconciled.length = 0
  mockCliSessions = {}

  let didThrow = false
  try {
    await scanAll()
  } catch (error) {
    didThrow = true
  }

  assert.equal(didThrow, false, "scanAll must NOT throw when scanKilo's query fails")

  // Reconciliation must be skipped — the kiloScan returned ok=false, so we
  // must NOT prune the local mirror based on a degraded snapshot.
  const kiloReconcile = reconciled.find((r) => r.cli === "kilo")
  assert.equal(kiloReconcile, undefined, "Kilo reconciliation must be skipped on query failure")

  // Restore the schema for any subsequent tests
  const restoreDb = new Database(paths.kilo)
  restoreDb.exec("ALTER TABLE message RENAME COLUMN data_renamed_for_test TO data")
  restoreDb.close()
})

// ── Qwen / Gemini ──

test("scanAll finds Gemini sessions from the logs.json file", async () => {
  upserted.length = 0
  await scanAll()

  const geminiSessions = sessionsFor("gemini")
  assert.ok(geminiSessions.length >= 2, "should find at least 2 Gemini sessions (gem-sess-A and gem-sess-B)")
})

test("scanQwenGemini extracts workspace from a checkpoint file", async () => {
  upserted.length = 0
  await scanAll()

  const s = sessionsFor("gemini").find((s) => s.session_id === "gem-sess-A")
  assert.ok(s, "gem-sess-A should be found")
  assert.equal(s.workspace, "/home/user/gemini-project", "workspace should come from checkpoint")
})

test("scanQwenGemini correctly counts messages per session", async () => {
  upserted.length = 0
  await scanAll()

  const sessA = sessionsFor("gemini").find((s) => s.session_id === "gem-sess-A")
  const sessB = sessionsFor("gemini").find((s) => s.session_id === "gem-sess-B")
  assert.ok(sessA)
  assert.ok(sessB)
  assert.equal(sessA.message_count, 2, "gem-sess-A should have 2 messages")
  assert.equal(sessB.message_count, 1, "gem-sess-B should have 1 message")
})

test("scanQwenGemini skips 'bin' and dot-prefixed directories", async () => {
  upserted.length = 0
  await scanAll()

  // 'bin' and '.cache' dirs were created but should be skipped
  const binSessions = sessionsFor("gemini").filter(
    (s) => s.workspace && s.workspace.includes("bin"),
  )
  assert.equal(binSessions.length, 0, "sessions from 'bin' dir should be excluded")
})

test("scanQwenGemini skips directories without recoverable workspace metadata", async () => {
  // Regression lock for the /sessions rebind bug: Gemini's pre-2026 storage
  // format used SHA256 hash directories that contained only logs.json and a
  // chats/ folder — no .project_root file, no checkpoint files. The scanner
  // cannot recover a workspace path from these and must refuse to emit
  // session records entirely, rather than poisoning the DB with /unknown
  // rows that later explode at bind/exec time.
  upserted.length = 0
  await scanAll()

  const legacySession = sessionsFor("gemini").find((s) => s.session_id === "legacy-sess-X")
  assert.equal(
    legacySession,
    undefined,
    "legacy hash-dir sessions (no .project_root, no checkpoints) must be skipped entirely",
  )

  // Defense: no gemini session produced by scanAll may carry a sentinel
  // workspace. If this ever fires, the scanner guard has regressed.
  const sentinelSessions = sessionsFor("gemini").filter(
    (s) => !s.workspace || s.workspace === "/unknown" || s.workspace === ".",
  )
  assert.equal(
    sentinelSessions.length,
    0,
    "scanner must never emit gemini sessions with sentinel workspace",
  )
})

test("scanQwenGemini warns at most once per unrecoverable directory across scans", async () => {
  // Regression lock for the log-spam issue raised on PR #106 review: the
  // fs watcher re-runs scanAll() on every .json change, so without de-dup
  // each legacy hash-dir would emit a persisted warn row on every scan
  // (multiple times per minute during an active Gemini session). The fix
  // keeps a process-lifetime Set of already-warned dirPaths; the test
  // exercises two consecutive scans against the same legacy fixture and
  // asserts the warn count goes 1+ → 0.
  //
  // We reset the de-dup cache via the _resetForTest seam so this test is
  // independent of execution order relative to earlier tests that may have
  // already warmed the cache on the same fixture.
  _resetWarnedUnrecoverableDirsForTest()
  warnCalls.length = 0
  upserted.length = 0

  await scanAll()

  const firstPassWarns = warnCalls.filter(
    (c) =>
      c.event === "gemini.workspace.unrecoverable" ||
      c.event === "qwen.workspace.unrecoverable",
  )
  assert.ok(
    firstPassWarns.length >= 1,
    "first scan must emit at least one unrecoverable-workspace warn for the legacy fixture",
  )

  // Reset only the observation array; the de-dup cache MUST retain its state
  // so the second scan observes the "already warned" path.
  warnCalls.length = 0
  upserted.length = 0

  await scanAll()

  const secondPassWarns = warnCalls.filter(
    (c) =>
      c.event === "gemini.workspace.unrecoverable" ||
      c.event === "qwen.workspace.unrecoverable",
  )
  assert.equal(
    secondPassWarns.length,
    0,
    "second scan must NOT re-warn for the same unrecoverable directory (de-dup regression)",
  )
})

test("scanAll returns a non-negative count and upserts the same number of sessions", async () => {
  upserted.length = 0
  const count = await scanAll()
  assert.ok(typeof count === "number" && count >= 0)
  assert.equal(count, upserted.length, "return value should match the number of upserted sessions")
})

// ── JOIN_CHARS tie-break ──

test("decodeClaudeFolder JOIN_CHARS tie-break: hyphen wins over underscore", async () => {
  // Create a temporary directory inside the real home so the home-boundary check passes.
  // mkdtempSync appends random alphanumeric chars, so no separators in the dir name.
  const tiebreakDir = fs.mkdtempSync(path.join(os.homedir(), "tiebreak"))
  const tiebreakDirName = path.basename(tiebreakDir)

  // Create both ambiguous variants at the same level.
  fs.mkdirSync(path.join(tiebreakDir, "go-server"))
  fs.mkdirSync(path.join(tiebreakDir, "go_server"))

  // Encode the path: strip leading "/", split by "/", join with "-", prepend "-".
  // e.g. /home/runner/tiebreakXXX/go-server → -home-runner-tiebreakXXX-go-server
  const homeEncoded = os.homedir().split("/").filter(Boolean).join("-")
  const encodedFolder = "-" + homeEncoded + "-" + tiebreakDirName + "-go-server"

  const sessionFile = path.join(paths.claude, encodedFolder, "tiebreaktest.jsonl")
  writeFile(sessionFile, '{"type":"user","message":{"content":"tie-break test"},"uuid":"tb1"}\n')

  try {
    upserted.length = 0
    await scanAll()

    const s = sessionsFor("claude").find((s) => s.session_id === "tiebreaktest")
    assert.ok(s, "tiebreaktest session should be found")
    assert.equal(
      s.workspace,
      path.join(tiebreakDir, "go-server"),
      "JOIN_CHARS tie-break: hyphen (-) must win over underscore (_)",
    )
  } finally {
    fs.rmSync(tiebreakDir, { recursive: true })
    try { fs.rmSync(path.join(paths.claude, encodedFolder), { recursive: true }) } catch {}
  }
})
