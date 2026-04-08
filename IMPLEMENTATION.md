# IMPLEMENTATION — Telegram Bridge

## Phase 0: Validate Kilo Serve API [✅]

Validated `kilo serve` HTTP API via source analysis and curl testing. Mode B (`kilo run`) dropped — Mode A only.

### Step 0.1: Kilo headless validation [✅]

**Gate:** HTTP API proven: session CRUD, message send/receive, structured JSON response.

- [x] `kilo serve` running (VS Code extension starts it automatically, port is random)
- [x] HTTP API validated: `POST /session`, `POST /session/:id/message`, `GET /session/:id/message`
- [x] Session resume works via `GET /session/:id`
- [x] MCP tools available in headless sessions
- [x] Full API mapped from source (Kilo CLI is open source: `kilo-org/kilocode`)
- [x] Auth: Basic Auth with `KILO_SERVER_PASSWORD` env var, username `kilo`
- [x] `kilo run` dropped — internal server bootstrap fails when other instances running

## Phase 1: Minimal Bridge [✅]

Send message from Telegram, get response from Kilo in Telegram.

### Step 1.1: Bot setup + auth [✅]

**Gate:** Bot responds to allowed user, rejects others.

- [x] BotFather setup completed, token stored in local `.env`
- [x] grammY bot with long polling implemented
- [x] Single-user auth middleware implemented
- [x] Bootstrap mode implemented when `TELEGRAM_ALLOWED_USER_ID` is blank
- [x] Real Telegram round-trip verified end-to-end

### Step 1.2: Kilo routing [✅]

**Gate:** Plain text in Telegram → Kilo response → formatted reply in Telegram.

- [x] `/new` command — create Kilo session, bind to chat
- [x] `/agents` and `/agent` commands — select preferred primary agent per chat
- [x] Kilo HTTP client (create session, send message, parse response)
- [x] Plain text routing: Telegram → Kilo HTTP API → Telegram
- [x] Response JSON parsing (extract text parts from `parts` array)
- [x] Telegram-safe output formatting and chunking
- [x] Retry/rate-limit status surfaced clearly instead of empty replies
- [x] Fallback agent suggestions surfaced when current agent is rate-limited
- [x] ECONNREFUSED handling with clear "backend offline" message
- [x] Production path verified: real message round-trip with assistant response

## Phase 2: Session Discovery [✅]

Browse and bind sessions from any CLI — self-contained, no external DB dependency.

### Step 2.1: Local CLI scanner [✅]

**Gate:** `/sessions` shows recent sessions from all CLIs with inline keyboard picker.

- [x] Local SQLite DB (`sessions.db`) replaces `sessions.json`
- [x] CLI scanner (no enrichment, no PostgreSQL)
- [x] Scans: Claude, Codex, Qwen, Gemini, Kilo (895+ sessions discovered)
- [x] Background file watcher with debounced re-scan
- [x] `/sessions` — last 10 cross-CLI with inline keyboard
- [x] `/sessions <cli>` — filter by CLI
- [x] `/sessions <N>` — custom limit
- [x] `/clis` — list discovered CLIs with session counts
- [x] `/detach` — unbind current session
- [x] Inline keyboard callback binds session on tap
- [x] Non-Kilo sessions show resume command instead of live chat

## Phase 3: Hardening [✅]

Reliability, formatting, deployment automation.

### Step 3.1: Kilo client hardening [✅]

**Gate:** Bridge survives transient errors and produces readable output.

- [x] Dedicated `kilo serve --port 4096` (not VS Code extension sidecar)
- [x] Configurable timeout (`KILO_TIMEOUT_MS`, default 120s)
- [x] Retry with backoff on transient errors (ECONNRESET, 5xx, timeout)
- [x] Configurable retry count (`KILO_RETRIES`, default 2)
- [x] MarkdownV2 formatting preserves code blocks instead of blind-escaping
- [x] Fallback to plain text when MarkdownV2 parsing fails
- [x] Chunking prefers code block boundaries

### Step 3.2: Deployment automation [✅]

**Gate:** `kilo serve` and bridge auto-start on boot.

- [x] launchd plist for `kilo serve --port 4096`
- [x] launchd plist for bridge bot
- [x] `scripts/install-launchd.sh` resolves paths and installs plists

## Phase 3.5: Rate Limiting [✅]

Per-user rate limiting to prevent API cost abuse before public release.

### Step 3.5.1: In-memory rate limiter [✅]

**Gate:** Excessive messages from a single user are rejected with a retry-after hint.

- [x] Sliding window rate limiter keyed by Telegram user ID (`src/rate-limit.js`)
- [x] Configurable via `RATE_LIMIT_MAX` (default 20) and `RATE_LIMIT_WINDOW_MS` (default 60s)
- [x] Applied only to Kilo-bound text messages, not commands
- [x] Periodic cleanup of stale buckets (every 5 min)
- [x] `.env.example` updated with new variables

## Phase 3.6: Variant & Session Naming Fixes [✅]

Fix thinking variant hardcoded to "low" and duplicate session names.

### Step 3.6.1: Variant + session naming [✅]

**Gate:** New sessions have unique names; messages use configured thinking variant.

- [x] `KILO_VARIANT` env var (default "high"), used in `sendMessage`
- [x] Session title includes timestamp: `telegram-{chatId}-{timestamp}`
- [x] `.env.example` updated

## Phase 3.7: Response Streaming Experiment [✅]

Tried SSE status streaming, verified the failure mode, then rolled back to the stable synchronous path.

### Step 3.7.1: SSE status-only approach (rolled back) [✅]

**Gate:** Streaming root cause understood; stable synchronous chat path restored and verified end-to-end.

- [x] SSE status-only implementation was exercised against the real bridge
- [x] Failure mode isolated to the async event path introduced after `4b0a3a0`
- [x] Dead SSE bridge code removed after rollback to avoid future regressions
- [x] Stable `sendMessage` path restored and verified with a real Telegram round-trip

## Phase 3.8: Session Hygiene [✅]

Prevent zombie sessions from blocking the bridge when accessed remotely.

### Step 3.8.1: Abort + manual cleanup [✅]

**Gate:** Stuck session recoverable from Telegram without terminal access, and cleanup never touches sessions the user did not create via the bridge.

- [x] `KiloClient.abortSession()` / `deleteSession()` / `getAllStatuses()`
- [x] `/abort` command — abort current bound session
- [x] `/cleanup` command — preview/confirm two-phase deletion of bridge-owned Kilo sessions
- [x] Cleanup is explicit-only — startup and `/new` do not delete historical Kilo sessions
- [x] Bridge ownership is deterministic via `source='bridge'` column on `cli_sessions`, set by `createNewSession` at session creation; pre-migration and externally-created sessions stay `source=NULL` and are invisible to `/cleanup`
- [x] `message_count` for Kilo counts only `role='user'` rows (exact user-turn count), so `KILO_CLEANUP_MAX_ROUNDS` reflects real conversational rounds, not inflated step counts
- [x] `/cleanup` refreshes the Kilo mirror via `refreshKiloMirror()` before classification so preview and confirm see the same fresh Kilo state (targeted refresh, does not walk Claude/Codex/Copilot/Qwen/Gemini filesystems — see PR #59 review fix N1+R4)
- [x] `/cleanup confirm` is FAIL-CLOSED on Kilo mirror refresh failure: aborts with user-facing explanation if `refreshKiloMirror()` throws OR returns `ok=false` (covers the silent-degradation path that scanAll would have swallowed)
- [x] README + bot menu updated with new commands

### Step 3.8.2: Cleanup hardening cascade [✅]

**Gate:** All risk findings from PR #59 tripartite review either resolved or formally tracked, and `cli-scanner.js` / `cli_sessions` schema protected against future drift.

Five Copilot Agent PRs dispatched in batch immediately after PR #59 merged, each addressing a specific risk finding or coverage gap from the tripartite review. Three of the five required in-flight intervention during merge (mock drift, textual conflict, broken graceful-degradation invariant) — the merge-simulate protocol was consolidated as mandatory for all Copilot PRs branched from pre-#59 main.

- [x] **#61 schema invariant test** (`bfcfbf5`) — `test/db-schema-invariant.test.js` parses `src/db.js` source and asserts every `ALTER TABLE ADD COLUMN` is also declared in the canonical `CREATE TABLE`. Fault injection validated: removing `source TEXT,` from CREATE makes test fail with exact column identification. Closes the drift class that escaped during PR #59 round 2 review.
- [x] **#67 JOIN_CHARS priority docs + regression test** (`9db8210`) — 19-line comment block above `JOIN_CHARS` explaining tie-break rationale (`-` > `_` > `.`) plus regression test creating both `go-server/` and `go_server/` and asserting decoder picks the hyphenated variant. Locks the order against accidental refactoring.
- [x] **#66 greedy match coverage** (`099319c`) — 5 focused tests for `decodeClaudeFolder` greedy algorithm using real directories under `$HOME` (greedy hyphen, greedy underscore, dotfile, HOME boundary, MAX_DEPTH). Closes the coverage gap where the existing greedy test never actually exercised the greedy path. **In-flight fix:** mock drift — added `reconcileCliSessions` to test mock namedExports.
- [x] **#68 readdir cache** (`5cf3ee0`) — `decodeClaudeFolder(folder, readdirCache = new Map())` accepts per-scan cache; `scanClaude` creates one Map and threads it through the workspace loop so shared path ancestors (`/`, `$HOME`) are read once per scan instead of once per workspace. **In-flight fix:** textual merge conflict on `decodeClaudeFolder` signature with #66's `export` — resolved by combining both modifications.
- [x] **#71 message_count cache** (`55da951`) — new `cli_sessions.kilo_messages_seen_at INTEGER` column caches `session.time_updated` at last scan; `scanKilo` skips per-row `json_extract` count on cache hit (`cached.kilo_messages_seen_at === row.updated_epoch_ms`), falls back to prepared `countStmt` on miss. **In-flight fixes:** 3-file merge conflict (10 markers across `src/cli-scanner.js`, `src/db.js`, `test/cli-scanner.test.js`) + the branch would have removed the graceful-degradation try/catch wrapper from #59. Resolved by extending the inner try/catch to wrap the **entire** db-touching block (rows query + countStmt prepare + cache lookup loop + sessions push) — strictly more fail-closed than either #59 or #71 alone. Plus second mock drift in `test/decode-claude-folder.test.js` (added `getCliSessionById` to namedExports).
- [x] **Merge-simulate protocol consolidated** — see DECISION_LOG 2026-04-06 for the full workflow rationale. `git merge main --no-commit + npm test` is now mandatory before `gh pr merge --admin` for any Copilot PR branched from pre-merge main.
- [x] All tripartite findings (`/review` ledger on Supabase) resolved or persisted as open risk for follow-up dispatch.
- [x] Main test suite: 317 → 352 tests (+35 from cascade).

## Phase 3.9: v0.3.0 Health Check Wave 1 [✅]

Eight PRs merged over a single session (2026-04-08) to close the full v0.3.0 health check Wave 1. This phase closes the three Blockers from the post-release tripartite review, addresses four Risk findings, and handles one residual debt item + one follow-up issue discovered mid-wave. Side effect: the session also produced a reusable **gh CLI pipeline for applying Copilot reviewer suggestions programmatically**, validated empirically end-to-end on PR #125 (see DECISION_LOG 2026-04-08).

### Step 3.9.1: Timeout error guards + reviewer suggestions pipeline [✅]

**Gate:** `error.message` (which for `execFile` contains the command line + args, including the user prompt) is redacted from all user-facing error strings across all 5 exec backends, and the pipeline for applying Copilot reviewer suggestions via API is proven empirically.

- [x] **#125 timeout-aware error guards** — Codex, Copilot, Gemini, Claude backends emit structured error strings without `error.message` concatenation, keeping raw details in persisted debug logs only. Includes the `test/backends-timeout.test.js` coverage suite (151 lines).
- [x] **#125 4 reviewer suggestions applied via `gh` CLI + `resolveReviewThread` GraphQL mutation** — proof-of-concept for the programmatic pipeline (see DECISION_LOG 2026-04-08). Verified: `gh pr checkout` → `mcp_edit` → `npm test` → `git commit + push` → `gh api graphql resolveReviewThread` batch mutation is equivalent to manually clicking "Commit suggestion" on each thread, with the bonus that `copilot-pull-request-reviewer[bot]` does not re-trigger on the new commits (because `review_on_push: false` in the repo ruleset).
- [x] **#132 Gemini generic-failure residual** — same bug class as #125 but on the `Gemini failed` branch that the reviewer missed in its initial pass. Tracked in the #125 commit message as residual debt, then dispatched mid-session via mini-PR + `--admin` merge (direct push to main blocked by `main` ruleset).

### Step 3.9.2: Wave 1 dispatch — four parallel Copilot agent PRs [✅]

**Gate:** Four issues dispatched to Copilot agent in batch each produce a clean PR that merges without structural changes, closing Risk findings R3/R5 + Blockers 1/3.

- [x] **#126 messageBuffer clear on slash commands** (closes #119, Risk R5) — `clearMessageBuffer(chatKey)` exported from `message-handler.js`, global middleware clears the buffer on any incoming `/` message before handlers run. Prevents debounce-fired stale flushes after `/detach`, `/new`, `/cleanup`.
- [x] **#127 kilo serve explicit `--host 127.0.0.1`** (closes #122, Blocker 1) — the bridge-spawned `kilo serve` now passes the explicit bind address instead of relying on the implicit default, removing the risk of an accidental all-interface bind on future Kilo versions.
- [x] **#128 pendingCustomPath TTL** (closes #120, Blocker 3) — helper functions `setPendingCustomPath / deletePendingCustomPath / hasPendingCustomPath` + `BRIDGE_PENDING_PATH_TTL_MS` env var + identity-guard timer. Test coverage in `test/pending-custom-path.test.js` (185 lines).
- [x] **#129 rate-limit global middleware** (closes #121, Risk R3) — `src/rate-limit-middleware.js` promotes the per-user sliding window to a grammY middleware registered after auth and before command/handler setup. In-session conflict resolution on `src/index.js` middleware ordering (merge commit during dispatch): the final order is `auth → rate-limit → clearMessageBuffer → setupCommands/Handlers`.

### Step 3.9.3: Kilo /permission polling — Blocker 2 fix [✅]

**Gate:** The "policy/sandbox gap" trio from the health check is fully closed — Kilo permission requests that would previously leave the user blind to approval prompts now surface as a Telegram inline keyboard, receive the reply via API, and resume the paused turn without loss.

Before the fix, the bridge was blind to Kilo's runtime permission engine. `GET /permission` was never called, so users never saw approval prompts for bash/edit/write tool calls. Three distinct bugs conspired: (1) `kilo-client.js:527` filtered only `tool === "question"`, missing all `requires_approval` states; (2) `format.js:46-48` `extractAssistantText` filtered only `part.type === "text"`, silently dropping all tool results including denials; (3) `kilo-client.js:317` `lastSuccessfulPollAt` reset on every busy response, so the 2 m stale timer never fired.

- [x] **#131 Kilo permission HTTP round-trip** — full `poll → surface → reply → resume` loop via `GET /permission` (server-wide queue, MUST filter by `sessionID`) and `POST /permission/:id/reply` with reply values `once | always | reject`. 15 review threads opened and all resolved; 20 tests in `test/kilo-permission.test.js` (753 lines) covering empty/positive/negative filter cases, network errors, reply mapping, integration with `processTextMessage`, stale request id checks, double-tap concurrency, TTL auto-expire, replying-flag cleanup, nested permission recursion, `resumeResult.question` fallback, `resumeResult.error` path, and `clearPendingPermission` lifecycle.
- [x] **Lock pattern without window of vulnerability** — `inFlightChats.add(chatKey)` is called *before* `deletePendingPermission(chatKey)` to eliminate the gap where both guards are absent (see OPERATIONS invariants).
- [x] **Double-tap concurrency guard** — `pending.replying` boolean flag, scoped to the pending entry (not global `inFlightChats`), blocks concurrent button taps while the POST is in flight. Cleared on failure so the user can retry.
- [x] **Telegram callback answered before the network POST** — respects the ~10 s Telegram callback answer deadline even when Kilo is slow.
- [x] **Nested permission handling** — if `resumeTurn` returns another `{ permission }` (a tool chaining permissions), the handler recursively surfaces it without blocking or losing state.
- [x] **Question fallback after resume** — `resumeResult.question` is handled as the normal `mcp_question` path (surfaceQuestion + pending question entry).
- [x] **API_CONTRACT.md updated** — the new `{ permission, messageCountBefore }` shape is documented along with the "caller must not start a new turn" invariant.
- [x] **clearPendingPermission on /abort and /detach** — addressed as a follow-up concern from the in-session review (commit `01a57f7 fix: address concerns 1-4 in kilo permission flow`), following the same pattern as `clearMessageBuffer`.
- [x] **Log redaction on error paths** — `redactString()` applied to `String(err)` in log events and to `err.message` / `resumeErr.message` in user-facing `ctx.reply()` text.

### Step 3.9.4: Rate-limit coalescing fairness follow-up [✅]

**Gate:** A multi-fragment Telegram message (split at 4096 chars and coalesced by the bridge) counts as a single rate-limit slot, not N slots.

Discovered during the merge of #129: a `copilot-pull-request-reviewer[bot]` comment flagged as "low confidence" (and invisible to the standard GraphQL `reviewThreads` query — see the memory entry) pointed out that the global middleware ran per Telegram update, while fragment coalescing meant one logical turn could consume N slots. The concern was real but low-impact in single-user mode; tracked as follow-up issue #133 and dispatched to Copilot agent.

- [x] **#133 issue filed** — full spec with acceptance criteria ready for dispatch, noting single-user trade-off vs hypothetical multi-user severity.
- [x] **#134 rate-limit coalesced turns** — plain text messages now bypass the global middleware and are rate-limited inside `processTextMessage()` after fragment coalescing. Commands and callback queries remain rate-limited per-update. Uses Telegram's `bot_command` entity at offset 0 as the authoritative classifier (aligned with `message-handler.js:600-601`), not `text.startsWith("/")` — this prevents Unix paths like `/Users/foo/repo` from being misclassified as commands and incorrectly rate-limited. New `test/rate-limit-coalescing.test.js` (204 lines) covers all three acceptance criteria from #133.

### Wave 1 summary

| Issue / finding | PR | Class |
|---|---|---|
| #118 timeout errors (R1) | #125 | Risk R1 closed + 4 reviewer suggestions applied via gh CLI pipeline |
| Gemini `failed:` branch residual | #132 | Residual debt from #125, dispatched mid-session |
| #119 messageBuffer (R5) | #126 | Risk R5 closed |
| #122 kilo --host (Blocker 1) | #127 | **Blocker 1 closed** |
| #120 pendingCustomPath TTL (Blocker 3) | #128 | **Blocker 3 closed** |
| #121 rate-limit middleware (R3) | #129 | Risk R3 closed, merge-time conflict resolution on middleware ordering |
| #130 Kilo /permission polling (Blocker 2) | #131 | **Blocker 2 closed — policy/sandbox gap trio fixed** |
| #133 fragment counting fairness | #134 | Follow-up of #129, dispatched mid-wave |

**Test suite growth:** from 495 (post-#117) to 1457+ additions across 13 files during the wave, with two new focused test files (`test/kilo-permission.test.js` 753 lines, `test/rate-limit-coalescing.test.js` 204 lines).

**Residual debt tracked elsewhere:** `backends.js` complexity (OPERATIONS.md, still open), the in-session hardening of pending permission lifecycle was fully addressed inline in commit `01a57f7` within PR #131 (no carry-over).

## Phase 4: Multi-CLI Live Chat [✅]

Send messages to multiple CLI backends from Telegram.

### Step 4.1: Backend abstraction + multi-CLI [✅]

**Gate:** Send a message from Telegram to any supported CLI and get a response.

- [x] `CliBackend` abstraction (`sendMessage → { text } | { error }`)
- [x] `KiloBackend` — wraps KiloClient (HTTP API to `kilo serve`)
- [x] `CodexBackend` — `codex exec --json` via child_process with JSONL parsing
- [x] `CopilotBackend` — `copilot -p --output-format json` via child_process
- [x] `GeminiBackend` — `gemini -p -o json -y` via child_process
- [x] `ClaudeBackend` — `claude -p --output-format json` via child_process
- [x] `/new` shows CLI picker (inline keyboard) when multiple backends available
- [x] Message handler routes to correct backend based on `binding.cli`
- [x] Unsupported CLIs show helpful message with list of supported ones
- [x] Thread/session ID tracking for all exec-based backends
- [x] Unified callback handler for bind + newcli keyboards
- [x] End-to-end verified: Kilo ✅, Codex ✅, Claude ✅, Copilot + Gemini pending quota test

## Phase 4.5: Per-CLI Agent Registry [⏸]

Make agent selection backend-aware instead of Kilo-only. Current guardrail is intentional: non-Kilo sessions do not pretend to support `/agents` or `/agent` until real per-CLI wiring exists.

### Step 4.5.1: Backend-specific agent discovery + selection [⏸]

**Gate:** `/agents` and `/agent` reflect the current bound CLI and only expose agent choices that are actually applied by that backend.

- [ ] Codex agent discovery from `~/.codex/agents/*.toml`
- [ ] Copilot agent discovery from `~/.copilot/agents/*.agent.md`
- [ ] Per-backend registry abstraction instead of reusing only Kilo's `opencode.json`
- [ ] Backend invocation updated so selected non-Kilo agents are actually applied, not just listed
- [ ] Copilot agent metadata surfaced clearly when agent choice implies provider/model differences
- [ ] UX keeps the current guardrail for any CLI that still lacks real agent application

## Phase 4.6: Claude Code Live Chat [✅]

Promoted Claude from session discovery to first-class live chat backend.

### Step 4.6.1: Claude transport + session continuity [✅]

**Gate:** Send a message from Telegram to a bound Claude session and receive a real Claude response.

- [x] `claude -p --output-format json` produces clean JSONL (system, assistant, result events)
- [x] `ClaudeBackend` with session resume via `-r <session-id>`
- [x] JSONL parser extracts `assistant.message.content[].text` and `result.session_id`
- [x] `--permission-mode bypassPermissions` for unattended execution
- [x] Full MCP toolstack available (memory, RAG, etc.)
- [x] End-to-end verified from Telegram

## Phase 4.7: Runtime Reliability Fixes [✅]

Eliminate obvious transport failure modes before adding more surface area.

### Step 4.7.1: Gemini parsing + Kilo anti-stuck guardrails [✅]

**Gate:** Gemini returns assistant text instead of raw JSON blobs; Kilo preflight checks fail fast instead of hanging indefinitely.

- [x] Gemini full-stdout JSON parse before raw fallback
- [x] Kilo status and abort requests use dedicated timeouts
- [x] Per-chat in-flight guard prevents overlapping turns from piling onto the same session
- [x] Parser fallback and stuck-session paths emit persisted diagnostic events

### Step 4.7.2: Async turn submission for Kilo long-running turns [🔧]

**Gate:** A Kilo turn that takes 5+ minutes completes and delivers its result to Telegram instead of timing out silently.

- [x] `prompt_async` + status polling replaces synchronous `POST /message` for Kilo
- [x] `GET /session/:id/message` retrieves result after turn completion
- [x] Three-tier timeout: submission (fast), stale (2m idle), absolute (30m wall-clock)
- [x] Error messages are honest: no more "Try /agent sonnet" on timeout/busy
- [ ] End-to-end verified with a real heavy Kilo turn from Telegram

## Phase 5: File & Image Support [⏸]

Pass files and images between Telegram and Kilo sessions.

### Step 5.1: Telegram → Kilo attachments [⏸]

**Gate:** Send a photo or file in Telegram, Kilo receives it and can process it.

- [ ] Download Telegram photos/documents via Bot API
- [ ] Forward as file path or base64 to Kilo message parts
- [ ] Handle Kilo responses that reference generated files
- [ ] Send files/images back from Kilo to Telegram

## Phase 6: Structured Logging [✅]

Replace console.log/warn/error with a proper logging system.

### Step 6.1: Logging infrastructure [✅]

**Gate:** All bridge activity is logged with timestamps, levels, and context — queryable for debugging.

- [x] Structured logger with JSON output to file/stdout
- [x] Log levels: debug, info, warn, error
- [x] Request/response logging for Kilo client (method, path, status, latency)
- [x] Telegram command/message lifecycle logging with trace IDs and session context
- [x] Durable SQLite event store with retention pruning for high-value runtime events
- [x] Configurable via `LOG_LEVEL`, `LOG_FILE_PATH`, `LOG_DB_PATH`, `LOG_RETENTION_DAYS`

## Phase 7: Voice [⏸]

Voice messages as input, leveraging Kilo CLI's native voice support.

### Step 6.1: Voice-to-text bridge [⏸]

**Gate:** Send a voice message in Telegram, get a text response from Kilo.

- [ ] Download Telegram voice messages (OGG/Opus)
- [ ] Transcribe via Kilo's native voice pipeline or external STT
- [ ] Route transcribed text to bound session
- [ ] Optionally send TTS response back as voice message
