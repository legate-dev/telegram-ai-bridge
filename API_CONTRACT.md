# API Contract — Telegram Bridge

## Scope

This document defines the runtime contract inside the bridge: Telegram commands, backend interface, configuration surface, and logging/event guarantees.

## Backend interface

Every live-chat backend must implement the following contract:

```javascript
sendMessage({ sessionId, directory, text, agent, model })
  // Promise path (Kilo, Codex, Copilot)
  => { text: string, threadId?: string }
  |  { error: string }
  |  { question: { questions: Array, precedingText?: string } }
  |  { permission: { id: string, sessionID: string, permission: string, patterns: string[], metadata: object, always: string[] }, messageCountBefore: number }
  // AsyncGenerator path (Claude, Gemini)
  |  AsyncGenerator<StreamEvent>
```

**StreamEvent shapes (AsyncGenerator path):**

```javascript
{ type: "text",       text: string }           // text output chunk — join without separator
{ type: "thinking",   text: string }           // extended thinking block
{ type: "tool_use",   toolName: string, toolInput: string }
{ type: "permission", requestId: string, toolName: string, toolInput: string, toolInputRaw: object }
{ type: "question",   requestId: string, questions: Array }
{ type: "result",     sessionId: string, inputTokens: number, outputTokens: number }
{ type: "error",      message: string }        // terminal; generator ends after this
```

Backends that can yield `permission` events must also implement:
```javascript
replyPermission(requestId: string, behavior: "allow" | "deny"): void
```
Called by the `perm:` callback to write a `control_response` to the backend's stdin, unblocking the suspended generator. Gemini never yields `permission` events; its `replyPermission()` is a documented no-op.

### Behavioral rules (Promise path)

- `sendMessage()` should return `{ error }` for expected model/runtime failures
- `sendMessage()` may throw for transport or integration failures
- `sendMessage()` may return `{ question }` when the AI calls `mcp_question` mid-turn (Kilo only). The caller should surface the question to the user and re-submit their answer as a new turn. The conversation history already contains the question, so the AI can resume naturally.
- `sendMessage()` may return `{ permission }` when Kilo's permission engine has a pending request (Kilo only). The caller should surface the permission prompt to the user via inline keyboard (Allow once / Always allow / Deny / Allow everything). **The original turn is NOT aborted** — Kilo holds it server-side and resumes automatically once the bridge POSTs a reply to `POST /permission/:id/reply` or calls `POST /allow-everything`. The caller must not start a new turn.
- **`POST /allow-everything`** (Kilo only) — enables a wildcard rule `{ permission:"*", pattern:"*", action:"allow" }` that auto-approves all future tool calls. Payload: `{ enable: boolean, sessionID?: string, requestID?: string }`. When `requestID` is supplied, Kilo resolves the named pending request immediately and drains all other pending permissions in one call — no separate reply is needed. Scope: `sessionID` → session-only (dies on session close); absent → global (persisted in `opencode.json`). Surfaced as **⚡ Allow everything (session)** (`ae:session:<requestId>`) and **🌐 Allow everything (global)** (`ae:global:<requestId>`) buttons on the Kilo permission keyboard.

### Behavioral rules (AsyncGenerator path)

- Detected via `typeof sendMessage(...)[Symbol.asyncIterator] === "function"` — no CLI name check
- `text` events are accumulated and sent as one message when `result` fires
- `permission` events surface an inline keyboard; the generator naturally suspends because Claude blocks on stdin awaiting the `control_response`. When the user taps Allow/Deny, `replyPermission()` writes to stdin and the generator resumes
- `question` events are auto-denied in Phase 1.1 (full AskUserQuestion round-trip deferred to Phase 1.2)
- `error` events clear any pending permission state and surface an error message
- `inFlightChats` is held for the full duration of the generator loop; the `perm:` callback must not touch it
- `threadId` is optional and updates persisted chat binding when present
- `directory` must be absolute by the time a backend receives it
- `agent` is advisory unless the backend explicitly applies it
- `model` is optional; when set, backends that support it pass it as a CLI flag (`--model` for Claude, `-m` for Codex)

## Telegram command contract

| Command | Arguments | Result |
|---------|-----------|--------|
| `/start` | none | Shows bridge status and current binding |
| `/sessions` | `[cli\|N]` | Lists recent sessions from local scanner DB |
| `/clis` | none | Lists discovered CLIs and counts |
| `/new` | `[cli] [path]` | Creates a new backend session; picker shown if CLI omitted and multiple are available |
| `/agents` | none | Lists available Kilo agents only |
| `/agent` | `<name>` | Sets preferred Kilo agent for this chat |
| `/models` | none | Lists available models for current CLI (Claude/Codex inline keyboard; redirects for Kilo; unsupported for others) |
| `/model` | `<name>` | Sets model for current session (Claude/Codex only) |
| `/status` | none | Shows current binding; session label resolves as `display_name → title → truncated session_id` (works for all CLIs) |
| `/abort` | none | Aborts the current bound session if backend supports it |
| `/cleanup` | none or `confirm` | Previews bridge-created Kilo sessions to delete; only `confirm` performs deletion. Bridge ownership is determined by the deterministic `source='bridge'` flag set at session creation, NOT by title pattern. Sessions with more user turns than `KILO_CLEANUP_MAX_ROUNDS` are protected. The handler triggers a fresh `scanAll()` so preview and confirm always see the same state. |
| `/detach` | none | Removes the current chat binding |

## Session-binding contract

Bindings are stored in `sessions.db` (path configurable via `BRIDGE_DB_PATH`) table `chat_bindings`.

```sql
chat_id TEXT PRIMARY KEY
cli TEXT NOT NULL
session_id TEXT NOT NULL
agent TEXT NULL
model TEXT NULL
directory TEXT NULL
updated_at TEXT NOT NULL
```

### Guarantees

- A chat may have at most one active binding
- A binding is usable only when both `session_id` and `directory` are present
- Backends may replace `session_id` after a successful turn if they return `threadId`
- `model` is persisted per chat and passed to the CLI backend on each turn when set

## Model selection contract

Model selection is supported for Claude Code and Codex backends only.

| CLI | Discovery source | Flag |
|-----|-----------------|------|
| `claude` | Static aliases (`opus`, `sonnet`, `haiku`) + `projects.*.lastModelUsage` keys from `~/.claude.json` | `--model <name>` |
| `codex` | `~/.codex/models_cache.json` filtered by `visibility === "list"`, sorted by `priority` | `-m <slug>` |
| `kilo` | N/A — use `/agents` | — |
| `copilot`, `gemini` | Not supported | — |

### Design constraints

- No network calls for model discovery — all reads are local file reads
- No model validation at selection time — the CLI errors if invalid
- Config paths are overridable via `CODEX_MODELS_CACHE_PATH` and `CLAUDE_CONFIG_PATH`

## Kilo transport contract

### Endpoints used

- `POST /session`
- `GET /session/:id`
- `GET /session`
- `GET /session/status`
- `POST /session/:id/abort`
- `DELETE /session/:id`
- `POST /session/:id/message` (sync fallback, used for retries on transient failures)
- `POST /session/:id/prompt_async` (primary turn submission)
- `GET /session/:id/message` (result retrieval after async turn)

### Turn lifecycle (async model)

1. **Submit**: `POST /session/:id/prompt_async` — fire-and-forget, returns immediately
2. **Initial delay**: wait `KILO_POLL_INITIAL_DELAY_MS` before the first poll so the server registers "busy"
3. **Poll**: `GET /session/status` at `KILO_POLL_INTERVAL_MS` intervals
4. **Question check**: every 5 polls (~15s) while busy, also `GET /session/:id/message` to detect `mcp_question` tool calls with `state.status === "running"`. If found, abort the turn and surface the question as Telegram inline keyboard.
5. **Permission check**: every 2 polls (~6s) while busy, also `GET /permission` to detect pending Kilo permission requests for this session. If found, surface as Telegram inline keyboard with Allow once / Always allow / Deny. The turn is **not** aborted — it resumes on Kilo's side once the bridge POSTs a reply.
6. **Detect completion**: session status transitions from `busy` to idle/absent
7. **Retrieve**: `GET /session/:id/message` — find new assistant messages since submission
8. **Deliver**: extract text parts and send to Telegram (chunked for Telegram 4096 char limit)

### Timeout semantics

- `KILO_SUBMIT_TIMEOUT_MS` applies to the `POST /session/:id/prompt_async` submission (default 15s)
- `KILO_STATUS_TIMEOUT_MS` applies to individual `GET /session/status` and `GET /session/:id/message` calls
- `KILO_ABORT_TIMEOUT_MS` applies to `POST /session/:id/abort`
- `KILO_TURN_TIMEOUT_MS` is the absolute wall-clock limit for waiting on a turn (default 30 min)
- `KILO_STALE_TIMEOUT_MS` is the max time without a **successful** status poll response (default 2 min). A steady "busy" response is not stale — it means the server is alive and working. Stale only triggers when the server stops responding to poll requests entirely.
- `KILO_POLL_INTERVAL_MS` is the polling frequency during a turn (default 3s)
- `KILO_POLL_INITIAL_DELAY_MS` is the wait before the first poll after submission (default 5s)
- `KILO_TIMEOUT_MS` remains as the timeout for the sync `POST /message` path (fallback only)

### Retry semantics

- Retries apply only to the sync message path (fallback)
- Retryable HTTP statuses: `429`, `502`, `503`, `504`
- Retryable network classes: timeout, abort, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `UND_ERR_SOCKET`

## Logging contract

### Outputs

- `LOG_FILE_PATH`: append-only NDJSON runtime stream
- `LOG_DB_PATH`: SQLite event store for high-value events

### Persisted event classes

- warnings and errors
- Gemini streaming: `exec.timeout`, `exec.no_result`, `stream.error_event` (all persisted)
- session bind/create/detach/abort/cleanup events
- stuck-session diagnostics
- backend exception paths

The `persist` marker is reserved for low-frequency, high-value events. It must not be used for heartbeat-like or per-token logging.

### Retention

- persisted log events older than `LOG_RETENTION_DAYS` are pruned automatically

## Configuration contract

Required:

- `TELEGRAM_BOT_TOKEN`

Common optional variables:

- `TELEGRAM_ALLOWED_USER_ID`
- `BRIDGE_DEFAULT_DIRECTORY`
- `BRIDGE_DB_PATH`
- `BRIDGE_MESSAGE_DEBOUNCE_MS` — debounce window (ms) for coalescing Telegram auto-split message fragments into a single backend turn; only activates when a message is exactly 4096 chars (Telegram's split boundary); set to `0` to disable (default: `1500`)
- `KILO_SERVE_PORT` — port for the bridge-managed `kilo serve` process (default: 4097); must be an integer in [1, 65535]
- `KILO_SERVE_SHELL` — shell used to spawn `kilo serve` (default: `$SHELL`, fallback `/bin/sh`); override to use a specific login shell
- `KILO_SERVE_URL` — legacy escape hatch: if set, the bridge skips spawning and connects to this URL instead
- `KILO_SERVER_USERNAME`
- `KILO_SERVER_PASSWORD`
- `KILO_TIMEOUT_MS`
- `KILO_RETRIES`
- `KILO_STATUS_TIMEOUT_MS`
- `KILO_ABORT_TIMEOUT_MS`
- `KILO_VARIANT`
- `LOG_LEVEL`
- `LOG_FILE_PATH`
- `LOG_DB_PATH`
- `LOG_RETENTION_DAYS`

## Non-contractual behavior

These may evolve without breaking the bridge contract:

- exact JSON shape of log lines
- SQLite schema details inside `LOG_DB_PATH`
- internal trace ID format
- Telegram formatting details beyond best-effort readable output
