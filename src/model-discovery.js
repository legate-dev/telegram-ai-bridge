import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { config } from "./config.js"

const CLAUDE_STATIC_ALIASES = ["opus", "sonnet", "haiku"]
export const MAX_CALLBACK_SLUG = 54
const MODEL_CALLBACK_HASH_LEN = 8

export function fingerprintModelSlug(slug) {
  return createHash("sha256").update(slug).digest("hex").slice(0, MODEL_CALLBACK_HASH_LEN)
}

export function encodeModelCallbackSlug(cliName, slug, index) {
  if (cliName !== "lmstudio" || slug.length <= MAX_CALLBACK_SLUG) return slug
  return `#${index}:${fingerprintModelSlug(slug)}`
}

export function resolveIndexedModelSlug(token, models) {
  const match = /^#(\d+)(?::([0-9a-f]{8}))?$/.exec(token)
  if (!match) return { ok: false, reason: "invalid_token", slug: null }

  const idx = Number.parseInt(match[1], 10)
  const fingerprint = match[2] ?? ""
  const model = models?.[idx]
  if (!model?.slug) return { ok: false, reason: "index_out_of_range", slug: null }
  if (fingerprint && fingerprintModelSlug(model.slug) !== fingerprint) {
    return { ok: false, reason: "fingerprint_mismatch", slug: null }
  }
  return { ok: true, reason: null, slug: model.slug }
}


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

/**
 * Fetch models available in LM Studio via native /api/v1/models.
 * Returns richer data than the OpenAI-compat endpoint: type, display_name,
 * params_string, loaded status, and size.
 * Returns [] if the server is unreachable or no LLM models are available.
 */
export async function discoverLmStudioModels() {
  try {
    const headers = {}
    if (config.lmstudioApiToken) {
      headers["Authorization"] = `Bearer ${config.lmstudioApiToken}`
    }
    const res = await fetch(`${config.lmstudioBaseUrl}/api/v1/models`, {
      signal: AbortSignal.timeout(config.lmstudioDetectTimeoutMs),
      headers,
    })
    if (!res.ok) return []
    const { models } = await res.json()
    return (models ?? [])
      .filter((m) => m.type === "llm")
      .map((m) => ({
        slug: m.key,
        displayName: m.display_name
          ? `${m.display_name}${m.params_string ? ` (${m.params_string})` : ""}`
          : m.key,
      }))
  } catch {
    return []
  }
}

// Returns [{ slug, displayName }] for CLIs that support model selection,
// or null for CLIs that do not. Async because LM Studio discovery uses fetch.
export async function getModelsForCli(cliName) {
  if (cliName === "codex") return discoverCodexModels()
  if (cliName === "claude") return discoverClaudeModels()
  if (cliName === "lmstudio") return discoverLmStudioModels()
  return null
}
