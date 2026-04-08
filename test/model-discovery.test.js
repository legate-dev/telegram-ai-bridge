import { mock, test } from "node:test"
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
}

await mock.module("../src/config.js", {
  namedExports: { config: mockConfig },
})

const { discoverCodexModels, discoverClaudeModels, getModelsForCli } = await import("../src/model-discovery.js")

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

test("getModelsForCli returns null for kilo", () => {
  assert.equal(getModelsForCli("kilo"), null)
})

test("getModelsForCli returns null for copilot", () => {
  assert.equal(getModelsForCli("copilot"), null)
})

test("getModelsForCli returns null for gemini", () => {
  assert.equal(getModelsForCli("gemini"), null)
})

test("getModelsForCli returns null for unknown CLI", () => {
  assert.equal(getModelsForCli("qwen"), null)
})

test("getModelsForCli returns array for claude with at least static aliases", () => {
  mockConfig.claudeConfigPath = validClaudeConfigPath
  const result = getModelsForCli("claude")
  assert.ok(Array.isArray(result))
  assert.ok(result.length >= 3)
  const slugs = result.map((m) => m.slug)
  assert.ok(slugs.includes("opus"))
  assert.ok(slugs.includes("sonnet"))
  assert.ok(slugs.includes("haiku"))
})

test("getModelsForCli returns array for codex", () => {
  mockConfig.codexModelsCachePath = validCodexCachePath
  const result = getModelsForCli("codex")
  assert.ok(Array.isArray(result))
  assert.ok(result.length > 0)
})
