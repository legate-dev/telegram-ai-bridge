import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { after, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Redirect the DB to a temp directory so the test leaves no artefacts.
// DB_PATH is resolved from process.cwd() at module-evaluation time, so
// the chdir must happen before the first import of src/db.js.
const testDir = await mkdtemp(join(tmpdir(), "tbridge-db-"))
const originalCwd = process.cwd()
process.chdir(testDir)

const {
  upsertCliSession,
  recentSessions,
  getCliSessionById,
  reconcileCliSessions,
  getKiloBridgeSessions,
  sessionCountsByCli,
  getChatBinding,
  setChatBinding,
  clearChatBinding,
} = await import("../src/db.js")

process.chdir(originalCwd)

// Async cleanup via node:test `after()` hook. Using process.on("exit") here
// would silently leak the temp directory because exit handlers must be
// synchronous — any pending Promise (including the one from fs.promises.rm)
// is abandoned when the process exits.
after(async () => {
  await rm(testDir, { recursive: true }).catch(() => {})
})

// ── cli_sessions ──

test("upsertCliSession inserts a new session row", () => {
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-insert-001",
    workspace: "/home/user/project",
    title: "First Session",
    message_count: 5,
    last_activity: "2024-01-01T10:00:00Z",
    resume_cmd: null,
  })
  const row = getCliSessionById("kilo", "sess-insert-001")
  assert.ok(row, "row should exist after insert")
  assert.equal(row.cli, "kilo")
  assert.equal(row.session_id, "sess-insert-001")
  assert.equal(row.workspace, "/home/user/project")
  assert.equal(row.title, "First Session")
  assert.equal(row.message_count, 5)
})

test("upsertCliSession updates an existing row on conflict", () => {
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-update-002",
    workspace: "/home/user/repo",
    title: "Original Title",
    message_count: 1,
    last_activity: "2024-01-01T09:00:00Z",
    resume_cmd: null,
  })
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-update-002",
    workspace: "/home/user/repo",
    title: "Updated Title",
    message_count: 10,
    last_activity: "2024-01-02T12:00:00Z",
    resume_cmd: "kilo resume sess-update-002",
  })
  const row = getCliSessionById("kilo", "sess-update-002")
  assert.equal(row.title, "Updated Title")
  assert.equal(row.message_count, 10)
  assert.equal(row.resume_cmd, "kilo resume sess-update-002")
})

test("upsertCliSession preserves existing title when the new title is null", () => {
  upsertCliSession({
    cli: "claude",
    session_id: "sess-title-003",
    workspace: "/projects/foo",
    title: "Keep This Title",
    message_count: 1,
    last_activity: "2024-01-01T00:00:00Z",
    resume_cmd: null,
  })
  upsertCliSession({
    cli: "claude",
    session_id: "sess-title-003",
    workspace: "/projects/foo",
    title: null,
    message_count: 2,
    last_activity: "2024-01-02T00:00:00Z",
    resume_cmd: null,
  })
  const row = getCliSessionById("claude", "sess-title-003")
  assert.equal(row.title, "Keep This Title", "existing title must not be overwritten by null")
})

test("recentSessions returns rows ordered by last_activity descending", () => {
  upsertCliSession({ cli: "codex", session_id: "rs-a", workspace: "/a", title: "A", message_count: 0, last_activity: "2024-01-01T00:00:00Z", resume_cmd: null })
  upsertCliSession({ cli: "codex", session_id: "rs-b", workspace: "/b", title: "B", message_count: 0, last_activity: "2024-01-03T00:00:00Z", resume_cmd: null })
  upsertCliSession({ cli: "codex", session_id: "rs-c", workspace: "/c", title: "C", message_count: 0, last_activity: "2024-01-02T00:00:00Z", resume_cmd: null })

  const rows = recentSessions({ cli: "codex", limit: 10 })
  const ids = rows.map((r) => r.session_id)
  assert.ok(ids.indexOf("rs-b") < ids.indexOf("rs-c"), "newer session should precede older session")
  assert.ok(ids.indexOf("rs-c") < ids.indexOf("rs-a"), "second newest should precede oldest")
})

test("recentSessions filters by cli when cli is provided", () => {
  upsertCliSession({ cli: "gemini", session_id: "gem-001", workspace: "/g", title: null, message_count: 0, last_activity: "2024-01-01T00:00:00Z", resume_cmd: null })

  const rows = recentSessions({ cli: "gemini", limit: 10 })
  assert.ok(rows.length > 0, "should return at least one gemini row")
  assert.ok(rows.every((r) => r.cli === "gemini"), "all returned rows must be gemini sessions")
})

test("recentSessions returns sessions from all CLIs when cli is omitted", () => {
  const rows = recentSessions({ limit: 100 })
  const clis = new Set(rows.map((r) => r.cli))
  assert.ok(clis.size >= 2, "should have rows from at least two different CLIs")
})

test("recentSessions respects the limit parameter", () => {
  const rows = recentSessions({ limit: 2 })
  assert.ok(rows.length <= 2, "should not exceed the requested limit")
})

test("recentSessions excludes rows with sentinel workspace values", () => {
  // Regression lock for the /sessions rebind bug: rows with workspace
  // '/unknown' or '.' used to come from the scanner fallback when the CLI's
  // on-disk metadata didn't reveal a real workspace (e.g. Gemini/Qwen legacy
  // hash-directory storage). They must never appear in the /sessions picker
  // because binding them fails with ENOENT at exec.
  upsertCliSession({
    cli: "sentinel-test",
    session_id: "ok-1",
    workspace: "/home/user/real-project",
    title: "Real",
    message_count: 0,
    last_activity: "2024-07-01T00:00:00Z",
    resume_cmd: null,
  })
  upsertCliSession({
    cli: "sentinel-test",
    session_id: "bad-unknown",
    workspace: "/unknown",
    title: "Legacy",
    message_count: 0,
    last_activity: "2024-07-02T00:00:00Z",
    resume_cmd: null,
  })
  upsertCliSession({
    cli: "sentinel-test",
    session_id: "bad-dot",
    workspace: ".",
    title: "Relative",
    message_count: 0,
    last_activity: "2024-07-03T00:00:00Z",
    resume_cmd: null,
  })

  const rows = recentSessions({ cli: "sentinel-test", limit: 10 })
  const ids = rows.map((r) => r.session_id)
  assert.ok(ids.includes("ok-1"), "real-workspace row must appear in the listing")
  assert.ok(!ids.includes("bad-unknown"), "/unknown workspace row must be excluded")
  assert.ok(!ids.includes("bad-dot"), "'.' workspace row must be excluded")
})

test("getCliSessionById returns undefined for a non-existent session", () => {
  const row = getCliSessionById("kilo", "does-not-exist-xyz")
  assert.equal(row, undefined)
})

test("sessionCountsByCli returns counts grouped by CLI", () => {
  const counts = sessionCountsByCli()
  assert.ok(Array.isArray(counts), "result should be an array")
  assert.ok(counts.length > 0, "should have at least one CLI entry")
  for (const row of counts) {
    assert.ok(typeof row.cli === "string", "cli must be a string")
    assert.ok(typeof row.count === "number", "count must be a number")
    assert.ok(row.count > 0, "count must be positive")
  }
})

test("reconcileCliSessions removes stale session rows and invalid chat bindings", () => {
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-keep-1",
    workspace: "/keep",
    title: "Keep me",
    message_count: 1,
    last_activity: "2024-01-05T00:00:00Z",
    resume_cmd: "kilo --session sess-keep-1",
  })
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-drop-1",
    workspace: "/drop",
    title: "Drop me",
    message_count: 1,
    last_activity: "2024-01-04T00:00:00Z",
    resume_cmd: "kilo --session sess-drop-1",
  })
  setChatBinding("chat-stale-kilo", {
    cli: "kilo",
    session_id: "sess-drop-1",
    agent: null,
    directory: "/drop",
  })

  reconcileCliSessions("kilo", ["sess-keep-1"])

  assert.ok(getCliSessionById("kilo", "sess-keep-1"), "kept session should remain")
  assert.equal(getCliSessionById("kilo", "sess-drop-1"), undefined, "stale session should be removed")
  assert.equal(getChatBinding("chat-stale-kilo"), null, "binding to removed session should be cleared")
})

test("reconcileCliSessions maintains binding-session referential integrity (R3)", () => {
  // Regression lock for R3: the two DELETE statements must be wrapped in
  // a single SQLite transaction so they atomically succeed or roll back.
  // The post-condition we lock here is structural: after reconcile, NO
  // chat_binding row may reference a session_id that does not exist in
  // cli_sessions for the same cli.
  upsertCliSession({
    cli: "txn-test",
    session_id: "alpha",
    workspace: "/a",
    title: "Alpha",
    message_count: 0,
    last_activity: "2024-01-01T00:00:00Z",
    resume_cmd: null,
  })
  upsertCliSession({
    cli: "txn-test",
    session_id: "beta",
    workspace: "/b",
    title: "Beta",
    message_count: 0,
    last_activity: "2024-01-02T00:00:00Z",
    resume_cmd: null,
  })
  setChatBinding("chat-txn-1", { cli: "txn-test", session_id: "alpha", agent: null, directory: "/a" })
  setChatBinding("chat-txn-2", { cli: "txn-test", session_id: "beta",  agent: null, directory: "/b" })

  // Reconcile keeping only "alpha" — beta and its binding must both go
  reconcileCliSessions("txn-test", ["alpha"])

  // Post-condition checks
  assert.ok(getCliSessionById("txn-test", "alpha"), "alpha must remain")
  assert.equal(getCliSessionById("txn-test", "beta"), undefined, "beta must be deleted")
  assert.ok(getChatBinding("chat-txn-1"), "alpha binding must remain")
  assert.equal(getChatBinding("chat-txn-2"), null, "beta binding must be deleted")

  // The structural invariant: every remaining binding for txn-test must
  // reference an existing cli_session. We don't expose a direct query for
  // this, but the two assertions above cover the post-condition for this
  // specific scenario. The transaction wrap means a partial failure cannot
  // produce a state where binding chat-txn-2 exists without cli_session beta.
})

test("reconcileCliSessions handles 5000+ session IDs without parameter limit error", () => {
  // Regression test for B2: the old IN (?, ?, ...) implementation would
  // crash with RangeError once the array exceeded SQLITE_MAX_VARIABLE_NUMBER
  // (default 32766) or V8's argument cap (65535). The json_each-based
  // rewrite uses exactly one bound parameter regardless of array size.
  //
  // We seed 5001 sessions, then call reconcileCliSessions with the first
  // 5000 as the keep set; the 5001th must be dropped, none of the 5000
  // must be touched, and the call must NOT throw.
  const N = 5001
  const allIds = []
  for (let i = 0; i < N; i++) {
    const id = `bulk-sess-${String(i).padStart(5, "0")}`
    allIds.push(id)
    upsertCliSession({
      cli: "bulk-test-cli",
      session_id: id,
      workspace: "/bulk",
      title: `Bulk ${i}`,
      message_count: 0,
      last_activity: "2024-01-01T00:00:00Z",
      resume_cmd: null,
    })
  }

  const keepIds = allIds.slice(0, N - 1)  // 5000 ids
  const dropId = allIds[N - 1]            // 1 id to drop

  // Critical: this MUST NOT throw RangeError or any SQL parameter error.
  let didThrow = false
  let thrownError = null
  try {
    reconcileCliSessions("bulk-test-cli", keepIds)
  } catch (error) {
    didThrow = true
    thrownError = error
  }

  assert.equal(
    didThrow,
    false,
    `reconcileCliSessions must handle ${N - 1} ids without throwing (got: ${thrownError?.message})`,
  )
  assert.equal(
    getCliSessionById("bulk-test-cli", dropId),
    undefined,
    "the one id NOT in the keep set must be deleted",
  )
  assert.ok(
    getCliSessionById("bulk-test-cli", keepIds[0]),
    "the first kept id must still exist",
  )
  assert.ok(
    getCliSessionById("bulk-test-cli", keepIds[keepIds.length - 1]),
    "the last kept id must still exist",
  )
})

// ── source flag (bridge ownership) ──

test("upsertCliSession persists source='bridge' when explicitly tagged", () => {
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-source-1",
    workspace: "/work",
    title: "Bridge owned",
    message_count: 0,
    last_activity: "2024-02-01T00:00:00Z",
    resume_cmd: null,
    source: "bridge",
  })
  const row = getCliSessionById("kilo", "sess-source-1")
  assert.equal(row.source, "bridge", "source flag must persist")
})

test("upsertCliSession defaults source to NULL when not provided (legacy callers)", () => {
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-source-2",
    workspace: "/work",
    title: "External",
    message_count: 0,
    last_activity: "2024-02-02T00:00:00Z",
    resume_cmd: null,
  })
  const row = getCliSessionById("kilo", "sess-source-2")
  assert.equal(row.source, null, "missing source must remain NULL, not coerced")
})

test("upsertCliSession preserves source='bridge' across scanner re-upserts", () => {
  // Initial insert by createNewSession (sets source).
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-source-3",
    workspace: "/work",
    title: "Bridge owned",
    message_count: 0,
    last_activity: "2024-02-03T00:00:00Z",
    resume_cmd: null,
    source: "bridge",
  })
  // Subsequent upsert by scanAll() — does NOT know about source.
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-source-3",
    workspace: "/work",
    title: "Bridge owned",
    message_count: 7,
    last_activity: "2024-02-03T01:00:00Z",
    resume_cmd: "kilo --session sess-source-3",
  })
  const row = getCliSessionById("kilo", "sess-source-3")
  assert.equal(row.source, "bridge", "scanner upsert must NOT clobber source flag back to NULL")
  assert.equal(row.message_count, 7, "scanner upsert must still update other fields")
})

test("getKiloBridgeSessions returns only source='bridge' rows for cli='kilo'", () => {
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-bridge-A",
    workspace: "/a",
    title: "Bridge A",
    message_count: 2,
    last_activity: "2024-03-01T00:00:00Z",
    resume_cmd: null,
    source: "bridge",
  })
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-external-B",
    workspace: "/b",
    title: "External B",
    message_count: 50,
    last_activity: "2024-03-02T00:00:00Z",
    resume_cmd: null,
    // no source → NULL → must NOT appear
  })
  upsertCliSession({
    cli: "claude",
    session_id: "sess-claude-C",
    workspace: "/c",
    title: "Claude C",
    message_count: 1,
    last_activity: "2024-03-03T00:00:00Z",
    resume_cmd: null,
    source: "bridge", // bridge-tagged but not Kilo → must NOT appear
  })

  const rows = getKiloBridgeSessions()
  const ids = rows.map((r) => r.session_id)
  assert.ok(ids.includes("sess-bridge-A"), "Kilo bridge-tagged row must appear")
  assert.ok(!ids.includes("sess-external-B"), "Kilo external (NULL source) row must NOT appear")
  assert.ok(!ids.includes("sess-claude-C"), "Non-Kilo bridge row must NOT appear")
})

test("getKiloBridgeSessions excludes the bound session when boundId is given", () => {
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-bound-X",
    workspace: "/x",
    title: "Bound",
    message_count: 1,
    last_activity: "2024-04-01T00:00:00Z",
    resume_cmd: null,
    source: "bridge",
  })
  upsertCliSession({
    cli: "kilo",
    session_id: "sess-other-Y",
    workspace: "/y",
    title: "Other",
    message_count: 1,
    last_activity: "2024-04-02T00:00:00Z",
    resume_cmd: null,
    source: "bridge",
  })

  const rows = getKiloBridgeSessions("sess-bound-X")
  const ids = rows.map((r) => r.session_id)
  assert.ok(!ids.includes("sess-bound-X"), "bound session must be excluded")
  assert.ok(ids.includes("sess-other-Y"), "other bridge sessions must still appear")
})

// ── chat_bindings ──

test("getChatBinding returns null for a chat with no binding", () => {
  const result = getChatBinding("chat-unbound-99999")
  assert.equal(result, null)
})

test("setChatBinding inserts a new binding", () => {
  setChatBinding("chat-insert-100", {
    cli: "kilo",
    session_id: "sess-bind-1",
    agent: "claude-sonnet",
    directory: "/home/user/work",
  })
  const binding = getChatBinding("chat-insert-100")
  assert.ok(binding, "binding should exist after insert")
  assert.equal(binding.cli, "kilo")
  assert.equal(binding.session_id, "sess-bind-1")
  assert.equal(binding.agent, "claude-sonnet")
  assert.equal(binding.directory, "/home/user/work")
})

test("setChatBinding updates an existing binding on conflict", () => {
  setChatBinding("chat-update-101", { cli: "kilo", session_id: "old-id", agent: "a", directory: "/old" })
  setChatBinding("chat-update-101", { cli: "claude", session_id: "new-id", agent: null, directory: "/new" })

  const binding = getChatBinding("chat-update-101")
  assert.equal(binding.cli, "claude")
  assert.equal(binding.session_id, "new-id")
  assert.equal(binding.directory, "/new")
})

test("setChatBinding preserves the existing agent when the new agent is null", () => {
  setChatBinding("chat-agent-102", { cli: "kilo", session_id: "s1", agent: "gpt-4", directory: "/dir" })
  setChatBinding("chat-agent-102", { cli: "kilo", session_id: "s1", agent: null, directory: "/dir" })

  const binding = getChatBinding("chat-agent-102")
  assert.equal(binding.agent, "gpt-4", "agent must not be overwritten by null")
})

test("clearChatBinding removes the binding", () => {
  setChatBinding("chat-clear-200", { cli: "kilo", session_id: "to-delete", agent: null, directory: "/d" })
  clearChatBinding("chat-clear-200")
  const binding = getChatBinding("chat-clear-200")
  assert.equal(binding, null)
})

test("clearChatBinding is idempotent when no binding exists", () => {
  assert.doesNotThrow(() => clearChatBinding("chat-nonexistent-888"))
})

test("setChatBinding persists model value", () => {
  setChatBinding("chat-model-300", { cli: "claude", session_id: "s-model-1", agent: null, model: "opus", directory: "/m" })
  const binding = getChatBinding("chat-model-300")
  assert.equal(binding.model, "opus", "model should be stored")
})

test("setChatBinding clears model when null is explicitly passed", () => {
  setChatBinding("chat-model-301", { cli: "claude", session_id: "s-model-2", agent: null, model: "opus", directory: "/m" })
  setChatBinding("chat-model-301", { cli: "claude", session_id: "s-model-2", agent: null, model: null, directory: "/m" })
  const binding = getChatBinding("chat-model-301")
  assert.equal(binding.model, null, "model must be cleared when null is explicitly passed")
})

test("setChatBinding updates model to a new value", () => {
  setChatBinding("chat-model-302", { cli: "codex", session_id: "s-model-3", agent: null, model: "gpt-5.4", directory: "/m" })
  setChatBinding("chat-model-302", { cli: "codex", session_id: "s-model-3", agent: null, model: "gpt-5-mini", directory: "/m" })
  const binding = getChatBinding("chat-model-302")
  assert.equal(binding.model, "gpt-5-mini", "model should be updated to the new value")
})

test("setChatBinding and getChatBinding coerce numeric chatId to string", () => {
  setChatBinding(12_345, { cli: "kilo", session_id: "num-id", agent: null, directory: "/num" })
  const binding = getChatBinding(12_345)
  assert.ok(binding, "should find binding with numeric chatId")
  assert.equal(binding.session_id, "num-id")
})

// ── reconcileCliSessions preserves session_id='' sentinel rows ──

test("reconcileCliSessions (empty-list fast-path) preserves session_id='' preference-only binding", () => {
  // Simulate /agent written before any session exists: session_id is ''
  setChatBinding("chat-sentinel-fastpath", {
    cli: "kilo",
    session_id: "",
    agent: "sonnet",
    directory: "/tmp",
  })

  // Fast-path: no live sessions → would previously wipe ALL kilo bindings
  reconcileCliSessions("kilo", [])

  const binding = getChatBinding("chat-sentinel-fastpath")
  assert.ok(binding, "preference-only binding must survive the empty-list fast-path")
  assert.equal(binding.agent, "sonnet", "agent preference must be preserved")
  assert.equal(binding.session_id, "", "session_id sentinel must remain empty string")
})

test("reconcileCliSessions (normal path) preserves session_id='' preference-only binding", () => {
  // Simulate /agent written before any session exists: session_id is ''
  setChatBinding("chat-sentinel-normal", {
    cli: "kilo",
    session_id: "",
    agent: "sonnet",
    directory: "/tmp",
  })
  // Also insert a real session that will be kept
  upsertCliSession({
    cli: "kilo",
    session_id: "live-uuid-for-normal",
    workspace: "/work",
    title: "Live session",
    message_count: 1,
    last_activity: "2024-06-01T00:00:00Z",
    resume_cmd: null,
  })

  // Normal path: live-uuid-for-normal is present; sentinel row must survive
  reconcileCliSessions("kilo", ["live-uuid-for-normal"])

  const binding = getChatBinding("chat-sentinel-normal")
  assert.ok(binding, "preference-only binding must survive the normal reconcile path")
  assert.equal(binding.agent, "sonnet", "agent preference must be preserved")
  assert.equal(binding.session_id, "", "session_id sentinel must remain empty string")
})
