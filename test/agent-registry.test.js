import { writeFile, rm, mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

const { loadAgentRegistry } = await import("../src/agent-registry.js")

function makeConfig(overrides = {}) {
  return { kiloConfigPath: "/nonexistent", bridgeDefaultAgent: "codex", ...overrides }
}

async function withTmpConfig(data, fn) {
  const dir = await mkdtemp(join(tmpdir(), "tbridge-agent-"))
  const configPath = join(dir, "kilo.json")
  await writeFile(configPath, JSON.stringify(data))
  try {
    await fn(configPath)
  } finally {
    await rm(dir, { recursive: true })
  }
}

// ── Primary agent filtering ──

test("loadAgentRegistry excludes subagents from primaryAgents", async () => {
  await withTmpConfig(
    {
      agent: {
        sub1: { mode: "subagent" },
        primary1: {},
        sub2: { mode: "subagent" },
        primary2: { mode: "chat" },
      },
    },
    async (configPath) => {
      const result = await loadAgentRegistry(makeConfig({ kiloConfigPath: configPath }))
      assert.ok(!result.primaryAgents.includes("sub1"), "sub1 must be excluded")
      assert.ok(!result.primaryAgents.includes("sub2"), "sub2 must be excluded")
      assert.ok(result.primaryAgents.includes("primary1"), "primary1 must be included")
      assert.ok(result.primaryAgents.includes("primary2"), "primary2 must be included")
    },
  )
})

test("loadAgentRegistry returns primaryAgents sorted alphabetically", async () => {
  await withTmpConfig(
    {
      agent: {
        zebra: {},
        alpha: { mode: "primary" },
        middle: {},
      },
      default_agent: "zebra",
    },
    async (configPath) => {
      const result = await loadAgentRegistry(makeConfig({ kiloConfigPath: configPath }))
      assert.deepEqual(result.primaryAgents, ["alpha", "middle", "zebra"])
    },
  )
})

// ── bridgeDefault selection ──

test("loadAgentRegistry picks bridgeDefaultAgent when it appears in primaryAgents", async () => {
  await withTmpConfig(
    {
      agent: { codex: {}, sonnet: {} },
      default_agent: "sonnet",
    },
    async (configPath) => {
      const result = await loadAgentRegistry(makeConfig({ kiloConfigPath: configPath, bridgeDefaultAgent: "codex" }))
      assert.equal(result.bridgeDefault, "codex")
    },
  )
})

test("loadAgentRegistry falls back to configuredDefault when bridgeDefaultAgent is absent from primaryAgents", async () => {
  await withTmpConfig(
    {
      agent: { sonnet: {}, haiku: {} },
      default_agent: "sonnet",
    },
    async (configPath) => {
      const result = await loadAgentRegistry(makeConfig({ kiloConfigPath: configPath, bridgeDefaultAgent: "missing-agent" }))
      assert.equal(result.bridgeDefault, "sonnet")
    },
  )
})

test("loadAgentRegistry falls back to the first primary agent when neither default is found", async () => {
  await withTmpConfig(
    {
      agent: { beta: {}, alpha: {} },
      default_agent: "no-such-default",
    },
    async (configPath) => {
      const result = await loadAgentRegistry(makeConfig({ kiloConfigPath: configPath, bridgeDefaultAgent: "also-missing" }))
      // Alphabetical sort makes alpha the first primary agent
      assert.equal(result.bridgeDefault, "alpha")
    },
  )
})

// ── configuredDefault ──

test("loadAgentRegistry reads configuredDefault from data.default_agent string", async () => {
  await withTmpConfig(
    {
      agent: { opus: {}, sonnet: {} },
      default_agent: "opus",
    },
    async (configPath) => {
      const result = await loadAgentRegistry(makeConfig({ kiloConfigPath: configPath }))
      assert.equal(result.configuredDefault, "opus")
    },
  )
})

test("loadAgentRegistry sets configuredDefault to empty string when default_agent is absent", async () => {
  await withTmpConfig(
    { agent: { alpha: {} } },
    async (configPath) => {
      const result = await loadAgentRegistry(makeConfig({ kiloConfigPath: configPath }))
      assert.equal(result.configuredDefault, "")
    },
  )
})

// ── Empty / missing agent section ──

test("loadAgentRegistry returns empty results when the agent section is absent", async () => {
  await withTmpConfig(
    {},
    async (configPath) => {
      const result = await loadAgentRegistry(makeConfig({ kiloConfigPath: configPath }))
      assert.deepEqual(result.primaryAgents, [])
      assert.equal(result.configuredDefault, "")
      assert.equal(result.bridgeDefault, "")
    },
  )
})

test("loadAgentRegistry returns empty results when agent section is not an object", async () => {
  await withTmpConfig(
    { agent: "not-an-object" },
    async (configPath) => {
      const result = await loadAgentRegistry(makeConfig({ kiloConfigPath: configPath }))
      assert.deepEqual(result.primaryAgents, [])
    },
  )
})

// ── Error handling ──

test("loadAgentRegistry throws ENOENT when the config file does not exist", async () => {
  await assert.rejects(
    () => loadAgentRegistry(makeConfig({ kiloConfigPath: "/nonexistent/path/config.json" })),
    { code: "ENOENT" },
  )
})
