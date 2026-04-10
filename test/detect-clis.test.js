import { mock, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// ── Mock state ──

// Controls which CLIs have sessions and which binaries exist
const mockSessionCounts = []
const availableBinaries = new Set()

await mock.module("../src/db.js", {
  namedExports: {
    sessionCountsByCli: () => mockSessionCounts,
    getLmStudioMessages: () => [],
    appendLmStudioMessage: () => {},
  },
})

await mock.module("../src/config.js", {
  namedExports: {
    config: {
      binCodex: "codex",
      binCopilot: "copilot",
      binGemini: "gemini",
      binClaude: "claude",
    },
  },
})

// Mock child_process so no real `which` calls happen
await mock.module("node:child_process", {
  namedExports: {
    execFile: () => {},
    execFileSync: (cmd, [bin]) => {
      if (cmd !== "which") throw new Error(`Unexpected command: ${cmd}`)
      if (!availableBinaries.has(bin)) {
        throw new Error(`not found: ${bin}`)
      }
    },
    // ClaudeBackend uses spawn — provide a no-op so the import succeeds
    spawn: () => ({ stdin: { write: () => {}, end: () => {} }, stdout: { on: () => {} }, stderr: { on: () => {} }, kill: () => {}, killed: false }),
  },
})

// Import after mocks are in place
const {
  KiloBackend,
  CodexBackend,
  CopilotBackend,
  GeminiBackend,
  ClaudeBackend,
  LmStudioBackend,
  registerBackend,
  supportedClis,
  detectAvailableClis,
} = await import("../src/backends.js")

// Register all backends once (mirrors what index.js does)
registerBackend(new KiloBackend({}))
registerBackend(new CodexBackend())
registerBackend(new CopilotBackend())
registerBackend(new GeminiBackend())
registerBackend(new ClaudeBackend())
registerBackend(new LmStudioBackend())

function resetMocks() {
  mockSessionCounts.length = 0
  availableBinaries.clear()
}

// ── Tests ──

test("non-binary backends default to supported=true; binary backends require installation", () => {
  resetMocks()
  // Run detection with no sessions and no binaries
  detectAvailableClis()
  const supported = supportedClis()
  // kilo and lmstudio are HTTP-based so they are always considered available
  assert.ok(supported.includes("kilo"), "kilo should always be supported (HTTP-based)")
  assert.ok(supported.includes("lmstudio"), "lmstudio should always be supported (HTTP-based)")
  // No CLI binary is installed
  assert.ok(!supported.includes("codex"), "codex should not be supported when not installed")
  assert.ok(!supported.includes("copilot"), "copilot should not be supported when not installed")
  assert.ok(!supported.includes("gemini"), "gemini should not be supported when not installed")
  assert.ok(!supported.includes("claude"), "claude should not be supported when not installed")
})

test("detectAvailableClis does not mark CLIs as supported from session history alone", () => {
  resetMocks()
  mockSessionCounts.push({ cli: "claude", count: 3 })
  mockSessionCounts.push({ cli: "codex", count: 1 })

  detectAvailableClis()

  const supported = supportedClis()
  assert.ok(!supported.includes("claude"), "claude should not be supported without a runnable binary")
  assert.ok(!supported.includes("codex"), "codex should not be supported without a runnable binary")
  assert.ok(!supported.includes("gemini"), "gemini should not be supported")
  assert.ok(!supported.includes("copilot"), "copilot should not be supported")
})

test("detectAvailableClis marks CLIs with available binary as supported", () => {
  resetMocks()
  availableBinaries.add("gemini")
  availableBinaries.add("copilot")

  detectAvailableClis()

  const supported = supportedClis()
  assert.ok(supported.includes("gemini"), "gemini should be supported (binary exists)")
  assert.ok(supported.includes("copilot"), "copilot should be supported (binary exists)")
  assert.ok(!supported.includes("claude"), "claude should not be supported")
  assert.ok(!supported.includes("codex"), "codex should not be supported")
})

test("HTTP-based backends always supported regardless of binary check", () => {
  resetMocks()
  // No binaries available, no sessions — kilo and lmstudio use HTTP so always on

  detectAvailableClis()

  const supported = supportedClis()
  assert.ok(supported.includes("kilo"), "kilo should always be supported (HTTP-based)")
  assert.ok(supported.includes("lmstudio"), "lmstudio should always be supported (HTTP-based)")
})

test("detectAvailableClis only marks CLIs supported when the runtime can execute them", () => {
  resetMocks()
  // claude has sessions, codex has binary
  mockSessionCounts.push({ cli: "claude", count: 5 })
  availableBinaries.add("codex")

  detectAvailableClis()

  const supported = supportedClis()
  assert.ok(supported.includes("kilo"), "kilo always supported")
  assert.ok(!supported.includes("claude"), "claude not supported when only session history exists")
  assert.ok(supported.includes("codex"), "codex supported via binary")
  assert.ok(!supported.includes("gemini"), "gemini not supported")
  assert.ok(!supported.includes("copilot"), "copilot not supported")
})

test("detectAvailableClis re-runs detection and updates state", () => {
  resetMocks()

  // First run: only claude binary
  availableBinaries.add("claude")
  detectAvailableClis()
  assert.ok(supportedClis().includes("claude"), "claude supported after first run")
  assert.ok(!supportedClis().includes("codex"), "codex not supported yet")

  // Second run: add codex binary too
  availableBinaries.add("codex")
  detectAvailableClis()
  assert.ok(supportedClis().includes("claude"), "claude still supported")
  assert.ok(supportedClis().includes("codex"), "codex now supported after re-detection")
})

test("session count of 0 does not mark CLI as supported", () => {
  resetMocks()
  mockSessionCounts.push({ cli: "gemini", count: 0 })

  detectAvailableClis()

  const supported = supportedClis()
  assert.ok(!supported.includes("gemini"), "gemini with 0 sessions is not supported")
})
