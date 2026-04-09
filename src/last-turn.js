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
 * Supported CLIs: "claude" (JSONL on disk), "codex" (JSONL year/month/day tree),
 * "kilo" (HTTP via kiloClient). Other CLIs return null immediately.
 *
 * @param {string} cli - CLI name ("claude", "kilo", etc.)
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
    if (cli === "codex") {
      return await _readCodexLastTurn(sessionId)
    }
    if (cli === "kilo") {
      return await _readKiloLastTurn(sessionId, workspace, options.kiloClient)
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

// ── Codex ──

async function _readCodexLastTurn(sessionId) {
  const basePath = config.scanPathCodex
  if (!fs.existsSync(basePath)) return null

  const years = await fsp.readdir(basePath).catch(() => [])
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    const months = await fsp.readdir(path.join(basePath, year)).catch(() => [])
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      const days = await fsp.readdir(path.join(basePath, year, month)).catch(() => [])
      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue
        const dayPath = path.join(basePath, year, month, day)
        const files = await fsp.readdir(dayPath).catch(() => [])

        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue
          const filePath = path.join(dayPath, file)
          let raw
          try {
            raw = await fsp.readFile(filePath, "utf8")
          } catch {
            continue
          }

          const lines = raw.trim().split("\n").filter(Boolean)

          // Single pass: collect the file's session ID and all assistant events
          // regardless of line order — session_meta may appear after response_item lines.
          let fileSessionId = null
          let lastAssistantText = null
          for (const line of lines) {
            try {
              const entry = JSON.parse(line)
              if (entry.type === "session_meta" && entry.payload?.id) {
                fileSessionId = entry.payload.id
              }
              if (entry.type === "response_item" && entry.payload?.role === "assistant") {
                const text = entry.payload.content ?? entry.payload.text ?? entry.payload.output ?? null
                if (text && String(text).trim()) {
                  lastAssistantText = String(text).trim()
                }
              }
            } catch {
              // skip malformed lines
            }
          }

          if (fileSessionId !== sessionId) continue
          return lastAssistantText
        }
      }
    }
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
