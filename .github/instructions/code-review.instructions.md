---
applyTo: "**/*"
---

# Code Review Instructions

## Review posture

You are reviewing code in a Telegram bridge that wraps AI CLI backends. The codebase is small (~2k LOC) but has real users and handles subprocess spawning, SQLite state, and Telegram API interactions. Bugs here cause silent data corruption or broken sessions.

## Priority checklist

Check these in order. Stop and flag a finding as soon as you see a violation.

### 1. Contract compliance

- Does the change match `API_CONTRACT.md`? If the PR modifies command behavior, binding schema, or backend interfaces, the contract must be updated in the same PR.
- Does `sendMessage()` signature in backends match what `message-handler.js` passes?
- Are new columns in `db.js` reflected in both `CREATE TABLE` and the migration block?

### 2. State integrity

- **Binding lifecycle:** when a chat rebinds to a different CLI (via `/new` or inline keyboard), are per-CLI fields (agent, model) explicitly reset to `null`? The `COALESCE` pattern in `setChatBinding` preserves stale values unless the caller passes `null`.
- **Session cleanup:** when sessions are detached or cleaned up, is all associated state cleared?
- Check for values that silently persist across context switches (CLI changes, session rebinds).

### 3. Input validation

- All Telegram `ctx.match`, `ctx.message.text`, and `ctx.callbackQuery.data` are untrusted.
- Callback query data prefixes (e.g., `bind:`, `setmodel:`) must be parsed defensively — colons in values, missing parts, unexpected formats.
- Directory paths from user input must be validated before use in `execFile`.

### 4. Security

- No secrets (tokens, API keys) in log output or error messages
- `execFile` (not `exec`) for all subprocess spawning — arguments as array, never string concatenation
- SQL uses named parameters (`@param`), never string interpolation
- New dependencies must be justified and version-pinned

### 5. Error handling

- CLI backends can fail (process crash, timeout, malformed output). Check that error paths don't leave bindings in inconsistent state.
- `readFileSync` / `JSON.parse` must be wrapped in try/catch when reading external files (model caches, config files).
- Telegram API calls (`ctx.reply`, `ctx.editMessageText`) can throw — especially on stale messages or deleted chats.

### 6. Test coverage

- New command handlers should have corresponding tests in `test/`
- For modules that read files or config, test both the happy path and error paths (missing file, malformed JSON, null/undefined values)
- If a PR adds branching logic, each branch should be exercised by at least one test

## Severity classification

- **Critical:** data corruption, security vulnerability, crash on common path
- **High:** silent wrong behavior (e.g., wrong model sent to CLI), contract drift
- **Medium:** missing error handling on uncommon path, missing test coverage
- **Low:** style, naming, documentation gaps

## What NOT to flag

- Style preferences (semicolons, quote style, trailing commas) — the project has established conventions
- Minor naming choices that are consistent with existing code
- Missing TypeScript types — this is a JS project by design
- Performance optimizations unless there's a measurable impact on the Telegram response path
