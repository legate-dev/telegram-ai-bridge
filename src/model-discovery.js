import { readFileSync } from "node:fs"
import { config } from "./config.js"

const CLAUDE_STATIC_ALIASES = ["opus", "sonnet", "haiku"]

export function discoverCodexModels() {
  try {
    const raw = readFileSync(config.codexModelsCachePath, "utf8")
    const cache = JSON.parse(raw)
    const models = Array.isArray(cache.models) ? cache.models : []
    return models
      .filter((m) => m.visibility === "list")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => ({ slug: m.slug, displayName: m.display_name || m.slug }))
  } catch {
    return []
  }
}

export function discoverClaudeModels() {
  const aliases = CLAUDE_STATIC_ALIASES.map((a) => ({ slug: a, displayName: a }))
  try {
    const raw = readFileSync(config.claudeConfigPath, "utf8")
    const data = JSON.parse(raw)
    const seen = new Set(CLAUDE_STATIC_ALIASES)
    const extra = []
    const projects = data?.projects ?? {}
    for (const project of Object.values(projects)) {
      const usage = project?.lastModelUsage ?? {}
      for (const modelId of Object.keys(usage)) {
        if (!seen.has(modelId)) {
          seen.add(modelId)
          extra.push({ slug: modelId, displayName: modelId })
        }
      }
    }
    return [...aliases, ...extra]
  } catch {
    return aliases
  }
}

// Returns [{ slug, displayName }] for CLIs that support model selection,
// or null for CLIs that do not.
export function getModelsForCli(cliName) {
  if (cliName === "codex") return discoverCodexModels()
  if (cliName === "claude") return discoverClaudeModels()
  return null
}
