# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note on historical references.** This log carries forward decisions and
> fixes made during an internal pre-release development phase. PR numbers
> cited inline (e.g. `#112`, `#131`) refer to that prior private repository
> and are preserved here as narrative traceability for the rationale behind
> each entry — they do not resolve to issues in this public repository.

## [Unreleased]

## [0.5.0] - unreleased

### Added

- **LM Studio backend** (#41–#44). Local LM Studio server (≥ 0.4.0) as a
  privacy-first backend via its native REST API. Unlike exec-based backends,
  LM Studio manages conversation history entirely server-side — the bridge
  stores only an opaque `response_id` per session; no message content ever
  lands in the local DB. Thread continuity is achieved via
  `previous_response_id` in the POST body, so each reply picks up exactly
  where the previous one left off without replaying history. Named SSE events
  (`message.delta`, `reasoning.delta`, `tool_call.*`, `chat.end`) are streamed
  and forwarded to Telegram in real time. Optional auth via
  `LMSTUDIO_API_TOKEN`. Always marked as supported; fails gracefully at
  runtime if LM Studio is not running. A one-time `VACUUM` migration purges
  any legacy `lmstudio_messages` data on upgrade.

- **LM Studio model selection** (#43). `/models` lists available LLM models
  fetched from `GET /api/v1/models` as an inline keyboard. `/model <name>`
  sets the model for the current session. Same commands already supported for
  Claude Code and Codex.

### Fixed

- **LM Studio callback data truncation** (#46). Telegram caps `callback_data`
  at 64 bytes. Long LM Studio model slugs (e.g.
  `dolphin-mistral-glm-4.7-flash-24b-venice-edition`) exceeded this limit.
  Model keys whose `slug.length` exceeds 54 characters (`MAX_CALLBACK_SLUG`)
  are now encoded as `#<index>:<sha256[:8]>`. `resolveIndexedModelSlug`
  validates the fingerprint and returns a structured `{ ok, reason, slug }`
  result: `"invalid_token"` (bad format) and `"unavailable"` (model list
  unavailable) produce differentiated alert text; `"fingerprint_mismatch"` and
  `"index_out_of_range"` fall back to the generic "Model list changed" alert.
  Legacy `#<index>` tokens (no fingerprint, from before PR #46) are still
  accepted for backward compatibility.

- **LM Studio SSE stream edge cases** (#47). Replaced the line-by-line SSE
  parser with a block-based parser (`parseSseEventBlock`) that correctly
  handles multi-line `data:` payloads and arbitrary TCP chunk boundaries.
  Added `extractMessageText`/`extractMessageTextFromOutput` helpers for
  flexible content shapes. Fixed `textParts.join("")` (was `join("\n\n")`) to
  eliminate spurious blank lines between response chunks.

## [0.4.1] - 2026-04-10

### Added

- **Gemini streaming backend** (#37). Migrated `GeminiBackend` from
  one-shot `execFile -o json` to `spawn`-per-turn with
  `--output-format stream-json`, matching the `AsyncGenerator` interface
  established by Claude. The bridge now surfaces Gemini responses in real
  time as they arrive: `delta:true` chunks are forwarded immediately,
  `delta:false` reasoning fragments are buffered and discarded if a tool
  call follows (preventing planning noise from leaking into chat),
  and the final answer is flushed when the `result` event arrives. Timeout
  errors now report the exact wait time. The `spawn` error handler catches
  missing-binary failures cleanly. No interactive permissions: Gemini CLI
  has no stdio permission protocol (`-y` keeps auto-approve as before).

- **Kilo allow-everything permission mode** (#38). The Kilo permission
  prompt in Telegram now shows two extra buttons below the existing row:
  **⚡ Allow everything (session)** and **🌐 Allow everything (global)**.
  Tapping either calls Kilo's `POST /allow-everything`, which immediately
  resolves the pending request, drains every other queued permission for
  the same scope, and installs a wildcard `{ permission:'*', pattern:'*',
  action:'allow' }` rule — scoped to the current session for ⚡ or
  persisted in `opencode.json` for 🌐. Claude and Gemini prompts are
  unchanged. The extra row renders only when the active backend exposes
  `kilo.allowEverything`; forged taps on non-Kilo sessions are rejected
  with an alert.

## [0.4.0] - 2026-04-10

### Added

- **Claude interactive permission prompts** (#34). The Claude backend now uses
  `--permission-prompt-tool stdio` instead of `--dangerously-skip-permissions`.
  When Claude wants to run a Bash command, edit a file, or invoke any tool
  requiring approval, you get an inline keyboard with three choices: **Allow once**,
  **Always allow**, and **Deny** — directly in Telegram. No more blind auto-approval
  of every tool call. The paused turn resumes automatically after you respond;
  no context is lost.

  Set `BRIDGE_CLAUDE_DANGEROUS_SKIP_PERMISSIONS=false` in `.env` to opt in.
  Default is `true` (previous behaviour — all tools auto-approved) so existing
  deployments are unaffected.

- **Claude progress events**. The new streaming backend emits `text`, `thinking`,
  and `tool_use` events in real time. Text chunks are accumulated and sent as one
  message when the turn completes, eliminating the previous 30–120 s silence
  while Claude was working.

### Fixed

- **KILO_SERVE_URL security note** (#33). Added a warning in `.env.example`
  that exposing `KILO_SERVE_URL` to an external host without TLS puts the Kilo
  server unauthenticated on the network.

## [0.3.4] - 2026-04-09

### Fixed

- **Codex session resume broken on CLI 0.77.0+** (#29). Exec-level flags
  (`--json`, `--skip-git-repo-check`, `-m`) were placed after the `resume`
  subcommand, which Codex 0.77.0 rejects with exit code 2. Flags now come
  before the subcommand. Reported with a precise repro and local fix by
  [@RaspberriesinBlueJeans](https://github.com/RaspberriesinBlueJeans).

### Documentation

- Added `CONTRIBUTORS.md` listing [@RaspberriesinBlueJeans](https://github.com/RaspberriesinBlueJeans)
  and [@Matita_Pereira](https://github.com/Matita_Pereira) with their contributions.

## [0.3.3] - 2026-04-09

### Added

- **Last message preview on session bind** (#19). When reopening or binding
  an existing session, the bridge surfaces the last assistant message so you
  have immediate context without having to remember where the conversation
  stopped. Supported backends: Claude (JSONL on disk), Kilo (HTTP API), Codex
  (session JSONL), Copilot (`events.jsonl`), Gemini (`logs.json`).

### Fixed

- **Session labels now show human-readable names for all CLIs** (#18). Commands
  `/start`, `/status`, `/abort`, `/detach` and bind confirmations previously
  showed a raw truncated session ID for non-Kilo backends. All commands now
  resolve the label as `display_name → title → truncated session_id`.
- **Codex sessions now display a readable title** (#26). The Codex scanner
  previously stored `title: null` for every session. Titles are now derived
  from the first user prompt in `~/.codex/history.jsonl` — the same approach
  Claude uses with its own session files. Degrades gracefully if the file is
  absent.

## [0.3.2] - 2026-04-09

### Fixed

- **Kilo is now optional at startup** (#10). The bridge previously called
  `process.exit(1)` if `kilo serve` failed to start, making Kilo an
  undocumented hard requirement even for Codex-only or Claude-only installs.
  The bridge now logs a warning and boots with whichever backends are
  available. `/cleanup` returns a clear message instead of crashing when
  Kilo is absent.
- **`/status` and workspace listings no longer show `Directory: .`** (#11).
  When the bridge runs from its own directory (the default when
  `BRIDGE_DEFAULT_DIRECTORY` is not set), `displayPath` now returns the
  full `~/…` path instead of a cwd-relative `.`.

### Documentation

- Added a **one token, one machine** warning to the README security section
  (#12). Running two bridge instances with the same bot token causes Telegram
  to split messages between them unpredictably; create a separate bot via
  BotFather for each host.

### Internal

- Split `src/backends.js` (820 LOC) into `src/backends/*.js` — one file per
  backend plus shared utilities and a registry (#14). No behaviour change;
  `src/backends.js` is kept as a barrel re-export so all existing import
  paths continue to work.

## [0.3.1] - 2026-04-08

**Initial public release.**

At the point of tagging, the codebase consolidates internal development up to
and including the v0.3.0 health-check Wave 1: structured logging, multi-CLI
live chat (Claude Code, Codex, Copilot, Gemini, Kilo), bridge-managed Kilo
daemon lifecycle, Kilo runtime permission round-trip, rate limiting, session
discovery and cleanup with deterministic ownership, and a hardened custom-path
workspace picker. The version number starts at 0.3.1 (rather than 0.0.1 or
0.1.0) to honor the maturity of the codebase at the point of opening it and
the full set of health-check fixes already consolidated in this initial tag.

### What it does

A self-hosted Telegram bot that bridges your phone to AI coding CLIs running on
your machine. Chat with Claude Code, Codex, Copilot, Gemini, or Kilo from anywhere
without opening a terminal. See the
[About this project](README.md#about-this-project) section of the README for the
why, and [ARCHITECTURE.md](ARCHITECTURE.md) for the how.

### Features

- **Multi-CLI live chat support**: Claude Code, Codex (exec), Copilot, Gemini, Kilo
  (HTTP daemon). Each backend is a thin adapter; adding a new one is one file.
- **Session discovery**: scan local CLI state directories on startup and via fs
  watcher. Surface discovered sessions through `/sessions` for one-tap binding.
- **Workspace-driven `/new`**: pick from your most-used workspaces (frequency-ranked)
  or type a custom path with shell-like shorthand (`~/repo` is expanded). Strict
  path parser rejects ambiguous input (relative paths, per-user tilde, non-existent
  directories) with clear user-facing errors.
- **Per-CLI session management**: bind, status, abort, rename, per-session model
  selection (Claude only — `/model`, `/models`).
- **Bridge-managed Kilo daemon**: the bridge auto-spawns `kilo serve` on startup
  via a configurable login shell (`KILO_SERVE_SHELL`, default `$SHELL`) and shuts
  it down on `SIGINT`/`SIGTERM`. No separate launchd service needed. Legacy
  external mode still supported via `KILO_SERVE_URL` env var.
- **Session cleanup with deterministic ownership**: `/cleanup` two-phase
  preview/confirm; only sessions explicitly created via `/new` (`source='bridge'`)
  are eligible. Pre-migration and externally-created sessions are intentionally
  invisible to all destructive paths.
- **Inline `mcp_question` keyboards**: when an AI calls `mcp_question` mid-turn,
  the bridge surfaces it as a Telegram inline keyboard. Tap to answer. The chosen
  label flows back to the AI as the user response.
- **Per-chat rate limiting**: configurable burst + sustained limits to prevent
  runaway loops or accidental flooding.
- **Structured logging**: NDJSON live tail (`LOG_FILE_PATH`) plus persistent
  SQLite event store (`LOG_DB_PATH`) for historical debugging. Operator-grade
  observability without external dependencies.
- **Single-user, self-hosted, MIT-licensed**: each user runs their own instance
  with their own bot token. No SaaS, no public bot, no SLA, no roadmap. Read
  the README for the philosophy.

### Security

- Filesystem boundary checks for Claude project folder decoding (#56).
- Symlink traversal rejection in `decodeClaudeFolder` — blocks symlinks during
  `readdir` traversal so a malicious symlink inside `~/.claude/projects/` can't
  escape the home directory boundary even though the resolved string check would
  pass. Includes defense-in-depth via `fsp.realpath` final check and $HOME
  realpath resolution at startup to handle the edge case where $HOME itself is
  a symlink (#62 / PR #109).
- Token redaction at the presentation boundary for bearer tokens, JWTs,
  `github_pat_*`, and modern GitHub App credential formats (#97).
- Session title redaction at the presentation boundary to prevent PII / secret
  leakage in Telegram replies (#99).
- No bot secrets ever passed to spawned CLI subprocesses.
- Per-user authorization gate via `TELEGRAM_ALLOWED_USER_ID` rejects unknown
  Telegram user IDs before any command handling.
- **Extended credential redaction coverage** (pre-public hardening pass): the
  legacy `sk-[A-Za-z0-9]{20,}` pattern failed on modern dash-separated keys
  like `sk-ant-api03-...`, `sk-proj-...`, and `sk-svcacct-...` because the
  quantifier stopped at the first internal dash. Added dedicated patterns for
  Anthropic, OpenAI project/service-account, GitHub server/refresh/oauth
  (`gh[pusro]_*` unified), GitLab (`glpat-`), HuggingFace (`hf_`), Supabase
  (`sb[pvs]_`), GCP service-account `"private_key"` JSON, and bare `Bearer`
  tokens. Empirically verified with `node -e` regression tests in
  `test/log-redaction.test.js`. Found by a pre-public tripartite security
  review.
- **Command shadowing fix in text-message handler**: the plain-text handler
  previously used `text.startsWith("/")` to skip slash commands, which
  silently dropped any user prompt that begins with a forward slash (e.g.
  absolute paths like `/Users/foo/repo/file.js has a typo`, or any question
  about filesystem paths). Replaced with the authoritative Telegram
  `bot_command` entity at offset 0 — the same classifier already used in
  `rate-limit-middleware.js` and the `pendingCustomPath` drain. Found by the
  pre-public tripartite review. This was also a functional/UX blocker for
  coding queries about paths.
- **Slash-command cleanup middleware extended**: the middleware that clears
  `messageBuffer` and `pendingPermission` on incoming commands now also clears
  `pendingCustomPath`, so that after a sequence like *"Custom path... → /detach"*
  the next plain-text message is not silently consumed as a workspace path.
  The command detection uses the `bot_command` entity at offset 0 (not the
  prefix check), matching the rest of the codebase. Found by the pre-public
  tripartite review.

### Reliability

- **Compare-and-set threadId updates** to prevent stale binding clobber from
  concurrent turns (#96).
- **`pendingQuestions` Map TTL**: per-entry `setTimeout` prevents memory leak
  from abandoned inline keyboard questions (#101).
- **`inFlightChats` guard in `q:` callback handler**: prevents concurrent turn
  double-submission when the user taps a stale inline keyboard mid-turn (#102).
- **Sentinel workspace rejection** at scanner, DB cleanup migration, list filter,
  and bind layers — blocks the `/unknown` and `.` workspace placeholders that
  legacy Gemini/Qwen storage formats produce when the original workspace path
  cannot be recovered (#106).
- **Custom-path strict parser + fs validation** in the "Custom path..." workspace
  picker: tilde expansion (`~/repo` → `$HOME/repo`), per-user tilde reject,
  relative path reject, non-existent path reject. Same hardening also applies to
  `/new <path>` inline commands via shared `resolveDirectory` (#108).
- **Command shadowing fix** in the `pendingCustomPath` flow: when the user clicks
  "Custom path..." and then changes their mind by typing a slash command like
  `/sessions` instead of a path, the bridge now detects the command via
  Telegram's `bot_command` entity at offset 0 and routes it to the appropriate
  command handler instead of trying to validate it as a filesystem path. Closes
  a UX trap where the user would otherwise get a confusing "Path does not exist:
  /sessions" error. Found independently by both pre-release reviewers (#113 /
  PR #114).
- **Close stdin on all exec-based CLI backends**: `child_process.execFile` call
  sites for Codex, Copilot, Gemini, and Claude were spawning subprocesses without
  specifying a `stdio` option, causing them to inherit the parent process's
  stdin. Claude Code exposed the latent bug by emitting a "no stdin data received
  in 3s" warning and hanging on session resume — other backends had the same
  pattern without a visible symptom. Fixed by passing `stdio: ['ignore', 'pipe',
  'pipe']` to all four backends so subprocess stdin is explicitly closed while
  stdout/stderr are still captured for output parsing. Found during pre-release
  testing of Claude resume (#111 / PR #116).
- **Telegram message fragment coalescing**: Telegram silently splits messages
  longer than 4096 characters into multiple consecutive sends. Before this fix,
  the bridge forwarded each fragment as a separate backend turn, causing the
  AI to respond mid-prompt and misinterpret later fragments. Fixed with a
  boundary-gated per-chat debounce buffer: a buffer opens only when an incoming
  message's raw length is exactly 4096 (Telegram's split boundary, a reliable
  signal that more fragments are on the way). Short standalone messages bypass
  the buffer entirely and dispatch immediately, so normal conversation feels
  instant. Tunable via `BRIDGE_MESSAGE_DEBOUNCE_MS` env var (default 1500ms,
  set 0 to disable). Reported during live beta testing.
- **Schema invariant regression test** (#61): every `ALTER TABLE ADD COLUMN`
  migration in `src/db.js` must also appear in the canonical `CREATE TABLE` block.
  Locked by `test/db-schema-invariant.test.js` so drift cannot land silently.

### Performance

- **Cache `kilo_messages_seen_at`** to skip O(N) `json_extract` user-turn count
  on every 5-second scan tick (#71). The cache is correctness-preserving:
  any mismatch on `time_updated` triggers a recompute.
- **Per-scan `readdirCache`** in `decodeClaudeFolder` to avoid redundant
  `fsp.readdir` calls on shared path ancestors during a single scan invocation
  (#68).
- **Hash registry for `callback_data`** (#94): Telegram caps callback data at
  64 bytes, which fails for typical project paths. The bridge registers each
  path under a 12-hex-char hash and stores only the hash in inline buttons.

### Tests

- **486 passing tests** across unit, integration, and regression layers.
- 1.6× test/source LOC ratio.
- Full CI on Node 22 (`test (22)` workflow runs on every push and PR).
- Schema invariant regression test prevents migration drift.
- Mock module isolation pattern for handler tests using
  `node --experimental-test-module-mocks`.

### Documentation

- Canonical doc set: `README.md` (includes the project pitch),
  `ARCHITECTURE.md`, `OPERATIONS.md`, `API_CONTRACT.md`, `DECISION_LOG.md`,
  `IMPLEMENTATION.md`.
- `OPERATIONS.md` tracks active technical debt with explicit
  trigger / blast-radius / fix / done-when entries for each item.
- `DECISION_LOG.md` captures architectural decisions with rationale and
  alternatives considered.

### Known limitations

- **Single-user design**: each user runs their own self-hosted instance with
  their own bot token. No multi-tenant support, no public bot.
- **macOS-first**: `launchctl` examples in `OPERATIONS.md`, `zsh` shell defaults.
  Tested on Linux but not packaged for it.
- **Active debt items** (see `OPERATIONS.md` for the full list): Copilot Agent
  PRs require `--admin` bypass for merge, `pendingCustomPath` Map has no TTL,
  `parseCreateTableCols` parser does not handle multi-line column definitions.

### Acknowledgments

Thanks to the Copilot coding agent for handling the long tail of mechanical
fixes, and to the tripartite review pattern (security + correctness + architecture
focused reviewers) for catching the bug classes that would otherwise have
shipped silently. Special mention to the integration-assumption bug class:
the most common escape mechanism, now tracked explicitly in every Step Gate.

Thanks to [@RaspberriesinBlueJeans](https://github.com/RaspberriesinBlueJeans) and
[@Matita_Pereira](https://github.com/Matita_Pereira) for running the bridge live on their
own machines and filing the first real-world bug reports — exactly the feedback loop
that makes an open source project actually useful.

[Unreleased]: https://github.com/legate-dev/telegram-ai-bridge/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/legate-dev/telegram-ai-bridge/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/legate-dev/telegram-ai-bridge/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/legate-dev/telegram-ai-bridge/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/legate-dev/telegram-ai-bridge/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/legate-dev/telegram-ai-bridge/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/legate-dev/telegram-ai-bridge/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/legate-dev/telegram-ai-bridge/releases/tag/v0.3.1
