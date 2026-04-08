import { readFile } from "node:fs/promises"

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
