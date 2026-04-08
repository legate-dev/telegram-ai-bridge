const TELEGRAM_LIMIT = 4000

// Characters that must be escaped outside code blocks in MarkdownV2
const MD2_ESCAPE = /[_*\[\]()~`>#+\-=|{}.!\\]/g

export function escapeMarkdownV2(text) {
  return text.replace(MD2_ESCAPE, "\\$&")
}

/**
 * Format text for Telegram MarkdownV2, preserving code blocks.
 *
 * Code blocks (```...```) and inline code (`...`) are sent verbatim
 * (Telegram handles them natively). Everything else is escaped.
 */
export function formatForTelegram(input) {
  if (!input) return ""

  const segments = []
  let cursor = 0

  // Match fenced code blocks: ```lang?\n...\n``` or inline `...`
  const codePattern = /(```[\s\S]*?```|`[^`\n]+`)/g
  let match

  while ((match = codePattern.exec(input)) !== null) {
    // Text before this code span
    if (match.index > cursor) {
      segments.push(escapeMarkdownV2(input.slice(cursor, match.index)))
    }
    // Code span — pass through unescaped
    segments.push(match[0])
    cursor = match.index + match[0].length
  }

  // Remaining text after last code span
  if (cursor < input.length) {
    segments.push(escapeMarkdownV2(input.slice(cursor)))
  }

  return segments.join("")
}

export function extractAssistantText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const text = parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")

  return text
}

export function extractMessageError(message) {
  const error = message?.info?.error
  if (!error) return null
  const name = error?.name || "Unknown error"
  const detail = error?.data?.message || error?.message || ""
  return `${name}: ${detail}`.trim()
}

export function formatSessionStatus(status) {
  if (!status || typeof status !== "object") return ""

  if (status.type === "retry") {
    const next = typeof status.next === "number"
      ? new Date(status.next).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : ""
    const suffix = next ? ` Next retry window: ${next}.` : ""
    return `${status.message || "Kilo is retrying this request."}${suffix}`
  }

  if (status.type === "busy") {
    return "Kilo is still processing the current turn. Try again in a moment."
  }

  return ""
}

export function chunkText(input, limit = TELEGRAM_LIMIT) {
  if (input.length <= limit) return [input]

  const chunks = []
  let remaining = input

  while (remaining.length > limit) {
    // Prefer splitting at code block boundaries
    let index = remaining.lastIndexOf("\n```", limit)
    if (index > 0) {
      // Include the newline before ``` in current chunk
      index += 1
    } else {
      index = remaining.lastIndexOf("\n", limit)
    }
    if (index < Math.floor(limit / 2)) {
      index = remaining.lastIndexOf(" ", limit)
    }
    if (index < Math.floor(limit / 2)) {
      index = limit
    }
    chunks.push(remaining.slice(0, index).trim())
    remaining = remaining.slice(index).trimStart()
  }

  if (remaining) chunks.push(remaining)
  return chunks.filter(Boolean)
}
