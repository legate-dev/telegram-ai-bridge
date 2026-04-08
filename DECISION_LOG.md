# Decision Log — Telegram Bridge

Newest first. Append-only.

> **Note on historical references.** This log carries forward decisions made
> during an internal pre-release development phase. PR numbers and commit
> short-hashes cited inline refer to that prior private repository and are
> preserved here as narrative traceability for each decision's rationale —
> they do not resolve to issues or commits in this public repository.

---

## 2026-04-08: Rate-limit at coalesced turn, not per Telegram update fragment

**Context:** PR #129 promoted the per-user rate limiter to a global grammY middleware (closing Risk R3 from the health check). The middleware runs per Telegram update, which is correct for commands and callback queries, but problematic for text messages: Telegram splits messages longer than 4096 characters into consecutive fragments, and the bridge's `messageBuffer` logic coalesces those fragments into a single logical turn before dispatching to a backend. With the new middleware running per-update, a single 12288-char user message would consume 3 rate-limit slots instead of 1. `copilot-pull-request-reviewer[bot]` flagged this as a low-confidence comment on `src/message-handler.js:367` during the #129 review — and the concern was correct.

A related architectural question surfaced during the fix: how do we distinguish bot commands from non-command text? The naive approach is `text.startsWith("/")`, but Unix paths like `/Users/foo/repo` would be misclassified as commands, which matters for the bridge because the custom-path flow does accept absolute paths as text input.

**Decision (semantics):** Plain text messages **bypass** the rate-limit middleware entirely and are rate-limited inside `processTextMessage()` after fragment coalescing. Commands and callback queries remain rate-limited per-update. One logical turn = one slot, always.

**Decision (command detection):** Use Telegram's **`bot_command` entity at offset 0** as the authoritative classifier (`entities.some((e) => e.type === "bot_command" && e.offset === 0)`), not `text.startsWith("/")`. This is the same pattern already used in `src/message-handler.js:600-601`, so the rate-limit middleware now aligns with an existing convention instead of reinventing command detection.

**Rationale:**
- Fairness: a user sending a long reply should not be penalised for Telegram's 4096-char split, which is an implementation detail of the transport layer the user does not control
- Correctness: `startsWith("/")` would incorrectly rate-limit path-like text inputs per-update, and in the bridge's custom-path flow that is a real interaction pattern (user types `/Users/foo/repo` to set a workspace)
- Consistency: reusing `bot_command` entity matches an existing convention in the codebase, so a future reader finds command detection in exactly one place to look at
- Low single-user impact but high future impact: in single-user mode, the worst case was being rate-limited slightly earlier on very long messages. In a hypothetical multi-user mode (explicitly out of scope but plausible for forks), the unfairness would become structural

**Alternatives considered:**
- **Counter-based deduplication inside the middleware** — have the middleware detect whether the current update is part of an ongoing coalesce window and skip consuming a slot if so. Rejected because the coalescing logic already knows exactly when a "turn" is complete, so routing the decision to that layer is simpler and more correct
- **Keep the middleware per-update and declare the fragment inflation "acceptable debt"** — rejected because the fix is cheap, the regression surface is small, and writing it down as tech debt would guarantee the bug eventually gets shipped to a multi-user fork without anyone noticing

**Implementation:** PR #134 (`27bb007`). Plain text bypass in `rate-limit-middleware.js`, `checkRateLimit` call moved to `processTextMessage`, 3 new tests in `test/rate-limit-coalescing.test.js` covering (a) 1 short message → 1 slot, (b) 1 long 3-fragment message → 1 slot, (c) N short messages → N slots.

---

## 2026-04-08: Kilo `/permission` HTTP round-trip — Blocker 2 fix for the policy/sandbox gap trio

**Context:** The v0.3.0 health check tripartite review flagged Blocker 2 as the bridge being "blind to Kilo's runtime permission engine". Before the fix, `GET /permission` was never called: users never saw approval prompts for bash/edit/write tool calls that Kilo wanted to run, and the session would either silently auto-approve in unsafe mode or hang indefinitely in safe mode. Three distinct bugs conspired to produce this state:

1. `kilo-client.js:527` `_checkForPendingQuestion` filtered only `tool === "question"`, missing all `requires_approval` states
2. `format.js:46-48` `extractAssistantText` filtered only `part.type === "text"`, silently dropping all tool results including denials the user could have seen
3. `kilo-client.js:317` `lastSuccessfulPollAt` reset on every "busy" response, so the 2-minute stale timer never fired — only the 30-minute absolute timeout could save a stuck turn

**Decision:** Implement the full Kilo permission round-trip by wiring the bridge to Kilo's native HTTP permission API: `GET /permission` to poll, `POST /permission/:id/reply` with reply values `once | always | reject` to respond. Surface permission requests to Telegram via an inline keyboard (`Allow once`, `Always allow`, `Deny`), receive the user's choice via callback query, POST it back to Kilo, and resume the paused server-side turn — all without aborting the turn (Kilo holds it while we talk to the user).

**Architectural details (the important ones):**

- **Server-wide queue requires session filtering.** `GET /permission` returns ALL pending permissions for the project, not just our session's. `_checkForPendingPermission(sessionId)` MUST filter by `req.sessionID === sessionId` before returning — any unfiltered consumer would cross-react to other sessions' permission requests. Commented explicitly in the code and locked by test `_checkForPendingPermission returns null when pending exists but ALL entries have a different sessionID`.

- **No-window lock pattern (`inFlightChats.add` before `deletePendingPermission`).** In the callback handler, the guard transition from "pending permission" to "in-flight resume" must happen without a window where both guards are absent simultaneously. The order is: (1) check canResume, (2) `inFlightChats.add(chatKey)` if canResume, (3) `deletePendingPermission(chatKey)`, (4) await `replyToPermission`, (5) await `resumeTurn`, (6) `inFlightChats.delete(chatKey)` in finally. Inverting steps 2 and 3 opens a race where a concurrent Telegram message can start a new turn against the paused backend state. This is explicitly commented in the code: *"Lock inFlightChats before releasing the pending-permission guard so there is never a window where both guards are absent simultaneously."*

- **Double-tap guard is scoped to the pending entry, not global.** The `pending.replying` flag prevents concurrent taps of the same permission button during the in-flight network POST, but it is a per-entry flag, not part of `inFlightChats`. This keeps the lock surgical: a user tapping the same button twice is blocked, but an unrelated concurrent turn on another chat is unaffected.

- **Telegram callback answered before the network POST.** Telegram enforces a ~10 s deadline to respond to callback queries, and Kilo's `POST /permission/:id/reply` can be slow. The handler calls `answerCallbackQuery` with an optimistic label ("✅ Allowed once") *before* the network round-trip — the actual network failure, if any, is surfaced via a follow-up `ctx.reply()` after the POST rejects.

- **Delete only after successful reply.** `deletePendingPermission(chatKey)` is called inside the try block *after* `replyToPermission` succeeds. If the POST throws, the pending entry survives and the user can retry by tapping the button again. Locked by test `pending permission entry is NOT cleared when replyToPermission throws`.

- **Nested permission handling.** If `resumeTurn` returns another `{ permission }` (a Kilo tool chaining permissions during resume), the handler recursively surfaces it via `surfacePermission`. The next `perm:` tap resumes again. This is intentional and tested — without it, a chain of permissions would leave the user stuck after the first.

- **Question fallback after resume.** If `resumeTurn` returns `{ question }` (a mid-resume `mcp_question`), the handler calls `surfaceQuestion` the same way the normal `sendMessage` path does. Silently ignoring this would leave the session stuck. Tested.

- **TTL as defense in depth.** `pendingPermissions` entries have a TTL (`BRIDGE_PENDING_PERMISSION_TTL_MS`). The `replying` flag and the callback handler's stale-check cover active races; the TTL catches the case where the user never responds at all.

- **Log redaction.** Permission poll logs use `pattern_count` (the count only), not `patterns` (the raw array), because patterns can contain sensitive command strings and file globs. Error logs in the permission flow use `redactString()` on `String(err)` and on user-facing `err.message` — consistent with the rest of the codebase.

- **Slash-command middleware cleanup.** `/abort` and `/detach` call `clearPendingPermission(chatKey)` in addition to `clearMessageBuffer(chatKey)`. Without this, a stale pending permission would block new turns via `hasPendingPermission` until its TTL fires. Same pattern as `clearMessageBuffer`.

**Alternatives considered:**
- **Poll every tick** (instead of every `permissionCheckEveryNPolls = 2`) — rejected because the poll adds HTTP latency and the 2-tick cadence already catches permission requests within a few seconds
- **Abort the paused turn on permission request and restart after reply** — rejected because Kilo holds the turn server-side with full context (thinking tokens, tool call chain, conversation history). Aborting and restarting would lose state and cost tokens
- **Store pending permissions in SQLite** (instead of in-memory `Map` with TTL) — rejected because the permission lifetime is seconds-to-minutes, the bridge is single-user, and SQLite would add sync overhead without practical benefit; plus the TTL semantics are simpler in memory
- **Reject by default if user doesn't respond within T** (instead of TTL that leaves the entry stale until cleared) — rejected because a pending permission that times out silently is worse UX than one that stays visible as a reminder; Kilo's own timeout on the server side eventually kicks in anyway
- **Use Telegram reply-to-message pattern instead of inline keyboard** — rejected because tapping a button is faster on mobile and leaves a cleaner UI trail

**Implementation:** PR #131 (`5c81288`). The initial implementation surfaced 13 review threads from `copilot-pull-request-reviewer[bot]` (all addressed), then 4 additional minor concerns flagged in a builder review (addressed in commit `01a57f7 fix: address concerns 1-4 in kilo permission flow`). Final state: 15 review threads all resolved, 20 tests in `test/kilo-permission.test.js` (753 lines), `API_CONTRACT.md` updated with the new `{ permission, messageCountBefore }` shape and the "caller must not start a new turn" invariant.

---

## 2026-04-08: Apply Copilot reviewer suggestions via `gh` CLI pipeline + `resolveReviewThread` GraphQL mutation

**Context:** During PR #125 review, `copilot-pull-request-reviewer[bot]` left 4 suggestion blocks on `src/backends.js` (one per exec backend: Codex, Copilot, Gemini, Claude). The natural manual workflow is to click "Commit suggestion" on each, but the goal of the session was wider: understand empirically what API calls are needed to replicate the full "accept suggestion + resolve thread" flow, because that blueprint is a direct dependency for future bridge PR-tooling features (`/pr accept N` from chat).

Initial hypothesis was that GitHub MCP server would expose dedicated tools (`apply_suggestion`, `resolve_review_thread`). Neither tool exists in the MCP — the first is UI-only (not even a documented REST endpoint), the second (`resolveReviewThread`) exists only as a GraphQL mutation. An additional surprise: the `github-pull-request_resolveReviewThread` MCP tool **does** exist, but it is exposed by the VS Code `GitHub Pull Requests and Issues` extension under the `vscode` server namespace, not under `github`. This is easy to miss because the naming suggests otherwise.

**Decision:** For applying Copilot reviewer suggestions programmatically, the canonical pipeline is `gh` CLI + GraphQL:

1. `git stash push -u` (protect WIP) → `gh pr checkout N` (clean slate on the PR branch)
2. `gh api graphql` to fetch review threads with their `threadId`, `isResolved`, `isOutdated`, and suggestion `body`
3. Read the target file contexts (the 3–5 lines around each suggestion) to verify the fix is auto-contained or needs adaptation
4. Apply the edits locally (`mcp_edit` or any editor)
5. `npm test` to verify no regression
6. `git commit + push` to the PR branch (the commit can be manual or `--author=` attributed; GitHub does NOT auto-mark the suggestion as committed, that part is UI-only)
7. `gh api graphql` with a **batch mutation** using GraphQL aliases to call `resolveReviewThread` on all N threads in a single round-trip
8. Verify final state, approve, merge

**Empirical findings from the PR #125 run (the actual test of the hypothesis):**

- **Auto-outdate works.** After pushing the fix commit, GitHub correctly marked the affected thread as `isOutdated: true` (because the cited lines were modified) while the three other threads at different line numbers had their `line` field automatically shifted by the row delta (+2). This is server-side line tracking, not client-side.
- **Auto-resolve does NOT work.** `isResolved` stayed `false` after the commit. GitHub does not have a server-side mechanism to link "this commit applied that suggestion" — the "Commit suggestion" UI button's auto-resolve is client-side orchestration (the JS sends a `resolveReviewThread` mutation right after the commit). Replicating this behavior from API requires the explicit mutation call.
- **No second round of reviewer bot.** Our two consecutive commits on PR #125 (`d6b358a` Codex fix + `ae5a32a` batch fix for the other three backends) did NOT trigger a fresh `copilot-pull-request-reviewer[bot]` review, because the repo has `copilot_code_review` ruleset configured with `review_on_push: false`. This is important for the bridge design: the feared "valzer of reviews" doesn't happen as long as that flag stays false.
- **Batch mutation via GraphQL aliases.** Chiudere N thread in una sola chiamata è banale:
  ```graphql
  mutation {
    t1: resolveReviewThread(input: { threadId: "PRRT_..." }) { thread { isResolved } }
    t2: resolveReviewThread(input: { threadId: "PRRT_..." }) { thread { isResolved } }
    t3: resolveReviewThread(input: { threadId: "PRRT_..." }) { thread { isResolved } }
  }
  ```
  Latency: <300 ms for 3 threads in a single round-trip.
- **`copilot_code_review` ruleset blocks merge even with human approval.** The rule requires a Copilot review on the current commit, and `review_on_push: false` means it never auto-runs. Trade-off: single-user setups need `--admin` bypass for this ruleset, which is accepted as the operating mode (Copilot Agent PRs already go through `--admin` for the same reason).
- **"Suppressed for low confidence" comments are invisible to the standard reviewThreads GraphQL query.** Discovered on PR #129: a low-confidence concern about fragment counting was visible in the GitHub UI but returned 0 threads from the API. Implication for the future bridge: auto-check-pr must use an alternative endpoint to capture low-confidence comments, or accept they're UI-only.
- **GitHub Actions workflow approval for first-time contributors on internal branches.** The documented `POST /actions/runs/{id}/approve` endpoint is fork-only (returns 403 "This run is not from a fork pull request"). For internal branches blocked by `action_required`, the workaround is `POST /actions/runs/{id}/rerun` — GitHub treats an explicit rerun from a maintainer as implicit approval. Verified empirically on PR #131 run `24111122983`.

**Rationale:** The `gh` CLI + GraphQL pipeline is equivalent to clicking "Commit suggestion" N times, but reproducible, batch-capable, and auditable. It is the direct blueprint for the future bridge `/pr accept N` command. Going through the GitHub MCP server adds zero value over `gh` for this task (REST-only, no `resolveReviewThread`, no apply-suggestion), and the MCP server's PAT can even be stale while `gh` CLI works fine (as happened during the session).

**Alternatives considered:**
- **Click the UI manually for each suggestion** — rejected because the goal was explicitly to understand the programmatic path
- **REST `PUT /repos/.../contents/...`** to push the commit — rejected in favor of standard git workflow because the REST approach requires base64 encoding the full file and computing SHA, while `gh pr checkout` + local git is more natural and the commit is identical
- **Write a wrapper script in the bridge repo** — deferred; the raw `gh` commands are the specification, and a wrapper is a follow-up if/when the bridge exposes this as a chat command
- **Use the `github-pull-request_resolveReviewThread` tool from the vscode MCP server** — valid alternative, but requires enabling 3 additional vscode MCP tools in the kilo profile. The `gh api graphql` path works identically and has zero setup cost

**Implementation:** Proven empirically on PR #125 (4 suggestions + 1 batch + 4 resolveReviewThread calls, all via this pipeline). No code changes — this is a workflow decision, not a code decision.

---

## 2026-04-07: First public release tagged as v0.3.0

**Context:** The project has been in active private development, accumulating 118 commits across 60+ pull requests. The `package.json` was bumped to `0.2.0` in PR #73 (`fd8b953`) as part of "first public release prep" but the corresponding git tag was never actually created — the release was stalled while we kept polishing. We are now ready to ship the first real public release and need to choose a version number.

**Decision:** Tag the first public release as **`v0.3.0`** (skipping `v0.2.0` entirely) and bump `package.json` to match.

**Alternatives considered:**

1. **Tag retrospectively as `v0.2.0`, then bump and tag `v0.3.0`** — historically accurate (the `package.json` was 0.2.0 from PR #73 onward) but creates two tags from the same commit window, both pointing at "first release". Confusing for anyone browsing the releases page later. The 18 commits between `fd8b953` and main HEAD are not really a separate "release cycle" — they're just continued development that happened to finish before we shipped.

2. **Tag as `v0.0.1` or `v0.1.0`** — the conventional "first release" numbering for greenfield projects. Rejected because it grossly misrepresents the maturity of the codebase: 4.7k LOC source, 7.7k LOC tests, 486 passing tests, full CI, structured logging, multi-CLI backend support, hardened security review, well-documented. A 0.0.1 tag would be borderline dishonest.

3. **Tag as `v1.0.0`** — the "I'm confident this is stable" signal. Rejected because we're not making API stability commitments yet (the `API_CONTRACT.md` is still evolving), single-user mode is the only supported configuration, and the project is explicitly framed as "personal project, no SLA, no roadmap". `v1.0.0` would imply commitments we are not making.

**Rationale:** `v0.3.0` honors the actual development history (`package.json` was already 0.2.0, the new release adds substantial functionality on top), communicates "this is meaningful but not yet at v1.0 stability", and aligns with `DECISION_LOG.md` references that already mention `v0.3.0` as the current target (see the 2026-04-06 security hardening entry below: "post-v0.3.0").

**Scope of v0.3.0** (full breakdown in `CHANGELOG.md`):
- All session-discovery and binding work (PRs #4 through #59)
- Cleanup overhaul with deterministic ownership (#59)
- Tripartite review cascade fixes (#94 through #103)
- Bridge-managed Kilo daemon lifecycle (#103, #105, #107)
- Sentinel workspace rejection across all layers (#106)
- Custom-path UX hardening (#108)
- Symlink traversal hardening in Claude folder decoding (#62 / PR #109)
- Command shadowing fix in custom path flow (#113 / PR #114)
- `execFile` stdin close on all exec-based backends (#111 / PR #116)
- Telegram message fragment coalescing (#112)

**What this release does NOT include** (intentionally deferred):
- Time-Bounded Operation Mode — Tier 1 of the security hardening roadmap (`v0.4.x`)
- Passphrase 2FA via Telegram — Tier 2 (`v0.5.x`)
- Multi-user mode — explicitly out of scope for the project's life cycle

**Done when:** `git tag -a v0.3.0` annotated tag exists on `main`, GitHub release published with notes derived from `CHANGELOG.md`, `package.json` reflects 0.3.0.

---

## 2026-04-06: Security hardening roadmap (3-tier, post-v0.3.0)

**Context:** The tripartite full-project review (architecture/correctness/security) flagged a security blocker B1 from the security focus (Codex review): `sanitizedEnv()` in `src/backends.js` removes only 4 bridge-specific keys and forwards the rest of `process.env` to CLI subprocesses (Codex, Copilot, Gemini, Claude), which run with `--allow-all-tools` / `--permission-mode bypassPermissions`. The reviewer proposed an allowlist with default empty + opt-in via `BRIDGE_PASSTHROUGH_ENV`, framed as "stop leaking host credentials".

**Initial reading (overcorrected):** I initially accepted the framing and started designing increasingly elaborate fixes — allowlist with default `PATH+HOME`, AES-SQLite secret storage, macOS Keychain integration. All of these were based on the implicit assumption that *the bridge mediates provider API keys for the CLIs*.

**The recalibration:** That assumption is wrong. The bridge owns exactly 4 secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`, `KILO_SERVER_USERNAME`, `KILO_SERVER_PASSWORD`). The provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GEMINI_API_KEY`) belong to the CLIs and live in their own auth files (`~/.codex`, `~/.claude`, etc.) or env, by user choice. **The bridge has no business filtering them.** And even if it did, an attacker who controls a CLI session via `--allow-all-tools` can simply `cat ~/.zshrc` or read auth files directly — env sanitization adds zero defense theater against this.

**Decision (B1 itself):** B1 is **demoted from Blocker to Documentation**. The fix is docs-only:
- `README.md` security section rewritten with the honest threat model
- `SECURITY.md` adds a `## Threat model` section explicitly listing what is and isn't protected
- `.env.example` adds a CRITICAL SECURITY comment block above `TELEGRAM_BOT_TOKEN=` ("treat it like an SSH key")
- `src/backends.js` `sanitizedEnv()` gets an extended docblock so future reviewers don't repeat the recalibration
- This DECISION_LOG entry captures the recalibration story so the same conversation doesn't have to be repeated next time

Zero modifications to runtime code. The 4-key `REDACTED_KEYS` set is correct as-is.

**Decision (the actual problem):** The real problem is the *blast radius of a compromised Telegram bot token*. The bridge runs CLIs in unattended-permission mode by design (that's the value prop: long Kilo sessions, multi-step Codex turns from a phone), so anyone holding the token has arbitrary code execution on the host. Adopt a **3-tier security hardening roadmap** post-v0.3.0:

### Tier 1 — Time-Bounded Operation Mode (TBOM) — `v0.4.x`

The bridge operates only within a time window that the user must renew **from the local terminal** of the host machine.

- File `~/.bridge/active-until` with epoch timestamp
- npm scripts: `npm run renew [duration]`, `npm run standby`, `npm run status`
- Telegram command `/standby` as kill switch (the operator can mute the bridge from their phone if they suspect compromise; renewal still requires local access)
- Bridge middleware checks `active-until` before every message; expired → standby reply
- ~80 lines of code, zero crypto, cross-platform (file I/O only)

**Threat coverage:** passive bot token leak (commit, log, screenshot), bridge-left-on-overnight, kill-switch reaction. Default-closed after reboot (auto-start brings the bridge up in standby state).

**Does NOT protect against:** compromise during the active window, filesystem access on the host (attacker can edit `active-until` directly).

### Tier 2 — Passphrase 2FA via Telegram — `v0.5.x`

When TBOM expires, the bridge can be unlocked from Telegram itself by replying with a passphrase.

- Env var `BRIDGE_2FA_PASSPHRASE_HASH=<bcrypt hash>` (the plaintext passphrase lives only in the operator's memory)
- On expiry, bot replies "🔒 Locked. Reply with passphrase to unlock for Nh."
- Operator replies, bridge `bcrypt.compare`, on match: unlock and (via Telegram API `deleteMessage`) remove the passphrase message from chat
- ~100 lines of code, depends on Tier 1 merged

**Threat coverage:** Tier 1 + leaked `.env` file with bcrypt brute-force resistance + bot-token-only leak (attacker doesn't know the passphrase).

**Does NOT protect against:** weak passphrase + filesystem compromise, attacker who can both read the bot token and observe the operator typing the passphrase.

### Tier 3 — WebAuthn / device-signed renewal (PWA) — `v0.6.x` (design exploratory)

TBOM renewal via Secure Enclave / Keystore signature, hardware-backed and phishing-resistant.

- PWA single-page (statically hostable, even from GitHub Pages)
- Enrollment: `navigator.credentials.create()` → key generated in Secure Enclave (iOS) / Keystore (Android), public key sent to bridge via Telegram channel
- Renewal: bridge generates challenge → sends as Telegram message with PWA link → operator opens, biometric (Face ID / Touch ID / pattern) signs the challenge in the enclave → signature returned to bridge → bridge `crypto.verify` with stored public key
- ~500 lines of code + frontend, requires WebAuthn relying-party setup
- Design captured 2026-04-06 during the threat model recalibration session

**Threat coverage:** Tier 2 + phishing resistance (the private key is hardware-backed and never leaves the enclave; the only path to abuse it requires bypassing the enclave hardware).

**Does NOT protect against:** simultaneous compromise of the operator's phone (with biometric bypass or attacker knowing the operator's biometric) AND the bridge host. Edge-case threat model.

### Rejected alternatives

- **Native iOS/Android app for per-message signing.** Kills the project's UX core ("Telegram as universally-accessible UI"). 10× the maintenance of the bridge itself. Two platforms. App store dance. Doesn't work from desktop. Non-starter.
- **Telegram Mini Apps.** Webviews; do not have access to the Secure Enclave or Keystore. Confirmed in Telegram docs.
- **Companion app for every command, not just renewal.** Same UX-killing app switching at the per-message level. Tortura.
- **AES-SQLite for `TELEGRAM_BOT_TOKEN` storage with master key from a file.** Defense theater: the master key file becomes the new `.env`. The only versions that work require Keychain (macOS-only) or libsecret (Linux-only), which are exactly what Tier 3 already covers in cross-platform form via WebAuthn.
- **Pure allowlist for `sanitizedEnv()` with default empty.** Already covered above: based on the wrong assumption that the bridge owns provider API keys.

### Status

Roadmap captured. v0.3.0 ships **only** the docs-only B1 fix. Tier 1 and Tier 2 have GitHub issues parked (label `roadmap`, NOT assigned to Copilot Coding Agent), ready to be dispatched post-release when desired. Tier 3 has no issue yet and requires a dedicated design session before it's spec-ready (PWA hosting strategy, enrollment UX, key rotation, recovery flow, browser support matrix). Each tier is opt-in and backward-compatible — the default behavior (no opt-in) remains the current model: bot token in `.env` chmod 600.

**Why the staging:** each tier closes a different threat with progressively higher complexity. Tier 1 alone closes ~80% of the realistic risks (passive token leak) at a fraction of the cost. Shipping Tier 1 first lets the rest of the roadmap compete for attention with other priorities; the design captured here means we never have to re-derive it from scratch.

---

## 2026-04-06: Proactive push via dedicated Telegram bot (not bridge extension)

**Context:** The bridge is currently request-driven — nothing happens unless the operator sends a Telegram message. A real need emerged for proactive push scenarios: cron-triggered morning briefings, monitoring alerts, CI notifications, webhook bridges from n8n/GitHub/Stripe, and ad-hoc static notifications ("build failed"). Initial proposal was to extend the bridge with a local HTTP inject endpoint (`POST /inject/:chatId`) that would accept prompts from external processes and route them through the existing backend pipeline. An implementation PR (#76, produced by Copilot Agent to the spec in closed issue #75) sits archived on `copilot/add-http-endpoint-for-push-notifications` — 730 lines including 14 tests, all spec constraints respected.

**Decision:** Do **not** extend the bridge. For proactive push, use a **second Telegram bot** registered via BotFather, dedicated purely to outbound notifications, with zero code in this codebase. Optionally send to a private Telegram *channel* instead of a 1:1 bot chat, for better mute granularity and visual separation from the bridge conversations. Document the pattern in `README.md` and ship copyable example scripts under `scripts/examples/`. The bridge stays single-purpose: Telegram ↔ CLI sessions, request/response only.

**Rationale:**

| Dimension | Inject endpoint (PR #76) | Second bot (chosen) |
|---|---|---|
| New code in bridge | ~730 lines (server, handler, tests, docs) | **0 lines** |
| Files modified in bridge | 9 | 0 (docs only) |
| Tests to maintain | 14 new | 0 new |
| Coupling with `chat_bindings` | High (must read, replicate backend call, handle error surfacing) | **Zero** |
| Survives bridge crash | No | **Yes** (independent pipeline) |
| Supports non-AI static notifications (build failed, disk full, GitHub event) | No (always goes through CLI backend) | **Yes** (raw curl to Telegram API) |
| Auth model | Custom shared secret + localhost-only | Telegram bot token (battle-tested) |
| Comprehensible to a random sysadmin | Custom endpoint to learn | Standard Telegram Bot API, universal |
| Can group notifications by category (Telegram channels) | No natively | **Yes** (channels are a native Telegram feature) |
| Failure mode | Bridge down → push dead | Push path untouched by bridge failures |

The architectural win is **separation of concerns taken seriously**: the bridge does one thing (Telegram ↔ CLI sessions, request/response) and lets the operator compose Telegram idiomatically for adjacent cases. This is a positive design choice, not a limitation, and it actually strengthens the bridge's pitch ("small, transparent, single-purpose") instead of bloating it.

The `bash + curl + Telegram Bot API` combination already covers all the required use cases without writing or maintaining a single extra line of bridge code:

- **Static push**: one-line curl from any script, CI, webhook
- **AI-filtered push**: bash wrapper that calls `claude -p` / `codex exec` / etc, captures the result, and curls it only if non-empty (native "notify only if meaningful" filter)
- **Context-aware push from arbitrary automation**: any workflow that can produce text can push it — no session binding required

**Bonus insight — Telegram channels over 1:1 chats:** Instead of pointing the push bot at a direct chat with the operator, point it at a private Telegram *channel* (broadcast unidirectional). The operator subscribes to the channel from their phone. This gives: granular mute per category (silence `Build Alerts` during a meeting without muting the main bridge conversation), dedicated scroll history, clean forwarding, and the ability to add more push sources (other scripts, monitoring tools) to the same channel without refactoring. This is the pattern Sentry, GitHub, Datadog and others use for their Telegram integrations.

**Alternatives considered:**

- **Inject endpoint HTTP (PR #76, now archived)** — Clean implementation, all spec constraints rightly rejected message-handler.js refactoring, 14 tests, but 730 lines of code to maintain for a use case that 90% of the time is already better served by the second-bot pattern. Rejected as the general-case solution, **preserved on branch `copilot/add-http-endpoint-for-push-notifications` without deletion** as a reference for one specific niche use case that the second-bot pattern does not cover: *"inject a prompt into an existing bound Kilo session while preserving its full conversational context"*. That scenario (e.g. "after the fix we just discussed, verify issue #123 is closed" — must hit the same session that holds the debugging history) is legitimately different and may warrant reviving PR #76 in the future if it becomes a real need. For now, it's speculative and we don't pay for speculative features.
- **WebSocket listener on `kilo serve`** — Would let the bridge watch all session events live and forward them to Telegram. Kilo-only (doesn't work with Codex/Claude/Copilot/Gemini which are child_process), adds reconnect logic, adds state tracking for which sessions to forward. Rejected as too narrow and too complex for the value.
- **Telegram User API (MTProto) from cron** — Authenticate as the user, have the cron send a message to the bot as if it were the user typing. Requires user-level credentials (not bot token), fragile, subject to user-API rate limits, registration is non-trivial. Rejected as wrong abstraction level.
- **Unix socket auth alternative to shared secret (for inject endpoint)** — Would eliminate secret-in-crontab issue, but the underlying inject endpoint is already rejected, so moot.

**Implementation footprint of this decision:** Three example scripts in `scripts/examples/` (`morning-briefing.sh.example`, `notify-on-error.sh.example`, `static-push.sh.example`), a new README section `## Proactive push (optional)` with BotFather setup and curl patterns, this decision log entry. Zero changes to `src/`. Zero new tests. Zero new runtime dependencies. The bridge remains exactly what it was before — the capability for proactive push is added to the operator's toolbox, not to the bridge.

---

## 2026-04-06: Workflow — merge-simulate mandatory + `--admin` bypass for Copilot Agent PRs

**Context:** Stamattina abbiamo dispatchato 5 PR Copilot Agent in batch (#61, #66, #67, #68, #71) per chiudere risk findings emersi dalla tripartite review di PR #59. Tre di queste PR (60% hit rate) avevano problemi invisibili al loro CI di branch ma visibili solo al merge contro main. La rule `REVIEW_REQUIRED` su `main` (branch ruleset moderno, non legacy branch protection) blocca tutti i merge perché Copilot Agent non può self-approvare.

**Decision:**
1. **Merge-simulate mandatory** prima del merge di qualsiasi Copilot PR: `git checkout -b tmp/test-N origin/<branch>` → `git merge main --no-commit --no-ff` → `npm test`. Solo se passa, si procede al merge `--admin`.
2. **`--admin` bypass una-tantum** per ogni Copilot PR fino a quando non sistemiamo la policy upstream. Documentato esplicitamente in ogni commit message della PR mergiata.

**Rationale:**
- Le branch Copilot dispatched in batch sono branchate da uno snapshot di main al momento del dispatch. Se main evolve velocemente (cosa che è successa con #59), il branch accumula drift invisibile: import contracts che non matchano, mock incompleti, conflict textual su righe modificate da entrambi i lati.
- Il CI di branch passa perché il branch è internamente consistente — testa solo se stesso, non l'integrazione con main.
- Esempi reali da stamattina: PR #66 mocka `./src/db.js` con solo `upsertCliSession`, ma main ha aggiunto `reconcileCliSessions` agli import di `cli-scanner.js` → `SyntaxError` solo a merge-time. PR #68 ha conflict textual su `decodeClaudeFolder` signature. PR #71 ha 3 conflict + avrebbe rimosso il fail-closed try/catch di scanKilo.
- `--admin` non è una scelta architetturale, è un workaround. Va sostituito con: (a) auto-rebase via ruleset, oppure (b) escludere `copilot-swe-agent` dalla review rule, oppure (c) CI job che esegue merge-simulate sulla creazione PR.

**Alternatives considered:**
- Lasciare la rule `REVIEW_REQUIRED` invariata e approvare a mano via `gh pr review` con le credenziali dell'umano — rifiutato perché crea un pattern di "io approvo i bot in nome tuo" che non è formalmente pulito.
- Disabilitare la rule `REVIEW_REQUIRED` — rifiutato perché vale per umani, non vogliamo perderla.
- Chiudere le PR Copilot e rifare dispatch dopo ogni merge significativo — costoso in tempo (15+ min per round) e in budget Copilot (1 request fissa per dispatch).

---

## 2026-04-06: Caching layers in CLI scanner — readdir per-scan + Kilo message_count via timestamp invalidation

**Context:** Due hot path nel watcher loop (5 s debounce) facevano lavoro O(N) ridondante:
1. `decodeClaudeFolder` rileggeva `fs.readdir` per ogni componente del path, compresi `/` e `$HOME` che sono shared tra tutte le workspace di Claude (N workspace × D depth = N×D readdir).
2. `scanKilo` rieseguiva `COUNT(*) WHERE json_extract(data, '$.role') = 'user'` su ogni `message` row di ogni sessione Kilo a ogni tick, anche se nulla era cambiato.

**Decision:**
1. **`readdirCache` per-scan in `scanClaude`** (PR #68): `decodeClaudeFolder(folder, readdirCache = new Map())` accetta una cache per-invocation, popolata sui miss. `scanClaude` crea una `Map` prima del loop e la passa a ogni call. Cache è scope-locked alla singola scanClaude — non shared tra scan, per evitare staleness tra tick.
2. **`message_count` cache via timestamp invalidation** (PR #71): nuova colonna `cli_sessions.kilo_messages_seen_at INTEGER`. `scanKilo` legge la cached row prima del count: se `cached.kilo_messages_seen_at === row.updated_epoch_ms`, riusa `cached.message_count` (cache hit). Altrimenti runna un `countStmt` preparato `COUNT(*) WHERE role='user'` per quella sessione sola e aggiorna la cache.
3. **Extended fail-closed `try/catch`** (emergent dal merge #59 + #71): l'integrazione delle due feature ha richiesto di estendere il try/catch interno di scanKilo a wrappare **tutto** il db-touching path (rows query + countStmt prepare + cache lookup loop + sessions.push), non solo la rows query come faceva #59 da solo. Il risultato è strettamente più fail-closed di entrambi: qualsiasi fallimento SQLite anywhere nel path degrada a `ok=false` senza propagare a `refreshKiloMirror`/`scanAll`.

**Rationale:**
- Il caching è invisible quando funziona ed è correctness-preserving quando fallisce (cache miss = ricomputa, no stale read possible).
- L'invalidazione è pessimistica: se Kilo aggiunge un tool-call (role='assistant') a una sessione, `time_updated` cambia anche se il count user è invariato → cache miss → ricalcolo. È sub-ottimale (un ricalcolo non necessario) ma garantisce correctness e non richiede tracking separato.
- Il fail-closed extended emerge dall'integrazione: nessuna delle 2 PR singole arrivava a quel design. È un caso esemplare di "merge come opportunità di miglioramento architetturale" piuttosto che pura combinazione meccanica.

**Alternatives considered:**
- WeakMap per readdirCache (per garbage collection automatica) — rifiutato, le keys sono path string, WeakMap richiede object keys.
- Cache `message_count` shared cross-scan — rifiutato, semplifica zero ma introduce rischi di staleness su crash/restart.
- Hash-based invalidation invece di timestamp — rifiutato, richiederebbe leggere tutto il body del message per hashare → annullerebbe il guadagno di performance.

---

## 2026-04-06: Schema invariant test as drift guard for `src/db.js`

**Context:** Durante il round 2 della tripartite di PR #59, Copilot ha scoperto che la nuova colonna `source` era stata aggiunta via `ALTER TABLE ADD COLUMN` ma omessa dalla canonical `CREATE TABLE cli_sessions`. Funzionalmente innocuo su install fresh (la migration runna immediatamente dopo il CREATE), ma semanticamente divergent: il CREATE TABLE non rappresenta più lo schema reale. Niente nel codebase impediva al pattern di ripetersi.

**Decision:** Aggiungere `test/db-schema-invariant.test.js` che parsea `src/db.js` come stringa (regex non-greedy) ed estrae i column names da ogni `CREATE TABLE` block e da ogni `ALTER TABLE ADD COLUMN`. Asserta che ogni colonna in ALTER esista anche nel rispettivo CREATE. Fault injection validato manualmente: rimuovere `source TEXT,` dal CREATE → test #1 fallisce con messaggio esatto identificando tabella e colonna.

**Rationale:**
- È un meta-test che protegge un'invariante che nessun developer ricorderà di mantenere a mano.
- Costo zero in runtime (test only, source-level parsing).
- Cattura tutti i futuri drift simili, incluso il caso reale che è poi successo: PR #71 ha aggiunto `kilo_messages_seen_at` sia in CREATE che in ALTER — il test passa, ma se Copilot avesse omesso uno dei due lati, lo avremmo intercettato in CI.

**Alternatives considered:**
- Schema versioning system formale (Knex, Prisma, ecc.) — overkill per uno schema che ha 2 tabelle e 3 migrations totali.
- Drop/recreate del DB su ogni avvio in dev — rifiutato perché distruttivo per l'esperienza dev e impossibile in produzione.
- Lint rule custom — più costoso del regex parsing inline.

---

## 2026-04-06: Deterministic `/cleanup` overhaul — declarative ownership, targeted refresh, user-turn semantic

**Context:** Il vecchio `/cleanup` aveva 3 difetti accumulati:
1. **Ownership euristica:** `isBridgeSessionTitle` faceva pattern-match su titoli `telegram-*`. Falsi positivi su sessioni rinominate dall'utente, falsi negativi su sessioni bridge il cui titolo era stato auto-aggiornato da Kilo.
2. **`message_count` inflato:** contava tutte le righe `message` di Kilo, ma Kilo scrive una riga per atomic step (text/tool/thinking). Su un DB Kilo di produzione, una sessione con 525 righe `message` aveva solo 42 user prompts veri (ratio 12.5×), rendendo `KILO_CLEANUP_MAX_ROUNDS` praticamente inutile.
3. **Cleanup distruttivo automatico:** startup e `/new` cancellavano sessioni "stale". Comportamento accettabile in single-user dev, pericoloso in remoto: bastava un restart per perdere lavoro non visto sul telefono.

**Decision (PR #59):**
1. **Declarative ownership via `source` column:** nuova colonna `cli_sessions.source TEXT`, settata a `'bridge'` da `createNewSession`. Sessioni con `source IS NULL` (pre-migration o esterne) sono intenzionalmente invisibili a `/cleanup`. `getKiloBridgeSessions(boundId)` è la sola query usata dal cleanup.
2. **`message_count` = user-turn count:** `scanKilo` usa `COUNT(*) WHERE json_extract(data, '$.role') = 'user'` invece di `COUNT(*)`. Ora `KILO_CLEANUP_MAX_ROUNDS` riflette round conversazionali reali.
3. **Cleanup esplicito only:** rimossi cleanup automatici da startup e `/new`. `/cleanup` è two-phase preview/confirm con safety contract fail-closed.
4. **`refreshKiloMirror()` separato da `scanAll()`:** API pubblica nuova che legge solo Kilo (non Claude/Codex/Copilot/Qwen/Gemini), torna `{sessions, ok}`. `/cleanup confirm` è fail-closed su `ok===false` o throw. Questo è il fix N1+R4 emerso dal Copilot review round 3 dopo che la tripartite aveva mancato il bug strutturale del primo fix B1.

**Rationale:**
- Declarative > euristica: zero ambiguità, zero pattern matching su user-controlled fields.
- Fail-closed > fail-open: `/cleanup` deve mai operare su mirror stale, il costo di un falso "refusato" è zero, il costo di un falso "deleted" è permanente.
- Targeted refresh evita che `/cleanup` debba aspettare il walk di filesystem unrelated.

**Alternatives considered:**
- Tagging via title prefix immutabile (`bridge:title`) — più fragile del column dedicated, e rompe la UX di rinomina sessione.
- Soft delete invece di hard delete — non risolve il problema (la confusione era su quali sessioni cancellare, non su come cancellarle).
- Background reaper con timeout — rifiutato, era esattamente il pattern che voleva evitare il case "perdo lavoro non visto".

---

## 2026-04-04: Async turn submission with status polling for Kilo long-running turns

**Context:** Kilo turns involving heavy thinking (xhigh variant), subagent delegation, or multi-tool-call review chains routinely exceed the synchronous `POST /message` timeout. The bridge would give up after 120s (×2 retries = 240s), report a misleading "Try /agent sonnet" error, and the completed server-side output was lost forever.

**Decision:** Replace synchronous `POST /session/:id/message` with `POST /session/:id/prompt_async` (fire-and-forget) followed by status polling until the turn completes, then retrieve the result via `GET /session/:id/message`.

**Rationale:**
- `prompt_async` returns immediately — no HTTP timeout on the submission itself
- Status polling detects both completion and stale/dead turns without artificial time limits
- `GET /session/:id/message` retrieves the full result even if the turn took 10+ minutes
- Three separate timeout semantics (submission, stale, absolute) give honest user feedback instead of a blanket "timed out"
- Error messages no longer suggest switching agent on timeout/busy — that was misleading

**Alternatives considered:**
- Increase `KILO_TIMEOUT_MS` to 10+ minutes — rejected because a single HTTP request open for that long is fragile and masks real failures
- Full SSE streaming to Telegram — rejected previously (Decision Log 2026-04-04) because the streaming UX was broken; this approach reuses the async infrastructure without the streaming complexity
- WebSocket event stream as heartbeat — considered but status polling is simpler and sufficient for liveness detection

---

## 2026-04-04: Hybrid structured logging — NDJSON stream plus selective SQLite event store

**Context:** Console logs were too weak for debugging runtime failures. We needed live tailing, durable history, retention, and enough structure to trace parser failures and stuck sessions without turning the database into a garbage dump of heartbeat noise.

**Decision:** Emit structured JSON logs to an append-only NDJSON file and persist only high-value runtime events to a separate SQLite database.

**Rationale:**
- NDJSON is cheap to write, easy to tail, and good for full-fidelity runtime flow
- SQLite gives us queryable history for the events that actually matter: warnings, errors, parser fallbacks, session lifecycle, and stuck-turn diagnostics
- Keeping the event store selective avoids write-amplifying every request heartbeat into the database
- A separate log DB preserves the original `sessions.db` role and keeps operational concerns decoupled

**Alternatives considered:**
- Only NDJSON file logging — rejected because historical debugging and retention queries would stay clumsy
- Persist every log line to SQLite — rejected because it would create noise, lock pressure, and operational sludge
- Add an external logging stack — rejected because this project still wants to stay local-first and light

---

## 2026-04-04: Roll back Telegram SSE chat path to synchronous Kilo requests

**Context:** The SSE-based Telegram chat path introduced across `4b0a3a0`, `6fd2987`, and `0a094cf` broke the production message flow after the refactor. Real chat messages reached the bridge, but the async event path added extra failure modes and made the bot unreliable.

**Decision:** Keep the refactor that split `index.js` into focused modules, but remove the SSE chat path from the bridge and return to synchronous `POST /session/:id/message` requests.

**Rationale:**
- The synchronous path was already proven end-to-end in production
- The SSE path added dead configuration, unreachable cleanup logic, and a second integration path without enough verification
- Reliability matters more than status streaming in a single-user bridge
- Removing the dormant SSE client code keeps the next debugging session honest

**Alternatives considered:**
- Patch the SSE implementation in place — rejected because the async event path was still under-verified
- Keep both paths behind a flag — rejected because dual production paths would increase maintenance and debugging cost

---

## 2026-04-03: Mode A only — drop Mode B (`kilo run` fallback)

**Context:** Phase 0 validation revealed `kilo run --format json` fails with "Session not found" due to internal server bootstrap issues. The `kilo serve` HTTP API works perfectly.

**Decision:** Drop Mode B (`kilo run` per message). Bridge uses Mode A only (`kilo serve` HTTP API).

**Rationale:**
- `kilo run` has a fragile bootstrap that fails when other kilo instances are running
- `kilo serve` HTTP API is stable, well-structured, and already battle-tested by VS Code extension
- Mode A gives us streaming (WS), session persistence, and lower latency
- Mode B was always the fallback — with Mode A proven, the fallback adds complexity without value

---

## 2026-04-03: API findings from Phase 0 validation

**Context:** Validated the `kilo serve` HTTP API by reading source ([kilo-org/kilocode](https://github.com/kilo-org/kilocode)) and testing with curl.

**Key findings:**

| Finding | Detail |
|---------|--------|
| Auth | Basic Auth: username `kilo` (or `KILO_SERVER_USERNAME`), password from `KILO_SERVER_PASSWORD` env var |
| Port | VS Code extension starts `kilo serve --port 0` (random). For bridge, use `kilo serve --port 4096` explicitly |
| Session create | `POST /session` with `{"title":"..."}` → returns `{id, slug, directory, ...}` |
| Send message | `POST /session/:id/message` with `{"parts":[{"type":"text","text":"..."}], "variant":"low"}` |
| Async message | `POST /session/:id/prompt_async` — fire-and-forget, listen on WS for events |
| Get session | `GET /session/:id` |
| List sessions | `GET /session` |
| Get messages | `GET /session/:id/message` |
| Delete session | `DELETE /session/:id` |
| Events (WS) | WebSocket on same port, Hono websocket handler |
| Response format | JSON with `info` (metadata) + `parts` array (text, tool, step-start, step-finish) |
| MCP tools | Available in headless mode — MCP servers work in `kilo serve` sessions |

**SDK:** `@kilocode/sdk/v2` provides `createKiloClient()` — usable from the bridge directly.

---

## 2026-04-03: Kilo CLI over Codex/Claude Code/OpenClaw

**Context:** Need a CLI runtime for the Telegram bridge.

**Decision:** Use Kilo CLI (`kilo serve` + `kilo run --format json`).

**Rationale:** Kilo has native headless server, JSON output, session management, agent/model selection, and auto-approve mode. MCP servers are already configured. No need for a second CLI.

**Alternatives considered:**
- Codex `app-server` protocol — proven by openclaw-codex-app-server plugin, but adds a dependency on Codex
- Claude Code `claude -p` — limited, no JSON output mode
- OpenClaw — 25k commits of overhead for a transport layer

---

## 2026-04-03: Telegram over Discord

**Context:** Choose primary chat platform for the bridge.

**Decision:** Telegram first.

**Rationale:** 4096 char limit (vs 2000 Discord), simpler bot API (BotFather → token → done), grammY is excellent, long polling = zero infra, better mobile experience for reading code output.

**Alternatives considered:**
- Discord — better for multi-session with channels, but heavier API, lower char limit, WebSocket required
- WhatsApp — no consumer API, Baileys is fragile and risks ban

---

## 2026-04-03: Project workflow light over full

**Context:** Choose project structure methodology.

**Decision:** Use lightweight project workflow (canonical files + gates, no tripartite reviews).

**Rationale:** ~300 line bridge, single developer, personal project. Full workflow with Supabase persistence and escape analysis is overkill. Can upgrade if project grows.
