import { execFileSync } from "node:child_process"
import { config } from "../config.js"

// ── Backend registry ──

const BACKENDS = {}

export function registerBackend(backend) {
  BACKENDS[backend.name] = backend
}

export function getBackend(cliName) {
  return BACKENDS[cliName] ?? null
}

export function supportedClis() {
  return Object.keys(BACKENDS).filter((name) => BACKENDS[name].supported)
}

// ── CLI availability detection ──

function isBinaryAvailable(binPath) {
  try {
    execFileSync("which", [binPath], { timeout: 2000 })
    return true
  } catch {
    return false
  }
}

export function detectAvailableClis() {
  // Kilo is HTTP-based so it is always considered available (checked via hasBinary short-circuit below).
  const binaries = {
    codex: config.binCodex,
    copilot: config.binCopilot,
    gemini: config.binGemini,
    claude: config.binClaude,
  }

  for (const [name, backend] of Object.entries(BACKENDS)) {
    const hasBinary = name === "kilo" || isBinaryAvailable(binaries[name])
    backend.supported = hasBinary
  }
}
