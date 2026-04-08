# Contributing

Thanks for your interest in contributing to Telegram Bridge! This guide covers the workflow and conventions.

## Development setup

1. Fork and clone the repo
2. `npm install`
3. Copy `.env.example` to `.env` and fill in your values
4. Start `kilo serve --port 4096` in a separate terminal
5. `npm start` to run the bridge

See [README.md](README.md) for full setup details.

## Branch workflow

The `main` branch is **protected**. All changes go through pull requests:

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/my-feature main
   ```
2. Make your changes, commit with clear messages
3. Push your branch and open a PR against `main`
4. At least one approving review is required to merge
5. Squash or rebase merge preferred — keep `main` history clean

### Branch naming

| Prefix | Use |
|--------|-----|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `chore/` | Maintenance, deps, docs |
| `refactor/` | Code restructuring without behavior change |

## Commit messages

Write clear, descriptive commit messages. Focus on **why**, not just what.

```
feat: add /history command to show recent messages

fix: handle Telegram markdown parse errors with plaintext fallback

chore: update grammY to 1.35.0
```

Prefix with `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, or `test:`.

## Project structure

```
src/
├── index.js              # Entry point, bot setup, backend registration
├── backends.js           # CLI backend abstraction (Kilo, Codex, Copilot, Gemini, Claude)
├── message-handler.js    # Unified callback + message routing
├── commands.js           # Bot command handlers (/new, /sessions, /abort, /cleanup, etc.)
├── kilo-client.js        # HTTP client for kilo serve API
├── format.js             # Response parsing, Telegram MarkdownV2 formatting
├── telegram-utils.js     # Telegram reply helpers, chunking
├── db.js                 # SQLite: session bindings, CLI session scanning, schema migrations
├── cli-scanner.js        # Discover sessions from local CLI state files (with refreshKiloMirror)
├── session-title.js      # Session title generation and normalization
├── config.js             # Environment variable loading
├── rate-limit.js         # Per-user rate limiting
├── agent-registry.js     # Agent discovery from Kilo config
├── model-discovery.js    # Model discovery for Claude/Codex
├── log.js                # Structured logger (NDJSON + console)
└── log-store.js          # SQLite event store for high-value runtime events
scripts/
├── install-launchd.sh    # macOS auto-start setup
└── *.plist               # launchd service definitions
```

## Key conventions

- **Environment variables** for all configuration — never hardcode URLs, credentials, or thresholds
- **No secrets in code** — `.env` is gitignored, use `.env.example` as the template
- The bridge is **transport only** — no agent logic, no LLM calls. If you're adding intelligence, it belongs in Kilo or an MCP server, not here
- Error handling should always surface useful context to the Telegram user, not fail silently

## Testing locally

1. Make sure `kilo serve` is running
2. Start the bridge with `npm start`
3. Send a message from Telegram to your bot
4. Check terminal output for logs

For a quick smoke test without sending real messages:

```bash
BRIDGE_DRY_RUN=1 npm start
```

This validates config and Kilo connectivity, then exits.

## Docs

If your change affects behavior, update the relevant docs:

| File | When to update |
|------|----------------|
| `README.md` | New commands, config changes, setup changes |
| `ARCHITECTURE.md` | Design changes, new components, data flow changes |
| `IMPLEMENTATION.md` | New phases/steps, progress updates |
| `DECISION_LOG.md` | Significant design decisions (append-only) |

## Reporting parser breakage

The bridge parses JSON/JSONL output from each CLI. When a CLI ships a new version that changes its output format, the corresponding parser may break.

If a backend stops working after a CLI update:

1. Note the CLI name and version (`codex --version`, `claude --version`, etc.)
2. Capture the raw output that the bridge failed to parse — check `logs/bridge.ndjson` for the full payload
3. Open an issue with the CLI version and the raw output snippet
4. Even better: add the raw output as a test fixture in `test/` and submit a PR with the parser fix

This is the most valuable type of contribution — every fixture makes the bridge more resilient.

## Questions?

Open an issue or ask in the PR. We're happy to help.
