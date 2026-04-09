import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { config } from "./config.js"
import { extractAssistantText } from "./format.js"
import { log } from "./log.js"

/**
 * Attempt to read the last assistant turn from a CLI session's stored history.
 *
 * Returns the last assistant message as plain text, or null when the message
 * cannot be determined (unsupported CLI, file not found, parse error, empty
 * history). All errors are swallowed so a failure here never blocks the bind.
 *
 * Supported CLIs: "claude" (JSONL on disk), "kilo" (HTTP via kiloClient),
 * "copilot" (JSONL on disk), "gemini" (JSON on disk).
 * Other CLIs return null immediately.
 *
 * @param {string} cli - CLI name ("claude", "kilo", "copilot", "gemini", etc.)
 * @param {string} sessionId - Session identifier
 * @param {string} workspace - Workspace/directory path for the session
 * @param {{ kiloClient?: object }} [options]
 * @returns {Promise<string|null>}
 */
export async function readLastTurn(cli, sessionId, workspace, options = {}) {
  try {
    if (cli === "claude") {
      return await _readClaudeLastTurn(sessionId)
    }
    if (cli === "kilo") {
      return await _readKiloLastTurn(sessionId, workspace, options.kiloClient)
    }
    if (cli === "copilot") {
      return await _readCopilotLastTurn(sessionId)
    }
    if (cli === "gemini") {
      return await _readGeminiLastTurn(sessionId)
    }
    return null
  } catch (error) {
    log.debug("last-turn", "read_failed", {
      cli,
      session_id: sessionId,
      error: String(error),
    })
    return null
  }
}

// ── Claude ──

async function _readClaudeLastTurn(sessionId) {
  const basePath = config.scanPathClaude
  if (!fs.existsSync(basePath)) return null

  const folders = await fsp.readdir(basePath).catch(() => [])

  for (const folder of folders) {
    // Claude workspace folders are encoded paths that start with "-"
    if (!folder.startsWith("-")) continue

    const filePath = path.join(basePath, folder, `${sessionId}.jsonl`)
    let raw
    try {
      raw = await fsp.readFile(filePath, "utf8")
    } catch {
      // File doesn't exist in this folder; try the next one
      continue
    }

    const lines = raw.trim().split("\n").filter(Boolean)
    // Scan from the end to find the most-recent assistant entry
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i])
        if (entry.type !== "assistant") continue
        const msgContent = entry.message?.content
        if (!msgContent) continue
        let text
        if (typeof msgContent === "string") {
          text = msgContent
        } else if (Array.isArray(msgContent)) {
          text = msgContent
            .filter((b) => b?.type === "text" && b.text)
            .map((b) => b.text)
            .join("\n\n")
        }
        if (text?.trim()) return text.trim()
      } catch {
        // skip malformed lines
      }
    }
    // Found the file but no assistant text in it
    return null
  }

  return null
}

// ── Kilo ──

async function _readKiloLastTurn(sessionId, workspace, kiloClient) {
  if (!kiloClient) return null

  const messages = await kiloClient.getMessages(sessionId, workspace)
  if (!Array.isArray(messages) || messages.length === 0) return null

  // Walk backwards to find the most-recent assistant message with text
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.info?.role !== "assistant") continue
    const text = extractAssistantText(msg)
    if (text?.trim()) return text.trim()
  }

  return null
}

// ── Copilot ──

async function _readCopilotLastTurn(sessionId) {
  const filePath = path.join(config.scanPathCopilot, `${sessionId}.jsonl`)
  let raw
  try {
    raw = await fsp.readFile(filePath, "utf8")
  } catch {
    return null
  }

  const lines = raw.trim().split("\n").filter(Boolean)
  // Scan from the end to find the most-recent assistant.message entry
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i])
      if (event.type === "assistant.message" && event.data?.content) {
        return event.data.content
      }
    } catch {
      // skip malformed lines
    }
  }

  return null
}

// ── Gemini ──

async function _readGeminiLastTurn(sessionId) {
  const filePath = path.join(config.scanPathGemini, `${sessionId}.json`)
  let raw
  try {
    raw = await fsp.readFile(filePath, "utf8")
  } catch {
    return null
  }

  try {
    const parsed = JSON.parse(raw)
    const text = parsed.response || parsed.content || parsed.text
    if (typeof text !== "string") return null
    const trimmed = text.trim()
    return trimmed || null
  } catch {
    return null
  }
}
