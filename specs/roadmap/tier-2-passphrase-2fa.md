# feature: Passphrase 2FA via Telegram — Tier 2 of security hardening roadmap

`enhancement` `roadmap`

---

## Status

🅿️ **PARKED** — design captured, NOT yet ready for dispatch to Copilot Coding Agent.
Second tier of the **Security Hardening Roadmap** documented in [\`DECISION_LOG.md\`](../blob/main/DECISION_LOG.md) (see entry "2026-04-06: Security hardening roadmap (3-tier, post-v0.3.0)").

**Target version:** v0.5.x.

**Depends on:** Tier 1 (Time-Bounded Operation Mode) merged. This issue cannot be dispatched until the TBOM issue is implemented and stable.

## Context

[Tier 1 (TBOM)](../) closes the bridge after a time window expires, requiring **local terminal access** for renewal. This protects against passive bot token leaks but has one operational pain point: the operator must be **physically at the host machine** to renew. From the road, from the office, from a coffee shop — they cannot extend the bridge.

This tier adds a **second renewal channel** that works from Telegram itself (which the operator always has on their phone), but requires a **knowledge factor** that an attacker holding only the bot token cannot guess.

## The design

When TBOM expires, instead of replying \"refresh from local terminal\", the bridge replies:

> 🔒 **Locked.** Reply with passphrase to unlock for 8h.

The operator replies with their passphrase. The bridge:

1. Hashes the input with bcrypt (slow by design — brute-force resistant)
2. Compares against \`BRIDGE_2FA_PASSPHRASE_HASH\` env var (set by the operator at install time using a one-shot \`npm run hash-passphrase\` script)
3. On match: extends \`active-until\` by N hours (same as TBOM \`renew\`) and replies with confirmation
4. On match: also calls Telegram API \`deleteMessage\` to **remove the passphrase message from the chat history**, so the plaintext doesn't sit in the conversation log
5. On mismatch: increments a fail counter, locks for exponential backoff after N consecutive failures (rate-limit attack defense)

The plaintext passphrase **never leaves the operator's memory**. It is not stored in \`.env\`, not in keychain, not in any file. Only the bcrypt hash lives in \`.env\`.

## Threat coverage

✅ **Protects against (all of Tier 1, plus):**
- **Bot-token-only leak.** An attacker who has only the bot token cannot guess the passphrase (and bcrypt makes brute-force expensive). They can intercept the bridge's "Locked" prompt but cannot answer it correctly.
- **Leaked \`.env\` file with weak passphrase.** Bcrypt brute-force is slow enough that even a moderately strong passphrase (10+ chars random) takes years to crack. Weak passphrases (\"hunter2\") are still vulnerable, but that's an operator hygiene issue.
- **Persistent observability.** Even if the attacker successfully unlocks once, they cannot quietly maintain access — the next TBOM expiry forces another unlock attempt, and each attempt is logged + visible to the operator.

❌ **Does NOT protect against:**
- **Operator forgets the passphrase.** Recovery requires local terminal access (\`npm run hash-passphrase\` to set a new one). Document this clearly in OPERATIONS.md.
- **Weak passphrase + bot token leak.** Brute-force becomes feasible. The remediation is operator hygiene (use a strong passphrase).
- **Passphrase phishing.** An attacker with bot token could replay the bridge's \"Locked\" prompt to the operator, who might paste the passphrase thinking it's the real bridge. Mitigated by the operator recognizing the unsolicited prompt as anomalous (and by Tier 3 — WebAuthn — which is phishing-resistant).
- **Memory observation.** A compromised host can read the bcrypt hash from \`.env\` and the unlocked \`active-until\` file. Same threat model as Tier 1.

## Implementation outline

| Component | Description | Lines (estimate) |
|-----------|-------------|------------------|
| Setup script | \`scripts/hash-passphrase.js\` — interactive bcrypt hash generator (one-shot) | ~30 |
| 2FA module | \`src/two-factor.js\` — \`verify(plaintext)\`, fail counter with exponential backoff | ~50 |
| Middleware integration | Plug into TBOM standby reply: instead of plain "refresh from terminal", offer "reply with passphrase" | ~30 |
| Message handler | New code path in \`message-handler.js\` to detect passphrase reply, verify, unlock, deleteMessage | ~40 |
| Tests | \`test/two-factor.test.js\` — verify, fail counter, exponential backoff, deleteMessage flow | ~100 |
| Docs | README + OPERATIONS.md + .env.example + DECISION_LOG.md | ~40 |
| New dependency | \`bcrypt\` (or \`bcryptjs\` for pure-JS no native build) — adds ~1 dep | — |
| **Total** | | **~290 lines** |

## Acceptance criteria (high level — to be expanded into a full spec when dispatched)

- [ ] \`npm run hash-passphrase\` interactively reads passphrase, generates bcrypt hash, prints \`BRIDGE_2FA_PASSPHRASE_HASH=...\` for the operator to paste in \`.env\`
- [ ] When TBOM is expired AND \`BRIDGE_2FA_PASSPHRASE_HASH\` is set, the bridge replies with \"Locked. Reply with passphrase\" instead of \"refresh from terminal\"
- [ ] Operator replies with plaintext passphrase → bridge bcrypt-verifies → unlocks → deletes the operator's message via Telegram API \`deleteMessage\`
- [ ] On mismatch: increments a counter, replies with \"Wrong passphrase. Tries left: N\"
- [ ] After 3 consecutive failures: lockout for 30s. After 5: lockout for 5min. After 10: lockout for 1h. (Numbers tunable.)
- [ ] When \`BRIDGE_2FA_PASSPHRASE_HASH\` is NOT set, the bridge falls back to Tier 1 behavior (\"refresh from local terminal\")
- [ ] Tests cover all paths
- [ ] Documentation updated

## Dependencies

- Hard dependency: **Tier 1 (TBOM) merged**. This tier adds a renewal channel; without TBOM there is nothing to renew.
- Soft dependency: review of bcrypt vs bcryptjs choice. Pure JS avoids native build issues but is slower. For interactive verification on a phone, bcryptjs is fine.

## What NOT to do (when this issue is dispatched)

- **DO NOT** store the plaintext passphrase anywhere. Only \`BRIDGE_2FA_PASSPHRASE_HASH\` (the bcrypt hash) lives in \`.env\`.
- **DO NOT** echo the passphrase back to the operator after successful unlock. Confirm with \"Unlocked for Nh\" only.
- **DO NOT** skip the Telegram \`deleteMessage\` step. The plaintext in the chat history is a real residue risk.
- **DO NOT** make the deleteMessage failure block the unlock. If \`deleteMessage\` fails (network, message too old), proceed with unlock and log a warning. The unlock is the user's intent; deleteMessage is a defense-in-depth.
- **DO NOT** use SHA-256 or other fast hashes. Bcrypt's slowness is the point.
- **DO NOT** allow passphrase change via Telegram. Changing the passphrase requires local terminal access (\`npm run hash-passphrase\` again). This prevents an attacker who briefly compromised a session from rotating the passphrase to lock the operator out.
- **DO NOT** dispatch without first writing a full \`specs/two-factor-spec.md\` document.

## Notes

This issue was created on 2026-04-06 during the recalibration session of B1 (env sanitization blocker). It is the **second of three tiers** in the security hardening roadmap. The third tier (WebAuthn / device-signed renewal via PWA) is documented in DECISION_LOG.md but does NOT have a parking issue yet — it requires a dedicated design session before becoming spec-ready.
