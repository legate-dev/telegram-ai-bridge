# Operations — Telegram Bridge

## Invariants

### Runtime

- The bridge spawns `kilo serve` on startup via a login shell (`KILO_SERVE_SHELL`, default `$SHELL`) and shuts it down on SIGINT/SIGTERM; if `KILO_SERVE_URL` is explicitly set in env, the bridge connects to that URL instead (legacy external mode)
- The bridge is single-user only; any Telegram user ID mismatch must be rejected before command handling
- The bridge never passes Telegram bot secrets or Kilo server credentials to spawned CLI subprocesses
- Kilo preflight calls must fail fast; status and abort requests cannot block indefinitely
- At most one in-flight chat turn is allowed per Telegram chat
- Logging must be structured and timestamped; warnings/errors must be queryable after restart

### State

- `sessions.db` stores discovery and chat binding state only
- `LOG_DB_PATH` stores operational event history only
- Bridge-created Kilo sessions are never deleted implicitly; destructive cleanup is manual via `/cleanup`
- Bridge ownership is declarative: only sessions with `cli_sessions.source = 'bridge'` (set by `createNewSession`) are eligible for `/cleanup`. Sessions with `source IS NULL` (pre-migration / externally-created) are intentionally invisible to all destructive paths
- For Kilo only, `cli_sessions.message_count` represents the exact number of user turns (rows where `role='user'` in the Kilo `message` table), not the inflated raw row count
- Every `ALTER TABLE ADD COLUMN` migration in `src/db.js` must also appear in the corresponding canonical `CREATE TABLE` block. Locked by `test/db-schema-invariant.test.js` (regression-test, runs in `npm test`)
- `scanKilo` wraps the entire db-touching path (rows query + countStmt prepare + per-row cache lookup loop + sessions push) in a single inner `try/catch`. Any SQLite failure anywhere in that path degrades to `{sessions: [], ok: false}` instead of bubbling up through `refreshKiloMirror` / `scanAll`
- `scanKilo` per-row `message_count` is cached via `cli_sessions.kilo_messages_seen_at = session.time_updated`. Cache hit reuses `cached.message_count`; cache miss recomputes via prepared `countStmt` filtering `role='user'`. The cache is correctness-preserving: any mismatch on `time_updated` triggers a recompute
- `scanClaude` shares a single `readdirCache = new Map()` across all `decodeClaudeFolder` calls within a single scan invocation, then discards it. The cache is intentionally never shared across scan invocations to avoid stale data between ticks
- Every new symbol added to `src/cli-scanner.js` imports from `./db.js` must also be added to the `mock.module("../src/db.js", ...)` namedExports of every test file that imports `cli-scanner` in isolation (currently `test/decode-claude-folder.test.js`). Failure to do so produces `SyntaxError: does not provide an export named ...` only at merge-time, not at branch CI time

### Kilo permission flow (added 2026-04-08 with PR #131)

- The bridge mediates Kilo's runtime permission engine via `GET /permission` (poll) and `POST /permission/:id/reply` (reply with `once | always | reject`). `GET /permission` returns the **server-wide** queue for the whole project; `_checkForPendingPermission(sessionId)` MUST filter by `req.sessionID === sessionId` before returning a match. Any unfiltered consumer would cross-react to permission requests belonging to other sessions
- The callback handler for `perm:` buttons MUST call `inFlightChats.add(chatKey)` **before** `deletePendingPermission(chatKey)` so there is never a window where both guards are absent simultaneously. This is the no-window lock pattern; inverting the order opens a race where a concurrent Telegram message could start a new turn against the paused backend state
- `pendingPermissions` entries MUST have a TTL (`BRIDGE_PENDING_PERMISSION_TTL_MS`) as defense in depth — the `replying` flag handles active concurrency, but the TTL catches the case where the user never responds
- Callback reply data is untrusted — `reply` value MUST be validated against the explicit set `{once, always, deny}` before forwarding to Kilo; invalid values return an "Invalid action" alert
- Double-tap concurrency is blocked via `pending.replying` boolean flag, scoped to the pending entry (not the global `inFlightChats` set), so the lock does not interfere with normal in-flight tracking. The flag is cleared on POST failure so the user can retry
- Telegram callback queries MUST be answered *before* the network POST to Kilo, not after — Telegram enforces a ~10 s deadline to respond to callback queries or the button spins
- `deletePendingPermission` is called only **after** a successful `replyToPermission` POST, so if the POST fails the pending entry survives and the user can retry by tapping the button again
- The slash-command middleware (`bot.on("text", ...)` with `startsWith("/")` check in `index.js`) MUST call `clearPendingPermission(chatKey)` in addition to `clearMessageBuffer(chatKey)` so that `/abort` and `/detach` clear any stale pending permission before the `hasPendingPermission` guard blocks new turns
- `resumeTurn` after a permission reply can itself return `{ permission }` (nested permission chain) or `{ question }` (mid-resume `mcp_question`) — the callback handler MUST handle both via recursive `surfacePermission` or normal `surfaceQuestion`; silently ignoring either leaves the session stuck

### Rate limiting (updated 2026-04-08 with PR #134)

- `rateLimitMiddleware` is registered **after** auth and **before** `setupCommands`/`setupHandlers`. Plain text messages bypass the middleware entirely and are rate-limited inside `processTextMessage()` after fragment coalescing, so one logical turn (possibly split by Telegram into N 4096-char fragments and ricucito dal `messageBuffer`) counts as **one** slot, not N
- Commands and callback queries remain rate-limited per-update (each slash command = 1 slot, each button tap = 1 slot)
- The authoritative way to distinguish bot commands from plain text is Telegram's **`bot_command` entity at offset 0** (`entities.some((e) => e.type === "bot_command" && e.offset === 0)`), NOT `text.startsWith("/")`. Using the string prefix check would misclassify Unix paths like `/Users/foo/repo` as commands and apply per-update rate limiting unexpectedly. Same pattern used in `src/message-handler.js:600-601`

### LM Studio backend (added 2026-04-12 with PRs #41–#47)

- LM Studio stores conversation history entirely server-side. The bridge stores only an opaque `response_id` per session (`lmstudio_response_ids` table, one row per session). **No message content is ever persisted in the bridge DB** — this is the core privacy guarantee. Do not add content fields to this table
- Thread continuity is achieved via `previous_response_id` in the POST body. A missing or stale `response_id` (e.g. after DB reset) starts a fresh conversation — there is no history replay fallback and none is desired
- SSE stream events are parsed **by block** (`parseSseEventBlock`), not line by line. A block is delimited by `\n\n`. Do not revert to line-based parsing: multi-line `data:` payloads and arbitrary TCP chunk boundaries require the block model to be correct
- For LM Studio, model callback slugs whose `slug.length` exceeds 54 characters (`MAX_CALLBACK_SLUG`) are encoded as `#<index>:<sha256[:8]>`. The fingerprint is the first 8 hex chars of the SHA-256 of the full slug. `resolveIndexedModelSlug` returns `{ ok, reason, slug }` with four possible failure reasons: `"invalid_token"` (token doesn't match the expected pattern or has a malformed fingerprint length), `"unavailable"` (model list could not be fetched), `"index_out_of_range"` (index is valid but no model at that position), `"fingerprint_mismatch"` (fingerprint is present but doesn't match the current slug). The handler in `message-handler.js` explicitly differentiates only `"invalid_token"` and `"unavailable"`; `"index_out_of_range"` and `"fingerprint_mismatch"` both fall back to the generic "Model list changed" alert. **Legacy `#<index>` tokens (no fingerprint, from before PR #46) are still accepted** for backward compatibility — `INDEXED_MODEL_TOKEN_RE = /^#(\d+)(?::([0-9a-f]+))?$/`
- `encodeModelCallbackSlug` only applies the index/fingerprint scheme when `cliName === "lmstudio"` AND `slug.length > MAX_CALLBACK_SLUG`. All other CLIs pass the raw slug through

### Error logging redaction (added 2026-04-08 with PR #131 01a57f7)

- `String(err)` passed to `log.error` in permission-related error paths (`permission_resume_failed`, `permission_reply_failed`) MUST be wrapped in `redactString()` — raw error messages from fetch/HTTP can contain full URLs including Kilo session IDs and should not land in persisted logs
- `err.message` / `resumeErr.message` passed to user-facing `ctx.reply()` in catch blocks MUST be wrapped in `redactString()` — consistent with the rest of the codebase's user-facing redaction policy
- Permission poll logs MUST use `pattern_count` (the numeric count) instead of `patterns` (the raw array) at `info` level — patterns can contain sensitive command strings or file globs that should not be persisted at info level. Use `Array.isArray(patterns) ? patterns.length : 0` to be safe against unexpected shapes

### Observability

- `LOG_FILE_PATH` is the primary live tail surface
- `LOG_DB_PATH` is the primary historical debugging surface
- Backend exceptions must leave a persisted error event
- `persist: true` is reserved for low-frequency diagnostic events, never for heartbeat-style noise
- **`binding.thread_update_skipped`** — Emitted when a long-running turn returned a new threadId but the user changed their binding during the turn. Indicates a successful race condition mitigation. Non-zero rate is informational, not a problem.

## Active Debt

### P1 — Copilot Agent PRs require `--admin` bypass for merge

- **Trigger:** `main` branch ruleset enforces `REVIEW_REQUIRED`. Copilot Agent PRs cannot self-approve. Every Copilot PR currently needs `gh pr merge --admin` after manual merge-simulate validation
- **Blast radius:** Operator overhead (admin clicks per merge), risk of bypassing the rule for non-Copilot PRs by habit, dependency on the operator being a repo admin
- **Fix:** One of (a) ruleset bypass list for `copilot-swe-agent` account, (b) CI job that runs merge-simulate on PR creation and posts an approving review on success, (c) auto-rebase via ruleset to keep Copilot branches always-current
- **Done when:** Copilot PRs merge through the same path as human PRs without `--admin`

### P2 — KiloClient.sendMessage() kept as deprecated fallback

- **Trigger:** Contributor confusion — method exists but is unused in production
- **Blast radius:** No runtime impact; marked `@deprecated` with JSDoc
- **Fix:** Remove entirely when async path is proven stable for 30+ days
- **Done when:** Method removed or explicitly documented as rollback-only

### P2 — Mock drift in `test/decode-claude-folder.test.js` is a recurring class

- **Trigger:** Every new symbol added to `src/cli-scanner.js` imports from `./db.js` requires updating the mock namedExports in `test/decode-claude-folder.test.js`. Already happened twice in 2026-04-06 (once for `reconcileCliSessions`, once for `getCliSessionById`). Branch-level CI passes but post-merge CI fails with `SyntaxError`
- **Blast radius:** Caught only by merge-simulate; if merge-simulate is skipped, the bug lands and breaks `npm test` on main
- **Fix:** One of (a) export a `__symbols` registry from `src/db.js` and reference it from test mocks so additions are automatic, (b) CI job that parses `cli-scanner.js` imports and cross-checks against every test mock, (c) inline doc enforcing the dependency at the top of `test/decode-claude-folder.test.js`
- **Done when:** Mock drift cannot land silently — either auto-mocked or CI-checked

### P3 — `parseCreateTableCols` parser does not handle multi-line column definitions

- **Trigger:** From PR #61 review (Supabase finding `3bda61bd-6bcb-44f8-b6bd-6f74c462943f`). If a developer formats a column definition across multiple lines (e.g. `source\n  TEXT DEFAULT NULL,`), the schema invariant test parser reads `DEFAULT` as a column name and either misses the drift or produces a confusing error
- **Blast radius:** Test passes when it should fail (silent), or fails with a misleading message. Currently theoretical: all `src/db.js` columns are single-line
- **Fix:** Either (a) handle line continuations in `parseCreateTableCols`, or (b) add an enforcing comment at the top of `CREATE TABLE` blocks documenting the single-line invariant
- **Done when:** Multi-line column definition either parses correctly or fails with an actionable error

### P3 — `process.on('exit')` async cleanup of tmpdir in schema invariant test

- **Trigger:** From PR #61 review (Supabase finding `9a27aabe-9e13-4f91-99e5-367d0ce283ed`). The test uses `fs.rm` (async) inside `process.on('exit')` which is sync — the rm Promise is never awaited and the tmpdir leaks until reboot
- **Blast radius:** Cosmetic only — accumulating tmpdirs under `$TMPDIR/tbridge-schema-*` over many test runs
- **Fix:** Use `fs.rmSync` in the exit handler, or move cleanup to `node:test` `t.after()` hook
- **Done when:** Tmpdir never leaks across invocations

### P3 — `readdirCache` test verifies correctness but not effectiveness

- **Trigger:** From PR #68 review (Supabase finding `4da34c2c-f433-4a02-824f-d4cbe6289fc7`). The N=5 shared-prefix workspaces test asserts the cache does not corrupt results, but does not verify that the cache is actually hit. The test would pass even if the cache were bypassed completely
- **Blast radius:** Performance regression could land silently; correctness is still tested
- **Fix:** Add a test that mocks `fsp.readdir` with a counter and asserts `scanClaude` with N shared-prefix workspaces calls `readdir` fewer than `2*N` times
- **Done when:** Cache effectiveness is regression-locked, not just correctness

### P3 — Bootstrap mode bypasses the rate-limit middleware

- **Trigger:** From the pre-public tripartite (Sonnet R2, `review/pre-public-v031-security-auth-sonnet.md`). The auth middleware in `src/index.js:33-54` replies with the user's Telegram ID and returns *without* calling `next()` when `TELEGRAM_ALLOWED_USER_ID` is unset — short-circuiting the rate-limit middleware that is registered after it. Any Telegram user can flood outbound `sendMessage` calls during the (brief) bootstrap window
- **Blast radius:** Resource exhaustion / Telegram API quota pressure during first-run setup only. No privilege escalation, no auth bypass. The bootstrap window is seconds-to-minutes before the operator sets `TELEGRAM_ALLOWED_USER_ID` and restarts
- **Fix:** Either (a) apply a minimal per-`ctx.from.id` rate limit inside the bootstrap branch (1 reply per 10s), (b) swap the middleware order and have the rate-limiter run before auth (costs one bucket slot per unauthorized request instead of zero, but closes the gap cleanly), or (c) document the window length and tell users to set `TELEGRAM_ALLOWED_USER_ID` before exposing the bot to Telegram for real
- **Done when:** Bootstrap mode cannot be used as an amplification vector against Telegram's API

### P3 — CLI argument spoofing via leading hyphen in user prompt

- **Trigger:** From the pre-public tripartite (Gemini R1, `review/pre-public-v031-security-input-gemini.md`). The vulnerable surface is backends that append the user's prompt as a bare positional argument to `execFile` without a `--` terminator. In the current implementation, **Codex** is the affected case (prompt appended as the last positional arg). Copilot and Gemini pass the prompt as the value to `-p`, and Claude delivers the prompt via stdin (stream-json) — none of those three are described by this issue. A prompt like `--help` or `--version` sent to a Codex session will be parsed by the CLI as a flag instead of prompt payload
- **Blast radius:** Functional only — the user is already authenticated; they can already ask the AI to do anything. The worst case is the bridge returning raw CLI `--help` output and failing JSON parsing, surfacing a confusing "parser failure" error instead of an AI turn. No privilege escalation, no injection beyond what the user already has
- **Fix:** Append `--` before the positional `text` argument in each backend's `args` array. Verify each CLI's argument parser supports `--` as an end-of-options terminator (most GNU-style parsers do; exotic CLIs may need a workaround)
- **Done when:** Sending `--help` as a Telegram message to a bound session returns an AI turn, not a CLI help dump

## Resolved Debt (2026-04-08) — v0.3.0 Health Check Wave 1

Eight PRs merged across a single session closed the full post-v0.3.0 health check Wave 1, including all three Blockers from the tripartite review:

- ~~**Blocker 1** — `kilo serve` binds implicitly to 0.0.0.0 when port is set~~ → PR #127 (explicit `--host 127.0.0.1` passed on spawn)
- ~~**Blocker 2** — Kilo policy/sandbox gap trio: `kilo-client.js:527` question-only filter, `format.js` tool-result drop, `lastSuccessfulPollAt` reset~~ → PR #131 (full Kilo `/permission` HTTP round-trip: poll → surface → reply → resume; 20 tests in `test/kilo-permission.test.js`)
- ~~**Blocker 3** — `pendingCustomPath` Map has no TTL~~ → PR #128 (`setPendingCustomPath` / `deletePendingCustomPath` / `hasPendingCustomPath` helpers, `BRIDGE_PENDING_PATH_TTL_MS` env var, identity-guard timer, test coverage in `test/pending-custom-path.test.js`)
- ~~**R1** — `execFile` `error.message` leaked in timeout/kill error strings across all 5 exec backends (command line + args including user prompt → persisted logs)~~ → PR #125 (4 Copilot reviewer suggestions applied via `gh` CLI pipeline on Codex/Copilot/Gemini/Claude backends) + PR #132 (Gemini generic-failure residual branch missed by reviewer in first pass)
- ~~**R3** — rate-limit check only applied to Kilo-bound text, not commands/callbacks → blast-radius gap against token compromise~~ → PR #129 (`src/rate-limit-middleware.js` global grammY middleware registered after auth, before command/handler setup)
- ~~**R5** — `messageBuffer` debounce could fire and flush stale fragments after a slash command against an already-changed binding~~ → PR #126 (`clearMessageBuffer(chatKey)` exported + slash-command middleware)
- ~~rate-limit counted fragments as separate turns → multi-fragment messages bled slots unfairly~~ → PR #134 (plain text bypass at middleware level, rate-limit moved inside `processTextMessage` after coalescing, `bot_command` entity at offset 0 as authoritative classifier)

## Resolved Debt (2026-04-07)

- ~~P2 — `pendingCustomPath` Map has no TTL~~ → this PR (`setPendingCustomPath` / `deletePendingCustomPath` / `hasPendingCustomPath` helpers, `BRIDGE_PENDING_PATH_TTL_MS` env var, identity-guard timer, test coverage in `test/pending-custom-path.test.js`)
- ~~P2 — `pendingCustomPath` flow has no path-existence validation~~ → PR #108 (`validateWorkspaceDirectory` + `parseUserPath` strict parser, fs check via `fs.statSync`, user-facing reject message with retry guidance)

## Resolved Debt (2026-04-06)

All items below were resolved during the `/cleanup` overhaul (PR #59) and the post-#59 Copilot Agent cascade (PRs #61, #66, #67, #68, #71):

- ~~P1 — `/cleanup` heuristic ownership via title pattern~~ → PR #59 (declarative `source` column)
- ~~P1 — `message_count` inflated by ~12× for Kilo~~ → PR #59 (`json_extract role='user'` filter)
- ~~P1 — Implicit destructive cleanup on startup and `/new`~~ → PR #59 (explicit-only, two-phase preview/confirm)
- ~~P1 — `/cleanup confirm` could operate on stale mirror after `scanAll` swallowed per-CLI failures~~ → PR #59 commit `12658d7` (`refreshKiloMirror` extracted, fail-closed semantics)
- ~~P1 — `cli_sessions` schema drift (CREATE vs ALTER) had no guard~~ → PR #61 (regression test)
- ~~P2 — `decodeClaudeFolder` greedy algorithm had no test coverage~~ → PR #66 (5 focused tests using real dirs under `$HOME`)
- ~~P2 — `JOIN_CHARS` priority undocumented and unlocked~~ → PR #67 (comment block + regression test)
- ~~P2 — `decodeClaudeFolder` redundant `readdir` on shared path ancestors~~ → PR #68 (per-scan cache)
- ~~P2 — `scanKilo` re-runs `json_extract` user count on every tick~~ → PR #71 (cache via `kilo_messages_seen_at` timestamp invalidation)
- ~~P2 — CI pipeline not yet configured~~ → CI workflow active (`test (22)` job runs on push and PR), `setup-node@v6` + `better-sqlite3@12.8.0` post-#44/#46
- ~~P2 — Branch protection not enforced~~ → `main` has a modern ruleset requiring `REVIEW_REQUIRED`. New debt P1 (Copilot bypass) tracked above

## Resolved Debt (2026-04-05)

All items below were resolved during the initial hardening session and Copilot agent batch:

- ~~P1 — Exec backend structured logging~~ → PR #12
- ~~P1 — NDJSON log rotation~~ → PR #22
- ~~P1 — Error messages leak unredacted~~ → commit 3ce7eed
- ~~P1 — 8s latency floor~~ → PR #4
- ~~P1 — replyChunks plain text fallback~~ → PR #28
- ~~P1 — redact() incomplete~~ → commit 3ce7eed
- ~~P2 — Synchronous I/O~~ → PR #30
- ~~P2 — Gemini session_id capture~~ → PR #8
- ~~P2 — Per-backend timeouts~~ → PR #26
- ~~P2 — Agent selection non-Kilo~~ → PR #32 + commit 768e43b
- ~~P2 — Dead code cleanup~~ → PR #10
- ~~P2 — Zero automated tests~~ → PR #24 (53 tests)

## Pre-Launch Checklist

- Verify `.env` contains absolute CLI binary paths for launchd deployments
- Tail `LOG_FILE_PATH` during one real end-to-end message for each enabled backend
- Query the SQLite event store after a forced error to confirm persisted warnings/errors are recorded
- Confirm `KILO_STATUS_TIMEOUT_MS` and `KILO_ABORT_TIMEOUT_MS` are short enough to fail fast on remote/mobile use
- Run one startup cycle and confirm Kilo auto-spawns on port 4097, history is preserved while stale local DB rows are reconciled away
- **Before first public release**: verify the `main` branch ruleset allows pushing tags (`refs/tags/*`). Test with a throwaway tag before relying on `release.yml` — the ruleset that blocks direct push to `refs/heads/main` may also block tag pushes depending on configuration

## Error Taxonomy

| Class | Example | User-facing behavior | Operator surface |
|------|---------|----------------------|------------------|
| Auth | Unauthorized Telegram user | Reject request | NDJSON + persisted warn/error |
| Transport | `ECONNREFUSED`, timeout | Explain backend unavailable | NDJSON + persisted error |
| Parser | CLI exits without a `result` event | Structured error surfaced to user | Persisted warning event |
| Session state | Kilo busy/stuck | Abort or advise `/new` | Persisted warning event |
| Formatting | Telegram Markdown parse failure | Plain-text fallback | NDJSON warning |
