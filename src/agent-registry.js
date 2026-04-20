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
  let fallbackWarned = false
  let lastRefreshOk = false
  let inFlight = null

  async function doRefresh() {
    try {
      current = await loadAgentRegistry(config)
      loadedOnce = true
      lastRefreshOk = true
      return current
    } catch (error) {
      const meta = {
        config_path: config.kiloConfigPath,
        error: error.message,
        code: error.code,
      }
      if (loadedOnce) {
        // Persist only the transition from OK to broken; subsequent failures
        // while still broken use persist:false to avoid log-store spam when
        // /agents or /agent is invoked repeatedly against a broken config.
        log.warn("agent-registry", "refresh_failed_keeping_last", { ...meta, persist: lastRefreshOk })
      } else if (!fallbackWarned) {
        log.warn("agent-registry", "load_failed_using_fallback", { ...meta, persist: true })
        fallbackWarned = true
      } else {
        log.warn("agent-registry", "refresh_failed_still_fallback", { ...meta, persist: false })
      }
      lastRefreshOk = false
      return current
    }
  }

  function refresh() {
    // Coalesce concurrent callers onto the same in-flight read so two rapid
    // /agents or /agent invocations cannot race and overwrite `current` with
    // a stale snapshot.
    if (inFlight) return inFlight
    const p = doRefresh()
    inFlight = p
    p.finally(() => {
      if (inFlight === p) inFlight = null
    })
    return p
  }

  function get() {
    return current
  }

  function hasLoaded() {
    return loadedOnce
  }

  return { get, refresh, hasLoaded }
}
