# Copilot Coding Agent — Repository Instructions

## Project context

This is a Telegram bridge that wraps multiple AI CLI backends (Claude Code, Codex, Kilo, Gemini, Copilot) behind a single bot interface. Node.js, ESM, Grammy (Telegram framework), better-sqlite3 for local state.

## Code style

- ESM imports, no CommonJS
- No TypeScript — plain JS with JSDoc where helpful
- `node:test` + `node:assert/strict` for tests, no external test frameworks
- Prefer `node:` prefix for built-in modules
- Trailing newline on all files
- No semicolons except where ASI is ambiguous

## Architecture rules

- Each CLI backend is a class in `src/backends.js` with a `sendMessage()` method
- Chat bindings (which session is bound to which Telegram chat) live in SQLite via `src/db.js`
- Commands are registered in `src/commands.js`, callback queries handled in `src/message-handler.js`
- Config comes from env vars via `src/config.js` — never hardcode paths, ports, tokens, or thresholds
- Session scanning (discovering CLI sessions on disk) lives in `src/cli-scanner.js`

## No hardcoding

This is non-negotiable:

- Never hardcode values that could change: URLs, ports, paths, feature flags, thresholds
- Environment variables for anything deployment-specific — define defaults in `src/config.js`, document in `.env.example`
- Credentials and secrets: never in source, never in commits, never in logs

## Security awareness

AI-generated code has a 40-45% vulnerability rate in studies. Actively counter this:

- **SQL:** parameterize all queries. This project uses better-sqlite3 with named parameters (`@param`). Never interpolate user input into SQL strings.
- **Input handling:** all Telegram message text and callback data is untrusted user input. Validate and sanitize before using in file paths, shell args, or SQL.
- **Shell execution:** this project uses `execFile` (not `exec`) for CLI spawning. Never construct shell command strings from user input. Pass arguments as array elements.
- **Secrets in logs:** the `log` module is used throughout. Never log tokens, API keys, session secrets, or user messages in full. Use `redactString()` from `src/log.js` for sensitive values.
- **Dependencies:** prefer stdlib (`node:fs`, `node:path`, `node:child_process`) or deps already in `package.json`. Do not add new dependencies without explicit justification. When updating or adding versions, follow the existing `package.json` versioning convention rather than switching to exact pins.
- **Path traversal:** when resolving directories from user input (e.g., `/new` command workspace path), always canonicalize and validate against allowed paths before use.

## Database migration pattern

When adding columns to existing tables in `src/db.js`:
1. Add the column in the `CREATE TABLE IF NOT EXISTS` statement (for fresh DBs)
2. Add a migration block using `PRAGMA table_info()` to check if the column exists, then `ALTER TABLE ADD COLUMN` (for existing DBs)
3. Update `setChatBinding` or equivalent to include the new column in both INSERT and ON CONFLICT DO UPDATE

**Critical pattern — COALESCE in upserts:** when using `COALESCE(excluded.col, table.col)` to preserve values on update, be aware that callers must pass `null` explicitly to clear a value. Omitting the key preserves the stale value. This has caused bugs (e.g., model persisting across CLI switches).

## Testing

- Write tests in `test/<module>.test.js`
- Use `node:test` with `mock.module()` for dependency mocking
- Test both happy path and error paths (missing files, malformed JSON, null values)
- For modules that read config, create a mutable mock config object so tests can swap values per-test
- Run tests with `node --experimental-test-module-mocks --test 'test/*.test.js'`

## Git discipline

- One logical change per commit
- Commit messages: `type: description` (feat, fix, test, perf, chore, docs, ux)
- Update `API_CONTRACT.md` when changing command behavior, binding schema, or backend interfaces
- Update `README.md` when adding user-facing commands
