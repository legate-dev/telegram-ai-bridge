import { readFile } from "node:fs/promises"
import { log } from "./log.js"

function fallbackRegistry(bridgeDefaultAgent) {
  const bridgeDefault = bridgeDefaultAgent || ""
  return {
    primaryAgents: bridgeDefault ? [bridgeDefault] : [],
    configuredDefault: "",
    bridgeDefault,
  }
}

export async function loadAgentRegistry(config) {
  const raw = await readFile(config.kiloConfigPath, "utf8")
  const data = JSON.parse(raw)
  const entries = data?.agent && typeof data.agent === "object" ? Object.entries(data.agent) : []

  const primaryAgents = entries
    .filter(([, meta]) => meta && typeof meta === "object" && meta.mode !== "subagent")
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right))

  const configuredDefault = typeof data?.default_agent === "string" ? data.default_agent : ""
  const bridgeDefault = primaryAgents.includes(config.bridgeDefaultAgent)
    ? config.bridgeDefaultAgent
    : primaryAgents.includes(configuredDefault)
      ? configuredDefault
      : primaryAgents[0] ?? ""

  return {
    primaryAgents,
    configuredDefault,
    bridgeDefault,
  }
}

export function createAgentRegistry(config) {
  let current = fallbackRegistry(config.bridgeDefaultAgent)
  let loadedOnce = false

  async function refresh() {
    try {
      current = await loadAgentRegistry(config)
      loadedOnce = true
      return current
    } catch (error) {
      log.warn(
        "agent-registry",
        loadedOnce ? "refresh_failed_keeping_last" : "load_failed_using_fallback",
        {
          config_path: config.kiloConfigPath,
          error: error.message,
          code: error.code,
          persist: true,
        },
      )
      return current
    }
  }

  function get() {
    return current
  }

  return { get, refresh }
}
