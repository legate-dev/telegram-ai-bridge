# feature: Time-Bounded Operation Mode (TBOM) — Tier 1 of security hardening roadmap

`enhancement` `roadmap`

---

## Status

🅿️ **PARKED** — design captured, NOT yet ready for dispatch to Copilot Coding Agent.
First tier of the **Security Hardening Roadmap** documented in [`DECISION_LOG.md`](../blob/main/DECISION_LOG.md) (see entry "2026-04-06: Security hardening roadmap (3-tier, post-v0.3.0)").

**Target version:** v0.4.x (post-v0.3.0 first public release).

## Context

The bridge runs CLI backends with tool approval disabled (\`--allow-all-tools\`, \`--permission-mode bypassPermissions\`) so that long-running operations from a phone don't block on prompts. The trade-off: **anyone holding the \`TELEGRAM_BOT_TOKEN\` has arbitrary code execution on the host** through the CLI shell tool.

The bot token is therefore the single point of failure. The full threat model is documented in [\`SECURITY.md\`](../blob/main/SECURITY.md) (\`## Threat model\` section).

This is the **first opt-in mitigation tier**: bound the time window during which the bridge accepts messages, and require renewal from a channel the attacker (who only has the bot token) cannot reach.

## The design

A small file on disk (\`~/.bridge/active-until\` by default, configurable) holds an epoch timestamp. The bridge middleware checks this file before processing every Telegram message:

- \`now < active-until\` → process the message normally
- \`now >= active-until\` → reply with \"🔒 Bridge in standby. Refresh from local terminal: \`npm run renew 8h\`.\" and stop

Renewal is performed **from the host machine's local terminal** via npm scripts (which the bot-token attacker cannot access remotely):

- \`npm run renew [duration]\` — extends \`active-until\` by N (e.g. \`npm run renew 8h\` writes now+8h)
- \`npm run standby\` — empties \`active-until\` immediately (kill switch)
- \`npm run status\` — shows current state (active until / in standby) and remaining time

A Telegram command \`/standby\` is also added as a **reactive kill switch**: if the operator suspects compromise, they can mute the bridge from their own phone (which works because legitimate use of \`/standby\` is via the operator's normal Telegram session, while an attacker would need to be faster than the operator to take advantage). Renewal still requires local access — \`/standby\` cannot reactivate.

## Threat coverage

✅ **Protects against:**
- **Passive bot token leak** (committed by mistake, screenshot, log scraping, repo public). The leaked token has at most a few hours of active window before TBOM closes the bridge automatically.
- **Bridge-left-on-overnight.** If the operator doesn't renew at the start of a working session, the bridge is in standby — no \"always-on attack surface\" 24/7.
- **Reactive shutdown.** Operator notices anomalous activity in Telegram → \`/standby\` from phone → bridge is locked in <1s.
- **Auto-start (launchd) safety.** After reboot, the bridge starts in standby state (\`active-until\` not yet set or expired). The operator must rinnovare manually from the terminal — default-closed by reboot, which is the right posture.

❌ **Does NOT protect against:**
- **Compromise during the active window.** If the operator rinnovare for 8h at 14:00 and the attacker steals the token at 15:00, they have until 22:00. The mitigation here is reactive (\`/standby\`), not preventive.
- **Filesystem compromise of the host.** An attacker who can write to \`~/.bridge/active-until\` can extend the window arbitrarily. But that level of access is already game-over — they have the \`.env\`, the bot token, and direct CLI access.

## Implementation outline

| Component | Description | Lines (estimate) |
|-----------|-------------|------------------|
| Config | New env vars: \`BRIDGE_ACTIVE_UNTIL_PATH\`, \`BRIDGE_DEFAULT_RENEW_HOURS\` | ~10 |
| TBOM module | \`src/tbom.js\` — \`isActive()\`, \`renew(duration)\`, \`standby()\`, \`status()\` | ~40 |
| Middleware | grammy middleware that calls \`isActive()\` before all handlers | ~15 |
| \`/standby\` command | Telegram command in \`src/commands.js\` | ~10 |
| npm scripts | \`renew\`, \`standby\`, \`status\` in \`package.json\` + \`scripts/tbom.js\` | ~20 |
| Tests | \`test/tbom.test.js\` — 5-6 unit tests covering all states | ~80 |
| Docs | README quickstart + OPERATIONS.md hygiene + .env.example new vars | ~30 |
| **Total** | | **~200 lines** |

Cross-platform (file I/O only). Zero crypto. Zero new runtime dependencies.

## Acceptance criteria (high level — to be expanded into a full spec when dispatched)

- [ ] \`~/.bridge/active-until\` file created on first \`renew\`, contains plain epoch text
- [ ] Bridge middleware rejects messages with standby reply when \`now >= active-until\`
- [ ] \`npm run renew 8h\` extends \`active-until\` by 8 hours from now (regardless of previous value)
- [ ] \`npm run standby\` empties the file (or sets it to 0)
- [ ] \`npm run status\` reports active state and remaining time, or standby state
- [ ] Telegram \`/standby\` command sets the file to 0 and replies with confirmation
- [ ] Bridge auto-start via launchd: bridge process starts but is in standby state until manually renewed
- [ ] Existing test suite passes
- [ ] Documentation updated (README, OPERATIONS.md, .env.example, DECISION_LOG.md)

## Dependencies

None. Self-contained feature. Tier 2 (passphrase 2FA via Telegram) and Tier 3 (WebAuthn) **depend on this issue**, but Tier 1 ships independently.

## What NOT to do (when this issue is dispatched)

- **DO NOT** make TBOM mandatory. It is **opt-in**: if the operator never runs \`npm run renew\`, the bridge should fall back to current behavior (always active) OR start in standby — to be decided when the spec is finalized. Recommendation: **default to standby on first start, require explicit \`renew\` to begin**, so that fresh installs are secure-by-default.
- **DO NOT** put \`active-until\` in the project directory — use \`~/.bridge/\` (XDG-style) so it survives \`git clean\`, doesn't pollute the repo, and is per-operator.
- **DO NOT** add encryption to the file. It's a timestamp, not a secret. Plain text.
- **DO NOT** sync \`active-until\` across machines. Per-host state.
- **DO NOT** dispatch without first writing a full \`specs/tbom-spec.md\` document with the same level of detail as this issue. The summary above is a sketch, not a spec.

## Notes

This issue was created on 2026-04-06 during the recalibration session of B1 (env sanitization blocker), where the threat model was re-examined and the real problem was identified as "blast radius of leaked bot token", not "env leakage". See the parallel issue for **Tier 2** (passphrase 2FA via Telegram) and the full DECISION_LOG entry for the complete roadmap.
