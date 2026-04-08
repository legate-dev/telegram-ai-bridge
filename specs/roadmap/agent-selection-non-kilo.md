# feat: agent selection awareness for non-Kilo backends (v2 — with design guidance)

`enhancement` `roadmap`

---

## Context
Re-issue of #19. The previous PR #20 was rejected because it modified shared helpers that broke Kilo session binding.

## Problem
The \`/agent\` and \`/agents\` commands only make sense for Kilo (which has an internal agent system). Other backends (Claude, Codex, Copilot, Gemini) don't support agent selection from the bridge — their model is configured in the CLI directly.

Currently, setting \`/agent sonnet\` on a Claude session silently has no effect.

## Design constraint
**Do NOT modify \`resolvePreferredAgent()\`** — it's used in session creation and message sending for Kilo and must continue to work. The fix is purely in the command handlers.

## Fix — command handlers only

### \`/agents\` command in \`src/commands.js\`
Before listing agents, check if the current binding is Kilo:
```js
if (binding && binding.cli !== "kilo") {
  await replyChunks(ctx, \`Agent selection is not available for \${binding.cli}. Model configuration is managed in the CLI directly.\`)
  return
}
```

### \`/agent <name>\` command in \`src/commands.js\`
Same guard:
```js
if (binding && binding.cli !== "kilo") {
  await replyChunks(ctx, \`Agent selection is not supported for \${binding.cli} sessions. Only Kilo sessions support /agent.\`)
  return
}
```

That's it. Two guards, two messages, no shared helper changes.

## Files
- \`src/commands.js\`: \`/agents\` handler and \`/agent\` handler only

## Acceptance criteria
- \`/agents\` on a non-Kilo session shows informative message
- \`/agent sonnet\` on a Claude session shows informative message
- Kilo agent selection completely unchanged
- \`resolvePreferredAgent()\` untouched
- \`node --check src/index.js\` passes
- Existing tests pass
