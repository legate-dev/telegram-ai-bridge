# Security Policy

## Supported versions

Only the latest release on `main` is actively supported with security fixes.

## Reporting a vulnerability

If you discover a security vulnerability, please report it privately:

- **GitHub Security Advisories**: [Report a vulnerability](https://github.com/legate-dev/telegram-ai-bridge/security/advisories/new)

Please do **not** open a public issue for security vulnerabilities.

## What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response timeline

- **Acknowledgement**: within 48 hours
- **Initial assessment**: within 7 days
- **Fix or mitigation**: best effort, depending on severity

## Scope

This project runs as a **single-user, self-hosted** bridge. The security model assumes a trusted local machine.

Out of scope:
- Vulnerabilities in upstream CLI tools (Claude Code, Codex, Copilot, Gemini, Kilo)
- Issues requiring physical access to the host machine
- Social engineering of the bot token (keep it secret)

## Threat model

The bridge is designed for **single-user, trusted-machine** environments. The trust boundary is the **Telegram bot token**.

### What the bridge protects against

- **Unauthorized Telegram users**: only the user ID set in `TELEGRAM_ALLOWED_USER_ID` can interact with the bridge. Every other user is rejected upfront by the auth middleware, before any command or message handler runs. (Bootstrap mode reveals only the operator's own user ID and is intended only for first-run setup.)
- **Bridge-owned secret leakage to subprocesses**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`, `KILO_SERVER_USERNAME`, and `KILO_SERVER_PASSWORD` are stripped from the environment passed to CLI subprocesses. These are bridge-only credentials and have no business reaching the CLIs.
- **Secret leakage in error messages**: a `redactString()` filter in `src/log.js` is applied at every logging sink (NDJSON stream, persisted SQLite event store) and every user-facing `ctx.reply()` error path. Covered patterns include Telegram bot URLs, `Authorization: Bearer`/`Basic` headers, bare `Bearer` tokens, URL-embedded credentials, modern LLM API keys (`sk-ant-api0X-`, `sk-proj-`, `sk-svcacct-`, legacy `sk-`, `key-`), Google API keys (`AIzaSy...`), GitHub tokens (`github_pat_*`, `gh[pusro]_*`), GitLab (`glpat-`), HuggingFace (`hf_`), Supabase (`sb[pvs]_`), Stripe (`sk_live_`, `pk_live_`, etc.), Slack (`xox[bpars]-`), AWS access key IDs (`AKIA/ASIA`), GCP service-account `"private_key"` JSON, and JWTs (three base64url segments). The canonical pattern list lives in `src/log.js` — treat `SECURITY.md` as illustrative and the source as authoritative. This is a **defensive filter, not a guarantee**: a novel credential format not yet covered by the regex will pass through unredacted until a pattern is added. Report any gap via a security advisory (see above).

### What the bridge does NOT protect against

- **Compromise of the Telegram bot token.** Anyone holding the token can send messages to the bridge as the authorized user. Combined with the CLIs' tool execution flags (`--allow-all-tools` for Copilot, `--permission-mode bypassPermissions` for Claude), this grants **arbitrary code execution** on the host through the CLI shell tools. The bot token MUST be treated like an SSH private key.
- **Compromise of the host machine.** Anyone with filesystem access has the bot token, the `.env`, and direct CLI access. The bridge adds no isolation between you and the operator that ran it.
- **Provider API key exfiltration via shell tool.** A compromised bridge session can read `~/.codex/auth.json`, `~/.claude/credentials.json`, `~/.aws/credentials`, `~/.ssh/`, `~/.zshrc`, or any other file the user can read. The bridge does not sandbox CLI tool calls — that is **intentional**, the bridge's value proposition is unattended long-running tasks. Filtering provider API keys out of the bridge's child-process environment would not help, because the same child process can read those keys directly from disk.
- **Issues in upstream CLI tools.** Bugs in Claude Code, Codex, Copilot, Gemini, or Kilo are out of scope. Report them upstream to the respective project.

### Recommended operational hygiene

- `.env` should be `chmod 600` and is never committed (`.gitignore` covers it by default)
- The bot token should be revoked immediately via [@BotFather](https://t.me/BotFather) on suspected leak
- `TELEGRAM_ALLOWED_USER_ID` should always be set in production — never leave the bridge in bootstrap mode beyond the first-run setup
- Consider running the bridge under a dedicated user account if other accounts/services share the host
- See [`DECISION_LOG.md`](DECISION_LOG.md) for the security hardening roadmap (TBOM, passphrase 2FA, WebAuthn) — three opt-in tiers planned post-v0.3.0 to reduce the blast radius of a leaked bot token, currently in design
