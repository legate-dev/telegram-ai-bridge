# Architecture — Telegram Bridge

> Lightweight Node.js bridge: Telegram bot ↔ AI coding CLI sessions.
> Supports Kilo, Codex, GitHub Copilot, Gemini CLI, and Claude Code.

## Problem

Access to AI coding tools requires a terminal session on a local machine. No mobile access, no remote access without SSH.

## Solution

A bridge that:

1. Receives messages from a Telegram bot (single-user, DM only)
2. Routes them to the appropriate CLI backend
3. Returns a formatted response back to Telegram
4. Manages sessions (create, resume, list, detach)

The bridge is **transport only** — no agent logic, no LLM calls, no tool execution.

## System Diagram

```
                        ┌──────────────────────────────────────┐
                        │  Host machine (always-on)            │
                        │                                      │
┌──────────────┐        │  ┌────────────────────────────────┐  │
│  Telegram    │  long  │  │  telegram-ai-bridge            │  │
│  (mobile/    │◄─poll──│  │  grammY + backend router       │  │
│   desktop)   │        │  │                                │  │
└──────────────┘        │  └──────┬─────────┬────────┬──────┘  │
                        │         │         │        │         │
                        │    HTTP │   exec  │  exec  │  exec   │
                        │         │         │        │         │
                        │  ┌──────▼──┐ ┌────▼──┐ ┌───▼───┐    │
                        │  │  kilo   │ │ codex │ │copilot│ ...│
                        │  │  serve  │ │ exec  │ │  -p   │    │
                        │  │  :4097  │ │ --json│ │ --json│    │
                        │  │         │ └───────┘ └───────┘    │
                        │  │  ┌─ MCP servers ─┐ │             │
                        │  │  │ your tools,   │ │             │
                        │  │  │ memory, DB... │ │             │
                        │  │  └───────────────┘ │             │
                        │  └────────────────────┘             │
                        │                                      │
                        └──────────────────────────────────────┘
```

## Backend Architecture

The bridge uses a pluggable backend system. Each CLI is wrapped in a `CliBackend` that implements a common interface:

```
sendMessage({ sessionId, directory, text, agent }) → { text } | { error }
createSession({ title, directory }) → { id }
abortSession(sessionId)
getSessionStatus(sessionId)
```

### Kilo Backend (HTTP)

- Bridge-managed daemon: the bridge spawns `kilo serve --port 4097 --host 127.0.0.1` on startup via a login shell (`KILO_SERVE_SHELL`, default `$SHELL` with `/bin/sh` fallback, so shell functions and PATH are resolved) and shuts it down on exit. The explicit `--host 127.0.0.1` was added in PR #127 to remove any implicit bind assumption
- If `KILO_SERVE_URL` is explicitly set in env, the bridge skips spawning and connects to that URL (legacy/external mode for advanced setups)
- Session CRUD via REST API
- Agent/variant selection per message
- Full session lifecycle (create, abort, delete, status)
- MCP tools available (memory, RAG, DB, calendar, etc.)

#### Permission flow (added 2026-04-08 with PR #131)

Kilo has a runtime permission engine that pauses a turn server-side when the AI wants to execute a sensitive tool call (bash, edit, write) and waits for explicit approval via `POST /permission/:id/reply`. Before PR #131 the bridge was blind to this engine — the user never saw the approval prompt and the turn would hang. The Kilo backend now implements the full round-trip:

1. **Poll** — during `waitForTurn`, every `permissionCheckEveryNPolls = 2` iterations, the client calls `GET /permission` to fetch the pending-permission queue. The queue is **project-wide** (not session-scoped), so `_checkForPendingPermission(sessionId)` filters by `req.sessionID === sessionId` before returning
2. **Surface** — when a matching pending permission is detected, `KiloBackend.sendMessage` returns `{ permission, messageCountBefore }` (instead of aborting the turn). The message handler calls `surfacePermission` which stores a `pendingPermissions[chatKey]` entry with TTL and sends the user an inline keyboard with five buttons across two rows: `✅ Allow once` / `✓✓ Always allow` / `❌ Deny` and `⚡ Allow everything (session)` / `🌐 Allow everything (global)`. **The original turn is NOT aborted** — Kilo holds it server-side waiting for the reply
3. **Reply** — when the user taps a button, the callback handler validates the untrusted reply value against `{once, always, deny}`, checks for stale requestId, guards against concurrent taps via `pending.replying` flag, answers the Telegram callback immediately (before the network POST to respect Telegram's ~10 s deadline), then calls `POST /permission/:id/reply` with the reply value (`deny` maps to Kilo's `reject`)
4. **Resume** — if the POST succeeds, the handler calls `pending.backend.resumeTurn(sessionId, directory, messageCountBefore)` to continue the paused Kilo turn. `resumeTurn` can itself return `{ permission }` (nested permission chain, recursive surfacing), `{ question }` (mid-resume `mcp_question`, normal question surfacing), `{ text }` (model output, normal reply), or `{ error }` (surface error to user)

The callback handler uses a **no-window lock pattern**: `inFlightChats.add(chatKey)` is called *before* `deletePendingPermission(chatKey)` so there is never a moment where both guards are absent simultaneously. Inverting the order opens a race where a concurrent Telegram message could start a new turn against the paused backend state. See OPERATIONS.md invariants for the full list of permission-flow invariants.

See DECISION_LOG 2026-04-08 for the full architectural rationale, alternatives considered, and empirical validation.

### Codex Backend (child_process)

- Spawns `codex exec --json <prompt>` per message
- Parses JSONL output: `thread.started`, `item.completed`, `turn.completed`
- Session resume via `codex exec resume <session-id>`
- Thread ID tracking for session continuity

### Copilot Backend (child_process)

- Spawns `copilot -p <prompt> --output-format json --allow-all-tools`
- Parses JSONL output: `assistant.message`, `assistant.turn_end`, `result`
- Session resume via `--resume=<session-id>`
- Supports `--effort` for reasoning levels

### Claude Code Backend (spawn + AsyncGenerator)

- Spawns `claude --input-format stream-json --output-format stream-json` per turn; user prompt delivered on stdin as a stream-json message; stdin closed after send
- Streams events via AsyncGenerator: `text`, `thinking`, `tool_use`, `permission`, `result`, `error`
- Permission mode controlled by `BRIDGE_CLAUDE_DANGEROUS_SKIP_PERMISSIONS` (default `true`):
  - `true` — `--permission-mode bypassPermissions` (all tools auto-approved)
  - `false` — `--permission-prompt-tool stdio` (permission events surface as Telegram inline keyboard)
- Session resume via `-r <session-id>`
- Full MCP toolstack available (memory, RAG, etc.)
- Supports `--model` (sonnet, opus) and `--effort` (low, medium, high, max)

### Gemini Backend (spawn + AsyncGenerator)

- Spawns `gemini --output-format stream-json -y` per turn; prompt delivered via `-p <prompt>`
- Streams events via AsyncGenerator: `text`, `tool_use`, `result`, `error` (no `permission` events — Gemini CLI has no stdio permission protocol; `-y` keeps auto-approve)
- `delta:true` chunks forwarded immediately; `delta:false` reasoning fragments buffered and discarded if a `tool_use` follows, flushed as text at `result`
- Session resume via `-r <session-id>`
- Handles quota exhaustion and spawn errors (ENOENT) gracefully

## Components

### Telegram Bot (grammY)

- **Transport:** Long polling (no webhook, no exposed port)
- **Auth:** Single-user allowlist by Telegram user ID
- **Formatting:** Telegram MarkdownV2, 4096 char limit with chunking

### Session Manager

Maps Telegram conversations to CLI sessions. Bindings persisted in local SQLite.

| Command | Action |
|---------|--------|
| `/new [cli] [path]` | Create new session (CLI picker if multiple available) |
| `/sessions [cli\|N]` | List recent sessions from all CLIs |
| `/clis` | List discovered CLIs |
| `/abort` | Abort stuck session |
| `/cleanup` | Remove zombie bridge sessions |
| `/detach` | Unbind current session |
| `/status` | Session info |
| `/agents` | List available agents (Kilo only) |
| `/agent <name>` | Switch agent (Kilo only) |

### CLI Scanner

Discovers sessions from local CLI state at startup and via file watcher:

- **Claude Code:** `~/.claude/projects/` (JSONL session files)
- **Codex:** `~/.codex/sessions/` (JSONL with session_meta)
- **Copilot:** `~/.copilot/session-store.db`, `~/.copilot/session-state/` (SQLite session index + JSONL event state)
- **Qwen/Gemini:** `~/.qwen/tmp/`, `~/.gemini/tmp/` (JSON logs)
- **Kilo:** `~/.local/share/kilo/kilo.db` (SQLite)

#### Caching layers

Two per-scan caches keep the 5 s debounce loop cheap as workspaces and Kilo histories grow:

- **`readdirCache`** (Claude only) — `decodeClaudeFolder` accepts a per-invocation `Map` from `scanClaude`. Shared path ancestors (`/`, `$HOME`) are read once per scan instead of once per workspace folder. Cache is intentionally not shared across `scanClaude` invocations to avoid stale data.
- **`message_count` cache** (Kilo only) — `scanKilo` skips the per-row `json_extract` user-role count when `cli_sessions.kilo_messages_seen_at` matches the current `session.time_updated`. Cache miss falls back to a prepared `countStmt` for that session only. This avoids running `json_extract` on every Kilo message every 5 s tick.

#### Kilo message_count semantic

For Kilo only, `cli_sessions.message_count` represents the **exact number of user turns** — rows where `json_extract(data, '$.role') = 'user'` in the Kilo `message` table. Kilo writes one `message` row per atomic step (text chunk, tool call, thinking block, etc.), so the raw `COUNT(*)` would inflate the count by ~5–12× and make `KILO_CLEANUP_MAX_ROUNDS` reflect step count instead of conversational rounds.

#### Targeted Kilo refresh

`refreshKiloMirror()` is the public API that `/cleanup` calls before classifying sessions for deletion. It reads only the Kilo SQLite DB and reconciles the local mirror — it does not walk Claude/Codex/Copilot/Qwen/Gemini filesystems. Returns `{sessions, ok}`; `/cleanup confirm` is **fail-closed** on `ok === false` or any thrown error.

#### Fail-closed db work

`scanKilo` wraps the entire db-touching block (rows query + `countStmt` prepare + cache lookup loop + sessions push) in a single inner `try/catch`. Any SQLite failure (missing JSON1, malformed JSON in `data`, schema drift on the Kilo side, cache row corruption) degrades gracefully to `{sessions: [], ok: false}` instead of bubbling up through `refreshKiloMirror` / `scanAll` and crashing bridge startup or letting `/cleanup` operate on a half-updated mirror.

### Response Formatter

- Parse CLI output (JSON, JSONL, or plain text)
- Convert to Telegram MarkdownV2
- Chunk at code block boundaries
- Fallback to plain text on parse errors

## Session Hygiene

Bridge sessions can get stuck (e.g., after a failed streaming attempt), blocking subsequent messages. The bridge **never** deletes sessions implicitly: there is no startup cleanup, no `/new` auto-cleanup, no background reaper. The only destructive paths are explicit user actions:

- **`/abort`** — abort current bound session (does not delete)
- **`/cleanup`** — two-phase preview/confirm deletion of bridge-owned Kilo sessions only

### Bridge ownership is declarative

`/cleanup` does not guess which sessions are zombies. Ownership is declarative via `cli_sessions.source = 'bridge'`, set explicitly by `createNewSession` at session creation. Sessions with `source IS NULL` (pre-migration or externally created) are intentionally **invisible** to all destructive paths — `/cleanup` cannot see them, classify them, or delete them. This replaced the legacy `isBridgeSessionTitle` heuristic that pattern-matched on `telegram-*` titles, which had false positives on user-renamed sessions and false negatives on bridge sessions whose titles were updated by Kilo's auto-titler.

### `/cleanup` flow

1. **Trigger** — user issues `/cleanup` (with no args). Handler fetches the current chat binding to know which session to protect.
2. **Targeted refresh** — calls `refreshKiloMirror()` to read the Kilo DB and reconcile the local mirror. Other CLIs are not touched.
3. **Classification** — queries `getKiloBridgeSessions(boundSessionId)` which returns only `source='bridge'` rows excluding the current binding. Each session is sorted into `eligible` (deletable) or `recent` (protected by `KILO_CLEANUP_MAX_ROUNDS` user-turn threshold).
4. **Preview** — shows the user the eligible set with a `confirm` token.
5. **Confirm** — user issues `/cleanup confirm`. Handler **re-reads** the binding (race protection vs `/new`), re-runs `refreshKiloMirror`, and **fails closed** if the refresh throws or returns `ok=false`. Otherwise deletes only the eligible set via `deleteSession` per ID, then reconciles the mirror.

### Schema invariant

All `ALTER TABLE ADD COLUMN` migrations in `src/db.js` must also appear in the canonical `CREATE TABLE` block for the same table. This invariant is locked by `test/db-schema-invariant.test.js` which parses the source code and asserts the contract — drift fails `npm test` immediately.

## Security Model

- **Single user only:** `TELEGRAM_ALLOWED_USER_ID` env var
- **Rate limiting:** per-user sliding window (configurable via `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`), promoted to a global grammY middleware in PR #129. Commands and callback queries are rate-limited **per Telegram update** (1 command = 1 slot, 1 button tap = 1 slot). Plain text messages bypass the middleware and are rate-limited inside `processTextMessage()` **after** fragment coalescing, so a multi-fragment message (Telegram splits at 4096 chars, bridge coalesces via `messageBuffer`) counts as **one** logical turn = one slot, not N. Command detection uses Telegram's `bot_command` entity at offset 0 as the authoritative classifier, not `text.startsWith("/")`, so Unix paths like `/Users/foo/repo` are not misclassified as commands (see PR #134 / DECISION_LOG 2026-04-08)
- **Bot token:** env var (gitignored `.env`)
- **Kilo serve:** spawned with explicit `--host 127.0.0.1` so the bind is never implicit (PR #127, closes Blocker 1 from v0.3.0 health check)
- **Kilo permission engine:** the bridge mediates Kilo's runtime permission requests via `GET /permission` + `POST /permission/:id/reply` round-trip, surfacing them as Telegram inline keyboards. See the Kilo Backend permission flow section above. Closes Blocker 2 from the v0.3.0 health check (PR #131)
- **No exposed ports:** long polling = outbound only
- **No secrets in chat:** redact before sending to Telegram. `redactString()` is applied to error messages in both persisted logs and user-facing `ctx.reply()` text throughout the permission flow (PR #131 commit `01a57f7`) and elsewhere

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js 22+ | Same as ecosystem |
| Telegram lib | grammY | TypeScript-first, middleware, excellent docs |
| Kilo interface | `kilo serve` HTTP | Persistent, session-aware |
| CLI interface (exec) | `child_process.execFile` | Codex, Copilot |
| CLI interface (stream) | `child_process.spawn` + AsyncGenerator | Claude Code, Gemini |
| Config | env vars | Simple, twelve-factor |
| State | SQLite | Session bindings + scanned CLI sessions (`cli_sessions` table includes `source` for declarative ownership and `kilo_messages_seen_at` for per-row count cache) |
| Hosting | Always-on machine | Same host as CLI tools |

## Non-Goals

- No hosted infrastructure — everything runs on a local machine
- No new agent runtime — CLIs ARE the runtime
- No token billing through third parties
- No multi-user support
