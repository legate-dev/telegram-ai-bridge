import { mock, test, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const tmpDir = join(tmpdir(), `model-discovery-test-${Date.now()}`)
mkdirSync(tmpDir, { recursive: true })

// Valid Codex cache with mixed visibility and priorities
const validCodexCachePath = join(tmpDir, "models_cache.json")
writeFileSync(validCodexCachePath, JSON.stringify({
  fetched_at: "2026-04-05T13:34:27.415488Z",
  models: [
    { slug: "gpt-5.4", display_name: "gpt-5.4", visibility: "list", priority: 1 },
    { slug: "gpt-5-mini", display_name: "gpt-5 mini", visibility: "list", priority: 2 },
    { slug: "gpt-hidden", display_name: "hidden model", visibility: "hidden", priority: 0 },
    { slug: "gpt-nopri", display_name: "no priority model", visibility: "list" },
  ],
}))

// Codex cache with no models key
const codexNoModelsPath = join(tmpDir, "models_cache_no_models.json")
writeFileSync(codexNoModelsPath, JSON.stringify({ fetched_at: "2026-01-01T00:00:00Z" }))

// Codex cache where models is null
const codexNullModelsPath = join(tmpDir, "models_cache_null_models.json")
writeFileSync(codexNullModelsPath, JSON.stringify({ models: null }))

// Malformed JSON files
const malformedPath = join(tmpDir, "malformed.json")
writeFileSync(malformedPath, "{{not valid json}}")

// Valid Claude config with projects and lastModelUsage
const validClaudeConfigPath = join(tmpDir, "claude.json")
writeFileSync(validClaudeConfigPath, JSON.stringify({
  projects: {
    "/path/to/project": {
      lastModelUsage: {
        "claude-opus-4-6": { inputTokens: 15369, outputTokens: 177869, costUSD: 25.50 },
        "claude-sonnet-4-5": { inputTokens: 1000, outputTokens: 2000, costUSD: 1.0 },
      },
    },
    "/another/project": {
      lastModelUsage: {
        "claude-opus-4-6": { inputTokens: 100, outputTokens: 200, costUSD: 0.10 }, // duplicate
      },
    },
    "/empty-project": {},
  },
}))

// Claude config with empty projects
const claudeEmptyProjectsPath = join(tmpDir, "claude_empty_projects.json")
writeFileSync(claudeEmptyProjectsPath, JSON.stringify({ projects: {} }))

// Claude config with no projects key
const claudeNoProjectsPath = join(tmpDir, "claude_no_projects.json")
writeFileSync(claudeNoProjectsPath, JSON.stringify({ someOtherKey: "value" }))

// Path that will never exist
const missingPath = join(tmpDir, "does-not-exist.json")

// ── Mock config before importing model-discovery ──────────────────────────────
// We keep a mutable config object so individual tests can swap paths.

const mockConfig = {
  codexModelsCachePath: validCodexCachePath,
  claudeConfigPath: validClaudeConfigPath,
  lmstudioBaseUrl: "http://127.0.0.1:99999",
  lmstudioDetectTimeoutMs: 1000,
  lmstudioApiToken: "",
}

await mock.module("../src/config.js", {
  namedExports: { config: mockConfig },
})

const {
  discoverCodexModels,
  discoverClaudeModels,
  discoverLmStudioModels,
  encodeModelCallbackSlug,
  fingerprintModelSlug,
  getModelsForCli,
  resolveIndexedModelSlug,
} = await import("../src/model-discovery.js")

// ── Fetch mock for LM Studio tests ──
let mockFetchImpl = null
const originalFetch = global.fetch
global.fetch = (...args) => {
  if (mockFetchImpl) return mockFetchImpl(...args)
  return originalFetch(...args)
}
after(() => { global.fetch = originalFetch })

// ── discoverCodexModels — happy path ──────────────────────────────────────────

test("discoverCodexModels returns only 'list' visibility models", () => {
  mockConfig.codexModelsCachePath = validCodexCachePath
  const result = discoverCodexModels()
  const slugs = result.map((m) => m.slug)
  assert.ok(!slugs.includes("gpt-hidden"), "should exclude hidden models")
  assert.ok(slugs.includes("gpt-5.4"))
  assert.ok(slugs.includes("gpt-5-mini"))
})

test("discoverCodexModels sorts by priority ascending (missing priority sorts last)", () => {
  mockConfig.codexModelsCachePath = validCodexCachePath
  const result = discoverCodexModels()
  assert.equal(result[0].slug, "gpt-5.4")
  assert.equal(result[1].slug, "gpt-5-mini")
  assert.equal(result[2].slug, "gpt-nopri")
})

test("discoverCodexModels maps to { slug, displayName } shape", () => {
  mockConfig.codexModelsCachePath = validCodexCachePath
  const result = discoverCodexModels()
  for (const m of result) {
    assert.ok("slug" in m, "should have slug")
    assert.ok("displayName" in m, "should have displayName")
    assert.equal(Object.keys(m).length, 2, "should have exactly two keys")
  }
})

test("discoverCodexModels uses display_name for displayName", () => {
  mockConfig.codexModelsCachePath = validCodexCachePath
  const result = discoverCodexModels()
  const model = result.find((m) => m.slug === "gpt-5-mini")
  assert.equal(model.displayName, "gpt-5 mini")
})

// ── discoverCodexModels — error paths ────────────────────────────────────────

test("discoverCodexModels returns empty array when models key is missing from cache", () => {
  mockConfig.codexModelsCachePath = codexNoModelsPath
  assert.deepEqual(discoverCodexModels(), [])
})

test("discoverCodexModels returns empty array when models is null", () => {
  mockConfig.codexModelsCachePath = codexNullModelsPath
  assert.deepEqual(discoverCodexModels(), [])
})

test("discoverCodexModels returns empty array when cache file does not exist (ENOENT)", () => {
  mockConfig.codexModelsCachePath = missingPath
  assert.deepEqual(discoverCodexModels(), [])
})

test("discoverCodexModels returns empty array when cache file contains malformed JSON", () => {
  mockConfig.codexModelsCachePath = malformedPath
  assert.deepEqual(discoverCodexModels(), [])
})

// ── discoverClaudeModels — happy path ─────────────────────────────────────────

test("discoverClaudeModels starts with static aliases in order: opus, sonnet, haiku", () => {
  mockConfig.claudeConfigPath = validClaudeConfigPath
  const result = discoverClaudeModels()
  assert.equal(result[0].slug, "opus")
  assert.equal(result[1].slug, "sonnet")
  assert.equal(result[2].slug, "haiku")
})

test("discoverClaudeModels includes models from lastModelUsage", () => {
  mockConfig.claudeConfigPath = validClaudeConfigPath
  const result = discoverClaudeModels()
  const slugs = result.map((m) => m.slug)
  assert.ok(slugs.includes("claude-opus-4-6"))
  assert.ok(slugs.includes("claude-sonnet-4-5"))
})

test("discoverClaudeModels deduplicates models that appear in multiple projects", () => {
  mockConfig.claudeConfigPath = validClaudeConfigPath
  const result = discoverClaudeModels()
  const slugs = result.map((m) => m.slug)
  assert.equal(slugs.filter((s) => s === "claude-opus-4-6").length, 1)
})

test("discoverClaudeModels has no duplicate slugs", () => {
  mockConfig.claudeConfigPath = validClaudeConfigPath
  const result = discoverClaudeModels()
  const slugs = result.map((m) => m.slug)
  assert.equal(new Set(slugs).size, slugs.length)
})

test("discoverClaudeModels maps discovered models to { slug, displayName } shape", () => {
  mockConfig.claudeConfigPath = validClaudeConfigPath
  const result = discoverClaudeModels()
  for (const m of result) {
    assert.ok("slug" in m)
    assert.ok("displayName" in m)
    assert.equal(Object.keys(m).length, 2)
  }
})

// ── discoverClaudeModels — error paths ───────────────────────────────────────

test("discoverClaudeModels returns only static aliases when projects is empty", () => {
  mockConfig.claudeConfigPath = claudeEmptyProjectsPath
  const result = discoverClaudeModels()
  assert.deepEqual(result, [
    { slug: "opus", displayName: "opus" },
    { slug: "sonnet", displayName: "sonnet" },
    { slug: "haiku", displayName: "haiku" },
  ])
})

test("discoverClaudeModels returns only static aliases when projects key is absent", () => {
  mockConfig.claudeConfigPath = claudeNoProjectsPath
  const result = discoverClaudeModels()
  assert.deepEqual(result, [
    { slug: "opus", displayName: "opus" },
    { slug: "sonnet", displayName: "sonnet" },
    { slug: "haiku", displayName: "haiku" },
  ])
})

test("discoverClaudeModels returns only static aliases when config file does not exist (ENOENT)", () => {
  mockConfig.claudeConfigPath = missingPath
  const result = discoverClaudeModels()
  assert.deepEqual(result, [
    { slug: "opus", displayName: "opus" },
    { slug: "sonnet", displayName: "sonnet" },
    { slug: "haiku", displayName: "haiku" },
  ])
})

test("discoverClaudeModels returns only static aliases when config file contains malformed JSON", () => {
  mockConfig.claudeConfigPath = malformedPath
  const result = discoverClaudeModels()
  assert.deepEqual(result, [
    { slug: "opus", displayName: "opus" },
    { slug: "sonnet", displayName: "sonnet" },
    { slug: "haiku", displayName: "haiku" },
  ])
})

// ── getModelsForCli — router ──────────────────────────────────────────────────

test("getModelsForCli returns null for kilo", async () => {
  assert.equal(await getModelsForCli("kilo"), null)
})

test("getModelsForCli returns null for copilot", async () => {
  assert.equal(await getModelsForCli("copilot"), null)
})

test("getModelsForCli returns null for gemini", async () => {
  assert.equal(await getModelsForCli("gemini"), null)
})

test("getModelsForCli returns null for unknown CLI", async () => {
  assert.equal(await getModelsForCli("qwen"), null)
})

test("getModelsForCli returns array for claude with at least static aliases", async () => {
  mockConfig.claudeConfigPath = validClaudeConfigPath
  const result = await getModelsForCli("claude")
  assert.ok(Array.isArray(result))
  assert.ok(result.length >= 3)
  const slugs = result.map((m) => m.slug)
  assert.ok(slugs.includes("opus"))
  assert.ok(slugs.includes("sonnet"))
  assert.ok(slugs.includes("haiku"))
})

test("getModelsForCli returns array for codex", async () => {
  mockConfig.codexModelsCachePath = validCodexCachePath
  const result = await getModelsForCli("codex")
  assert.ok(Array.isArray(result))
  assert.ok(result.length > 0)
})

// ── discoverLmStudioModels ────────────────────────────────────────────────────

test("discoverLmStudioModels returns LLM models from native /api/v1/models", async (t) => {
  mockFetchImpl = () => Promise.resolve({
    ok: true,
    json: async () => ({
      models: [
        { key: "qwen3-0.6b", display_name: "Qwen3 0.6B", type: "llm", params_string: "0.6B" },
        { key: "llama-3.2-3b", display_name: "Llama 3.2", type: "llm", params_string: "3B" },
        { key: "text-embedding-large", display_name: "Embedding", type: "embedding" },
      ],
    }),
  })
  t.after(() => { mockFetchImpl = null })
  const result = await discoverLmStudioModels()
  assert.ok(Array.isArray(result))
  assert.equal(result.length, 2)
  assert.equal(result[0].slug, "qwen3-0.6b")
  assert.ok(result[0].displayName.includes("Qwen3"))
  assert.ok(result[0].displayName.includes("0.6B"))
  assert.equal(result[1].slug, "llama-3.2-3b")
})

test("discoverLmStudioModels returns [] when server is unreachable", async (t) => {
  mockFetchImpl = () => Promise.reject(new Error("ECONNREFUSED"))
  t.after(() => { mockFetchImpl = null })
  const result = await discoverLmStudioModels()
  assert.deepEqual(result, [])
})

test("getModelsForCli returns array for lmstudio", async (t) => {
  mockFetchImpl = () => Promise.resolve({
    ok: true,
    json: async () => ({
      models: [{ key: "qwen3-0.6b", display_name: "Qwen3", type: "llm" }],
    }),
  })
  t.after(() => { mockFetchImpl = null })
  const result = await getModelsForCli("lmstudio")
  assert.ok(Array.isArray(result))
  assert.equal(result.length, 1)
  assert.equal(result[0].slug, "qwen3-0.6b")
})

// ── Callback data truncation (Telegram 64-byte limit) ─────────────────────────

test("LM Studio model slugs over 54 chars use index-based callback data", () => {
  const longSlug = "dolphin-mistral-glm-4.7-flash-24b-venice-edition-thinking-uncensored-i1@q4_k_s"
  const shortSlug = "qwen3-0.6b"

  // Long slug should use index
  const longCb = `setmodel:${encodeModelCallbackSlug("lmstudio", longSlug, 0)}`
  assert.ok(longCb.length <= 64, "indexed callback should fit in 64 bytes")
  assert.match(longCb, /^setmodel:#0:[0-9a-f]{8}$/, "indexed callback should carry a short fingerprint")

  // Short slug should use slug directly
  const shortCb = `setmodel:${encodeModelCallbackSlug("lmstudio", shortSlug, 1)}`
  assert.ok(shortCb.length <= 64, "short slug callback should fit in 64 bytes")
  assert.equal(shortCb, `setmodel:${shortSlug}`)
})

test("Index-based callback resolves correct model from list", async (t) => {
  const longSlug1 = "dolphin-mistral-glm-4.7-flash-24b-venice-edition-thinking-uncensored-i1@q2_k_s"
  const longSlug2 = "dolphin-mistral-glm-4.7-flash-24b-venice-edition-thinking-uncensored-i1@q4_k_s"
  mockFetchImpl = () => Promise.resolve({
    ok: true,
    json: async () => ({
      models: [
        { key: longSlug1, display_name: "Dolphin Q2", type: "llm" },
        { key: longSlug2, display_name: "Dolphin Q4", type: "llm" },
      ],
    }),
  })
  t.after(() => { mockFetchImpl = null })

  const models = await discoverLmStudioModels()
  // Index 0 should resolve to first model, index 1 to second
  assert.equal(models[0].slug, longSlug1)
  assert.equal(models[1].slug, longSlug2)
  // Both share the same 54-char prefix — index-based resolution avoids ambiguity
  assert.equal(longSlug1.slice(0, 54), longSlug2.slice(0, 54), "slugs share prefix")
})

test("resolveIndexedModelSlug rejects stale fingerprint mismatch", () => {
  const models = [{ slug: "model-a" }, { slug: "model-b" }]
  const token = `#1:${fingerprintModelSlug("wrong-model")}`
  const resolved = resolveIndexedModelSlug(token, models)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, "fingerprint_mismatch")
})

test("resolveIndexedModelSlug rejects invalid fingerprint length", () => {
  const models = [{ slug: "model-a" }, { slug: "model-b" }]
  const resolved = resolveIndexedModelSlug("#1:abc", models)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, "invalid_token")
})

test("resolveIndexedModelSlug reports unavailable when model list is empty", () => {
  const resolved = resolveIndexedModelSlug(`#1:${fingerprintModelSlug("model-b")}`, [])
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, "unavailable")
})

test("resolveIndexedModelSlug resolves matching fingerprint", () => {
  const models = [{ slug: "model-a" }, { slug: "model-b" }]
  const token = `#1:${fingerprintModelSlug("model-b")}`
  const resolved = resolveIndexedModelSlug(token, models)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.slug, "model-b")
})
