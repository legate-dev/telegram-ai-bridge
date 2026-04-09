import { mock, test } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Mutable state lets individual tests adjust db/config responses.
const mockDb = { binding: null, sessions: [], sessionsById: {} }
const mockConfig = {
  telegramAllowedUserId: "12345",
  defaultDirectory: process.cwd(),
  logLevel: "error",
}

await mock.module("../src/db.js", {
  namedExports: {
    getChatBinding: () => mockDb.binding,
    recentSessions: () => mockDb.sessions,
    getCliSessionById: (cli, sessionId) => {
      const key = `${cli}:${sessionId}`
      return Object.hasOwn(mockDb.sessionsById, key) ? mockDb.sessionsById[key] : null
    },
  },
})

await mock.module("../src/config.js", {
  namedExports: { config: mockConfig },
})

await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    redactString: (s) => s,
  },
})

const {
  authorizedUserId,
  displayPath,
  hasBoundSession,
  resolvePreferredAgent,
  resolveDirectory,
  parseUserPath,
  validateWorkspaceDirectory,
  timeAgo,
  compactPath,
  formatSessionLine,
  resolveSessionLabel,
} = await import("../src/telegram-utils.js")

// ── authorizedUserId ──

test("authorizedUserId returns the configured user ID as a string", () => {
  assert.equal(authorizedUserId(), "12345")
})

// ── displayPath ──

test("displayPath returns '~' for null input", () => {
  assert.equal(displayPath(null), "~")
})

test("displayPath returns '~' for an empty string", () => {
  assert.equal(displayPath(""), "~")
})

test("displayPath returns tilde-prefixed path for cwd when under home", () => {
  const cwd = process.cwd()
  const home = os.homedir()
  const result = displayPath(cwd)
  if (cwd === home) {
    assert.equal(result, "~")
  } else if (cwd.startsWith(`${home}${path.sep}`)) {
    assert.equal(result, `~/${path.relative(home, cwd)}`)
  } else {
    assert.equal(result, cwd)
  }
})

test("displayPath returns tilde-prefixed path for a subdirectory of cwd", () => {
  const sub = path.join(process.cwd(), "src", "utils")
  const home = os.homedir()
  const result = displayPath(sub)
  if (sub.startsWith(`${home}${path.sep}`)) {
    assert.equal(result, `~/${path.relative(home, sub)}`)
  } else {
    assert.equal(result, sub)
  }
})

test("displayPath returns '~' for the user home directory", () => {
  assert.equal(displayPath(os.homedir()), "~")
})

test("displayPath returns a tilde-prefixed path for a path inside home", () => {
  const sub = path.join(os.homedir(), "projects", "myapp")
  const result = displayPath(sub)
  assert.equal(result, path.join("~", "projects", "myapp"))
})

test("displayPath returns the absolute path for an unrecognised location", () => {
  const abs = "/some/absolute/path"
  assert.equal(displayPath(abs), abs)
})

// ── hasBoundSession ──

test("hasBoundSession returns false for null", () => {
  assert.equal(hasBoundSession(null), false)
})

test("hasBoundSession returns false when session_id is missing", () => {
  assert.equal(hasBoundSession({ directory: "/tmp" }), false)
})

test("hasBoundSession returns false when directory is missing", () => {
  assert.equal(hasBoundSession({ session_id: "abc" }), false)
})

test("hasBoundSession returns true when both session_id and directory are present", () => {
  assert.equal(hasBoundSession({ session_id: "abc", directory: "/tmp" }), true)
})

test("hasBoundSession returns false when session_id is an empty string", () => {
  assert.equal(hasBoundSession({ session_id: "", directory: "/tmp" }), false)
})

// ── resolvePreferredAgent ──

const fakeRegistry = {
  primaryAgents: ["sonnet", "haiku", "opus"],
  bridgeDefault: "sonnet",
}

test("resolvePreferredAgent returns the binding agent when it exists in the registry", () => {
  const result = resolvePreferredAgent({ agent: "haiku" }, fakeRegistry)
  assert.equal(result, "haiku")
})

test("resolvePreferredAgent falls back to bridgeDefault when binding agent is not in the registry", () => {
  const result = resolvePreferredAgent({ agent: "unknown-agent" }, fakeRegistry)
  assert.equal(result, "sonnet")
})

test("resolvePreferredAgent uses bridgeDefault when binding has no agent", () => {
  const result = resolvePreferredAgent({ agent: null }, fakeRegistry)
  assert.equal(result, "sonnet")
})

test("resolvePreferredAgent uses bridgeDefault when binding is null", () => {
  const result = resolvePreferredAgent(null, fakeRegistry)
  assert.equal(result, "sonnet")
})

// ── resolveDirectory ──

test("resolveDirectory returns an absolute argument unchanged", () => {
  const result = resolveDirectory("/absolute/path", "chat-1")
  assert.equal(result, "/absolute/path")
})

test("resolveDirectory resolves a relative argument against process.cwd()", () => {
  const result = resolveDirectory("relative/path", "chat-1")
  assert.equal(result, path.resolve(process.cwd(), "relative/path"))
})

test("resolveDirectory returns the explicit env default when it differs from cwd", () => {
  mockConfig.defaultDirectory = "/my/custom/dir"
  try {
    const result = resolveDirectory(null, null)
    assert.equal(result, "/my/custom/dir")
  } finally {
    mockConfig.defaultDirectory = process.cwd()
  }
})

test("resolveDirectory uses bound session directory when env default equals cwd", () => {
  mockDb.binding = { directory: "/session/workspace" }
  try {
    const result = resolveDirectory(null, "chat-abc")
    assert.equal(result, "/session/workspace")
  } finally {
    mockDb.binding = null
  }
})

test("resolveDirectory uses most recent session workspace when no chatId and no env override", () => {
  mockDb.sessions = [{ workspace: "/recent/workspace" }]
  try {
    const result = resolveDirectory(null, null)
    assert.equal(result, "/recent/workspace")
  } finally {
    mockDb.sessions = []
  }
})

test("resolveDirectory ignores /unknown sentinel workspace and falls back to cwd", () => {
  mockDb.sessions = [{ workspace: "/unknown" }]
  try {
    const result = resolveDirectory(null, null)
    assert.equal(result, process.cwd())
  } finally {
    mockDb.sessions = []
  }
})

test("resolveDirectory falls back to process.cwd() when all other sources are empty", () => {
  // mockDb.binding = null, mockDb.sessions = [], mockConfig.defaultDirectory = process.cwd()
  const result = resolveDirectory(null, null)
  assert.equal(result, process.cwd())
})

test("resolveDirectory expands ~/ to the user home directory", () => {
  const result = resolveDirectory("~/myproject", "chat-tilde")
  assert.equal(result, path.join(os.homedir(), "myproject"))
})

test("resolveDirectory expands ~/ for nested paths", () => {
  const result = resolveDirectory("~/code/myrepo/src", "chat-tilde-nested")
  assert.equal(result, path.join(os.homedir(), "code/myrepo/src"))
})

// ── parseUserPath ──

test("parseUserPath accepts an absolute path unchanged", () => {
  const result = parseUserPath("/Users/foo/repo")
  assert.deepEqual(result, { ok: true, path: "/Users/foo/repo" })
})

test("parseUserPath trims whitespace before parsing", () => {
  const result = parseUserPath("  /Users/foo/repo  ")
  assert.deepEqual(result, { ok: true, path: "/Users/foo/repo" })
})

test("parseUserPath expands ~/ to the user home directory", () => {
  const result = parseUserPath("~/myproject")
  assert.deepEqual(result, { ok: true, path: path.join(os.homedir(), "myproject") })
})

test("parseUserPath expands ~/ for nested paths", () => {
  const result = parseUserPath("~/code/myrepo/src")
  assert.deepEqual(result, { ok: true, path: path.join(os.homedir(), "code/myrepo/src") })
})

test("parseUserPath rejects an empty string", () => {
  const result = parseUserPath("")
  assert.equal(result.ok, false)
  assert.match(result.error, /empty/i)
})

test("parseUserPath rejects whitespace-only input", () => {
  const result = parseUserPath("   ")
  assert.equal(result.ok, false)
  assert.match(result.error, /empty/i)
})

test("parseUserPath rejects null/undefined input", () => {
  const result = parseUserPath(null)
  assert.equal(result.ok, false)
  assert.match(result.error, /empty/i)
})

test("parseUserPath rejects per-user tilde (~user/foo)", () => {
  const result = parseUserPath("~alice/repo")
  assert.equal(result.ok, false)
  assert.match(result.error, /per-user tilde/i)
})

test("parseUserPath rejects bare ~", () => {
  const result = parseUserPath("~")
  assert.equal(result.ok, false)
  assert.match(result.error, /per-user tilde/i)
})

test("parseUserPath rejects a relative path", () => {
  const result = parseUserPath("repo/src")
  assert.equal(result.ok, false)
  assert.match(result.error, /relative paths are not supported/i)
})

test("parseUserPath rejects ./relative", () => {
  const result = parseUserPath("./repo")
  assert.equal(result.ok, false)
  assert.match(result.error, /relative paths are not supported/i)
})

test("parseUserPath rejects ../parent", () => {
  const result = parseUserPath("../sibling")
  assert.equal(result.ok, false)
  assert.match(result.error, /relative paths are not supported/i)
})

// ── validateWorkspaceDirectory ──

test("validateWorkspaceDirectory accepts an existing directory", () => {
  // process.cwd() is guaranteed to exist and be a directory in the test runner
  const result = validateWorkspaceDirectory(process.cwd())
  assert.deepEqual(result, { ok: true })
})

test("validateWorkspaceDirectory accepts the user home directory", () => {
  const result = validateWorkspaceDirectory(os.homedir())
  assert.deepEqual(result, { ok: true })
})

test("validateWorkspaceDirectory rejects a non-existent path with ENOENT message", () => {
  const result = validateWorkspaceDirectory("/this/path/definitely/does/not/exist/12345")
  assert.equal(result.ok, false)
  assert.match(result.error, /does not exist/i)
})

test("validateWorkspaceDirectory rejects a file path (not a directory)", () => {
  // Create a real temp file so we test the "exists but not a directory" branch.
  // Use crypto.randomUUID() instead of Date.now() to avoid collisions when
  // multiple test files run concurrently in the same millisecond (Node test
  // runner may parallelize).
  const tmpFile = path.join(os.tmpdir(), `tbridge-validate-${crypto.randomUUID()}.txt`)
  fs.writeFileSync(tmpFile, "test")
  try {
    const result = validateWorkspaceDirectory(tmpFile)
    assert.equal(result.ok, false)
    assert.match(result.error, /not a directory/i)
  } finally {
    fs.rmSync(tmpFile, { force: true })
  }
})

// ── timeAgo ──

test("timeAgo returns 'just now' for less than 60 seconds ago", () => {
  const date = new Date(Date.now() - 30_000)
  assert.equal(timeAgo(date), "just now")
})

test("timeAgo returns minutes for 1–59 minutes ago", () => {
  const date = new Date(Date.now() - 5 * 60_000)
  assert.equal(timeAgo(date), "5m ago")
})

test("timeAgo returns hours for 1–23 hours ago", () => {
  const date = new Date(Date.now() - 3 * 60 * 60_000)
  assert.equal(timeAgo(date), "3h ago")
})

test("timeAgo returns days for 24+ hours ago", () => {
  const date = new Date(Date.now() - 2 * 24 * 60 * 60_000)
  assert.equal(timeAgo(date), "2d ago")
})

test("timeAgo returns '1m ago' for exactly 61 seconds ago", () => {
  const date = new Date(Date.now() - 61_000)
  assert.equal(timeAgo(date), "1m ago")
})

// ── compactPath ──

test("compactPath returns '?' for null input", () => {
  assert.equal(compactPath(null), "?")
})

test("compactPath returns '?' for the /unknown sentinel", () => {
  assert.equal(compactPath("/unknown"), "?")
})

test("compactPath returns '~' for the home directory", () => {
  assert.equal(compactPath(os.homedir()), "~")
})

test("compactPath returns basename for a path directly under home", () => {
  const p = path.join(os.homedir(), "myproject")
  assert.equal(compactPath(p), "myproject")
})

test("compactPath includes parent context for a deeply nested home path", () => {
  const p = path.join(os.homedir(), "work", "client", "project")
  const result = compactPath(p)
  assert.ok(result.startsWith("project"), "should start with the leaf directory name")
  assert.ok(result.includes("~/work/client"), "should include the parent path for context")
})

test("compactPath returns the basename for an absolute non-home path", () => {
  assert.equal(compactPath("/var/log/myapp"), "myapp")
})

// ── formatSessionLine ──

test("formatSessionLine formats a session with a title and recent activity", () => {
  const session = {
    cli: "kilo",
    session_id: "abc123defghi",
    workspace: path.join(os.homedir(), "project"),
    title: "My Session Title",
    message_count: 42,
    last_activity: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  }
  const result = formatSessionLine(session)
  assert.ok(result.includes("[kilo]"), "should include CLI name in brackets")
  assert.ok(result.includes("My Session Title"), "should include the session title")
  assert.ok(result.includes("42 msgs"), "should include the message count")
  assert.ok(result.includes("3h ago"), "should include a human-readable age")
})

test("formatSessionLine uses the first 12 chars of session_id when title is absent", () => {
  const session = {
    cli: "claude",
    session_id: "abcdef1234567890",
    workspace: "/projects/app",
    title: null,
    message_count: 0,
    last_activity: null,
  }
  const result = formatSessionLine(session)
  assert.ok(result.includes("abcdef123456"), "should include first 12 chars of session_id")
  assert.ok(result.includes("0 msgs"), "should show zero messages")
  assert.ok(result.includes("?"), "should show '?' for unknown activity time")
})

// ── resolveSessionLabel ──

test("resolveSessionLabel returns display_name when present in DB", () => {
  mockDb.sessionsById["codex:sess-abc-123"] = {
    cli: "codex",
    session_id: "sess-abc-123",
    display_name: "My Codex Project",
    title: "other title",
  }
  try {
    const result = resolveSessionLabel({ cli: "codex", session_id: "sess-abc-123" })
    assert.equal(result, "My Codex Project")
  } finally {
    delete mockDb.sessionsById["codex:sess-abc-123"]
  }
})

test("resolveSessionLabel falls back to title when display_name is absent", () => {
  mockDb.sessionsById["codex:sess-abc-456"] = {
    cli: "codex",
    session_id: "sess-abc-456",
    display_name: null,
    title: "My Readable Title",
  }
  try {
    const result = resolveSessionLabel({ cli: "codex", session_id: "sess-abc-456" })
    assert.equal(result, "My Readable Title")
  } finally {
    delete mockDb.sessionsById["codex:sess-abc-456"]
  }
})

test("resolveSessionLabel falls back to truncated session_id when neither display_name nor title is present", () => {
  mockDb.sessionsById["codex:sess-abc-789"] = {
    cli: "codex",
    session_id: "sess-abc-789-xxxlong",
    display_name: null,
    title: null,
  }
  try {
    const result = resolveSessionLabel({ cli: "codex", session_id: "sess-abc-789-xxxlong" })
    assert.equal(result, "sess-abc-789")
  } finally {
    delete mockDb.sessionsById["codex:sess-abc-789"]
  }
})

test("resolveSessionLabel falls back to truncated session_id when session is not in DB", () => {
  // No entry in sessionsById → getCliSessionById returns null
  const result = resolveSessionLabel({ cli: "codex", session_id: "notindb-xyz-longid" })
  assert.equal(result, "notindb-xyz-")
})

test("resolveSessionLabel returns 'unknown' when binding is null", () => {
  assert.equal(resolveSessionLabel(null), "unknown")
})

test("resolveSessionLabel returns 'unknown' when binding has no session_id", () => {
  assert.equal(resolveSessionLabel({ cli: "codex" }), "unknown")
})
