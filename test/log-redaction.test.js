import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Point log output at a private temp directory so tests are self-contained.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-redaction-test-"))
const logDbFile = path.join(tmpDir, "events.db")
const logFile = path.join(tmpDir, "bridge.ndjson")

process.env.LOG_DB_PATH = logDbFile
process.env.LOG_FILE_PATH = logFile
process.env.LOG_RETENTION_DAYS = "7"

process.on("exit", () => {
  try { fs.rmSync(tmpDir, { recursive: true }) } catch {}
})

const { redactString } = await import("../src/log.js")
const { persistLogEvent, flushLogStore, getLogDb, closeLogStore } =
  await import("../src/log-store.js")

// ── Bearer token ──

test("redactString redacts Authorization: Bearer header (plain text)", () => {
  const result = redactString("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
  assert.equal(result, "Authorization: Bearer <REDACTED>")
})

test("redactString redacts Authorization: Bearer header (JSON string)", () => {
  const result = redactString('"Authorization":"Bearer someOpaqueToken12345"')
  assert.equal(result, '"Authorization":"Bearer <REDACTED>"')
})

test("redactString Bearer redaction is case-insensitive", () => {
  // The regex uses /gi so it matches regardless of case; the replacement string
  // is the literal "Authorization: Bearer <REDACTED>" (always Title-case).
  const result = redactString("authorization: bearer mytoken12345abcdef")
  assert.equal(result, "Authorization: Bearer <REDACTED>")
})

// ── JWT ──

test("redactString redacts a standalone JWT token", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0" +
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  const result = redactString(`token=${jwt}`)
  assert.equal(result, "token=<REDACTED_JWT>")
  assert.ok(!result.includes("eyJ"), "original JWT header must not survive")
})

test("redactString redacts JWT embedded in Bearer header", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" +
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  const result = redactString(`Authorization: Bearer ${jwt}`)
  // The Bearer pattern fires first, so the result is the Bearer redaction
  assert.ok(!result.includes("eyJ"), "JWT header must not survive")
  assert.ok(result.includes("<REDACTED>"), "some redaction marker must appear")
})

// ── github_pat_ (fine-grained PAT) ──

test("redactString redacts github_pat_ fine-grained PAT", () => {
  const pat = "github_pat_" + "A".repeat(70)
  const result = redactString(`token=${pat}`)
  assert.equal(result, "token=github_pat_<REDACTED>")
  assert.ok(!result.includes("A".repeat(70)), "token body must not survive")
})

// ── Stripe ──

test("redactString redacts Stripe sk_live_ key", () => {
  const key = "sk_live_" + "a".repeat(24)
  const result = redactString(`key=${key}`)
  assert.equal(result, "key=sk_live_<REDACTED>")
})

test("redactString redacts Stripe pk_test_ key", () => {
  const key = "pk_test_" + "b".repeat(24)
  const result = redactString(`key=${key}`)
  assert.equal(result, "key=pk_test_<REDACTED>")
})

test("redactString redacts Stripe rk_live_ key", () => {
  const key = "rk_live_" + "c".repeat(24)
  const result = redactString(`key=${key}`)
  assert.equal(result, "key=rk_live_<REDACTED>")
})

// ── Slack ──

test("redactString redacts Slack bot token (xoxb-)", () => {
  const token = "xoxb-123456789012-123456789012-abcdefghij"
  const result = redactString(`slack_token=${token}`)
  assert.equal(result, "slack_token=xox_<REDACTED>")
})

test("redactString redacts Slack user token (xoxp-)", () => {
  const token = "xoxp-123456789012-123456789012-abcdefghij"
  const result = redactString(`slack_token=${token}`)
  assert.equal(result, "slack_token=xox_<REDACTED>")
})

// ── AWS access key ID ──

test("redactString redacts AWS access key ID", () => {
  const key = "AKIAIOSFODNN7EXAMPLE"
  const result = redactString(`aws_access_key_id=${key}`)
  assert.equal(result, "aws_access_key_id=<REDACTED>")
  assert.ok(!result.includes("AKIA"), "key prefix must not survive")
  assert.ok(!result.includes("IOSFODNN7EXAMPLE"), "key suffix must not survive")
})

// ── Credentials in URL ──

test("redactString redacts credentials embedded in https:// URL", () => {
  const result = redactString("https://admin:s3cr3tPassw0rd@example.com/api")
  assert.equal(result, "https://<REDACTED>:<REDACTED>@example.com/api")
})

test("redactString redacts credentials embedded in http:// URL", () => {
  const result = redactString("http://user:hunter2@internal.example.org/path")
  assert.equal(result, "http://<REDACTED>:<REDACTED>@internal.example.org/path")
})

// ── Idempotency: <REDACTED> markers are not double-redacted ──

test("redactString is idempotent — running twice produces the same result", () => {
  const input = "Authorization: Bearer someOpaqueToken12345"
  const once = redactString(input)
  const twice = redactString(once)
  assert.equal(once, twice)
})

// ── Existing patterns still work ──

test("redactString still redacts ghp_ GitHub tokens", () => {
  const token = "ghp_" + "A".repeat(36)
  const result = redactString(`token=${token}`)
  // Unified pattern: all gh[pusro]_ variants map to the same placeholder
  assert.equal(result, "token=gh_<REDACTED>")
})

test("redactString still redacts ghu_ GitHub tokens", () => {
  const token = "ghu_" + "B".repeat(36)
  const result = redactString(`token=${token}`)
  assert.equal(result, "token=gh_<REDACTED>")
})

test("redactString redacts ghs_/ghr_/gho_ GitHub server/refresh/oauth tokens", () => {
  // Defense-in-depth: the unified pattern covers the full gh[pusro]_ family
  const ghs = "ghs_" + "C".repeat(36)
  const ghr = "ghr_" + "D".repeat(36)
  const gho = "gho_" + "E".repeat(36)
  assert.equal(redactString(`token=${ghs}`), "token=gh_<REDACTED>")
  assert.equal(redactString(`token=${ghr}`), "token=gh_<REDACTED>")
  assert.equal(redactString(`token=${gho}`), "token=gh_<REDACTED>")
})

test("redactString redacts modern Anthropic and OpenAI project keys", () => {
  // Regression guard: the legacy `sk-[A-Za-z0-9]{20,}` pattern failed on
  // dash-separated modern keys (sk-ant-api03-..., sk-proj-...). Unified
  // with dedicated patterns before falling back to the legacy one.
  const anthKey = "sk-ant-api03-" + "A".repeat(40)
  const openaiProj = "sk-proj-" + "B".repeat(40)
  const openaiSvc = "sk-svcacct-" + "C".repeat(40)
  assert.equal(redactString(`key=${anthKey}`), "key=sk-ant-<REDACTED>")
  assert.equal(redactString(`key=${openaiProj}`), "key=sk-<REDACTED>")
  assert.equal(redactString(`key=${openaiSvc}`), "key=sk-<REDACTED>")
})

test("redactString redacts GitLab, HuggingFace, Supabase tokens", () => {
  assert.equal(redactString("token=glpat-" + "A".repeat(20)), "token=glpat-<REDACTED>")
  assert.equal(redactString("token=hf_" + "B".repeat(30)), "token=hf_<REDACTED>")
  assert.equal(redactString("token=sbp_" + "C".repeat(30)), "token=sb_<REDACTED>")
  assert.equal(redactString("token=sbs_" + "D".repeat(30)), "token=sb_<REDACTED>")
})

test("redactString redacts bare Bearer tokens without Authorization header", () => {
  // Defense in depth: error messages may quote the token without the prefix
  const result = redactString("error: Bearer abcdefghij1234567890ABCDEF")
  assert.equal(result, "error: Bearer <REDACTED>")
})

test("redactString redacts GCP service account private_key JSON", () => {
  const input = 'config: {"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIE..."}'
  const result = redactString(input)
  assert.equal(result, 'config: {"private_key":"<REDACTED>"}')
})

test("redactString still redacts AIzaSy Google API keys", () => {
  const key = "AIzaSy" + "x".repeat(33)
  const result = redactString(`key=${key}`)
  assert.equal(result, "key=<REDACTED>")
})

// ── Integration: persistLogEvent stores bearer token as redacted ──

test("persistLogEvent stores bearer token in error field as redacted", () => {
  const bearerToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.sig123abcdefghij"
  const rawError = `upstream API call failed: Authorization: Bearer ${bearerToken}`

  // The log.emit path sanitizes via sanitize() which calls redactString().
  // Here we verify the store layer directly by persisting a pre-sanitized entry
  // (mirroring what log.emit does) and confirming the token is absent.
  const sanitized = redactString(rawError)
  persistLogEvent({
    ts: new Date().toISOString(),
    level: "error",
    scope: "test.integration",
    event: "bearer.redaction",
    message: sanitized,
  })
  flushLogStore()

  const row = getLogDb()
    .prepare("SELECT * FROM log_events WHERE event = 'bearer.redaction' LIMIT 1")
    .get()
  assert.ok(row, "event row should exist in DB")
  assert.ok(!row.message.includes(bearerToken), "raw bearer token must not appear in stored message")
  assert.ok(row.message.includes("<REDACTED>"), "redaction marker must appear in stored message")
  closeLogStore()
})
