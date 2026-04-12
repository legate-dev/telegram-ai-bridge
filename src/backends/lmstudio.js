import { getLmStudioResponseId, setLmStudioResponseId } from "../db.js"
import { config } from "../config.js"
import { log } from "../log.js"

// ── LM Studio Backend (Native v1 API) ──
//
// Connects to a locally running LM Studio server via its native REST API
// (/api/v1/chat with stream:true). This endpoint is stateful — LM Studio
// manages conversation history server-side and returns a `response_id`
// that the bridge stores for session continuity via `previous_response_id`.
//
// Privacy: the bridge stores ONLY an opaque response_id per session.
// No conversation content is persisted by the bridge — all history
// lives in LM Studio's own storage.
//
// Config:
//   LMSTUDIO_BASE_URL          — LM Studio server URL (default http://127.0.0.1:1234)
//   LMSTUDIO_MODEL             — model identifier to request (default: auto-detect first loaded)
//   LMSTUDIO_TIMEOUT_MS        — request timeout in ms (default 120000)
//   LMSTUDIO_MAX_TOKENS        — max output tokens per response (default 2048)
//   LMSTUDIO_DETECT_TIMEOUT_MS — timeout for /api/v1/models probe (default 3000)
//   LMSTUDIO_API_TOKEN         — optional Bearer token for authenticated servers

/**
 * Fetch the first LLM model from LM Studio's native /api/v1/models endpoint.
 * Returns empty string if the server is unreachable or no models are available.
 * @param {string} baseUrl
 * @returns {Promise<string>}
 */
async function autoDetectModel(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/v1/models`, {
      signal: AbortSignal.timeout(config.lmstudioDetectTimeoutMs),
      headers: authHeaders(),
    })
    if (!res.ok) return ""
    const { models } = await res.json()
    const llms = (models ?? []).filter((m) => m.type === "llm")
    return llms[0]?.key ?? ""
  } catch {
    return ""
  }
}

/**
 * Build auth headers if LMSTUDIO_API_TOKEN is configured.
 * @returns {Record<string, string>}
 */
function authHeaders() {
  const headers = { "Content-Type": "application/json" }
  if (config.lmstudioApiToken) {
    headers["Authorization"] = `Bearer ${config.lmstudioApiToken}`
  }
  return headers
}

function parseSseEventBlock(rawBlock) {
  let eventType = null
  const dataLines = []

  for (const rawLine of rawBlock.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (!line || line.startsWith(":")) continue

    const sep = line.indexOf(":")
    const field = sep === -1 ? line : line.slice(0, sep)
    let value = sep === -1 ? "" : line.slice(sep + 1)
    if (value.startsWith(" ")) value = value.slice(1)

    if (field === "event") {
      eventType = value.trim()
    } else if (field === "data") {
      dataLines.push(value)
    }
  }

  const payload = dataLines.join("\n")
  if (!eventType && !payload.trim()) return null
  return { eventType, payload }
}

function extractMessageText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(extractMessageText).join("")
  if (!content || typeof content !== "object") return ""

  if (typeof content.text === "string") return content.text
  if (Array.isArray(content.text)) return content.text.map(extractMessageText).join("")
  if (typeof content.content === "string") return content.content
  if (Array.isArray(content.content)) return content.content.map(extractMessageText).join("")
  return ""
}

function extractMessageTextFromOutput(output) {
  if (!Array.isArray(output)) return ""
  return output
    .map((item) => {
      if (!item || typeof item !== "object") return ""
      if (item.type !== "message") return ""
      return extractMessageText(item.content ?? item.text ?? "")
    })
    .join("")
}

export class LmStudioBackend {
  constructor() {
    this.name = "lmstudio"
    this.supported = false
  }

  /**
   * Send a message to LM Studio and stream events via AsyncGenerator.
   *
   * Uses the native /api/v1/chat endpoint with SSE streaming. Events:
   *   { type: "text",     text: string }                         — message content chunk
   *   { type: "tool_use", toolName: string, toolInput: string, status: string } — tool call
   *   { type: "result",   sessionId: string, inputTokens, outputTokens, tokensPerSecond } — turn complete
   *   { type: "error",    message: string }                      — terminal error
   *
   * @param {{ sessionId: string, directory: string, text: string, model?: string }} opts
   */
  async *sendMessage({ sessionId, directory, text, model }) {
    void directory // LM Studio is HTTP-based — unused but accepted for interface parity

    const configuredModel = model || config.lmstudioModel
    const useModel = configuredModel || await autoDetectModel(config.lmstudioBaseUrl)

    // Retrieve the last response_id for this session (enables thread continuity)
    const previousResponseId = getLmStudioResponseId(sessionId)

    log.info("lmstudio.backend", "exec.start", {
      cli: "lmstudio",
      session_id: sessionId,
      model: useModel || "(none loaded)",
      text_length: text.length,
      has_previous_response: !!previousResponseId,
    })

    const body = {
      model: useModel,
      input: text,
      stream: true,
      max_output_tokens: config.lmstudioMaxTokens,
    }
    if (previousResponseId) body.previous_response_id = previousResponseId

    let response
    try {
      response = await fetch(`${config.lmstudioBaseUrl}/api/v1/chat`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.lmstudioTimeoutMs),
      })
    } catch (err) {
      const msg =
        err.name === "TimeoutError"
          ? `LM Studio timed out (${config.lmstudioTimeoutMs}ms)`
          : `LM Studio unreachable: ${err.message}`
      log.warn("lmstudio.backend", "exec.no_result", {
        cli: "lmstudio",
        session_id: sessionId,
        error: msg,
        persist: true,
      })
      yield { type: "error", message: msg }
      return
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => "")
      let detail = ""
      try { detail = JSON.parse(raw).error?.message ?? "" } catch {}
      const msg = detail || `LM Studio error ${response.status}`
      log.warn("lmstudio.backend", "exec.no_result", {
        cli: "lmstudio",
        session_id: sessionId,
        status: response.status,
        detail,
        persist: true,
      })
      yield { type: "error", message: msg }
      return
    }

    if (!response.body) {
      yield { type: "error", message: "LM Studio response has no body" }
      return
    }

    // ── SSE stream parsing ──
    // Native API uses named events: "event: <type>\ndata: <json>\n\n"
    // Parse by SSE block rather than individual lines so multi-line `data:`
    // payloads and arbitrary chunk boundaries remain valid.
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let fullResponse = ""
    let responseId = null
    let inputTokens = 0
    let outputTokens = 0

    try {
      let currentEvent = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")

        let boundary = buf.indexOf("\n\n")
        while (boundary !== -1) {
          const rawBlock = buf.slice(0, boundary)
          buf = buf.slice(boundary + 2)

          const parsed = parseSseEventBlock(rawBlock)
          if (!parsed) {
            boundary = buf.indexOf("\n\n")
            continue
          }

          currentEvent = parsed.eventType
          const payload = parsed.payload.trim()
          if (!payload || payload === "[DONE]") {
            currentEvent = null
            boundary = buf.indexOf("\n\n")
            continue
          }

          let data
          try { data = JSON.parse(payload) } catch {
            currentEvent = null
            boundary = buf.indexOf("\n\n")
            continue
          }

          switch (currentEvent) {
            case "message.delta":
              if (data.content) {
                fullResponse += data.content
                yield { type: "text", text: data.content }
              }
              break

            case "tool_call.start":
              yield {
                type: "tool_use",
                toolName: data.tool ?? "",
                toolInput: data.arguments ? JSON.stringify(data.arguments) : "",
                status: "start",
              }
              break

            case "tool_call.success":
              yield {
                type: "tool_use",
                toolName: data.tool ?? "",
                toolInput: data.arguments ? JSON.stringify(data.arguments) : "",
                status: "success",
                output: data.output,
              }
              break

            case "tool_call.failure":
              yield {
                type: "tool_use",
                toolName: data.metadata?.tool_name ?? "",
                toolInput: data.metadata?.arguments ? JSON.stringify(data.metadata.arguments) : "",
                status: "failure",
                reason: data.reason,
              }
              break

            case "error":
              // error is terminal for the consumer — yield and stop
              yield { type: "error", message: data.error?.message ?? "Unknown LM Studio error" }
              return

            case "chat.end": {
              const result = data.result ?? data
              responseId = result.response_id ?? null
              const stats = result.stats ?? {}
              inputTokens = stats.input_tokens ?? 0
              outputTokens = stats.total_output_tokens ?? 0

              // Persist the response_id for session continuity (opaque ID only, no content)
              if (responseId) {
                setLmStudioResponseId(sessionId, responseId)
              }

              // If streaming produced no text, extract from aggregated output
              if (!fullResponse && result.output) {
                const fallbackText = extractMessageTextFromOutput(result.output)
                if (fallbackText) {
                  fullResponse += fallbackText
                  yield { type: "text", text: fallbackText }
                }
              }

              if (!fullResponse) {
                yield { type: "error", message: "LM Studio returned no text content" }
                return
              }

              yield {
                type: "result",
                sessionId,
                inputTokens,
                outputTokens,
                tokensPerSecond: stats.tokens_per_second ?? null,
              }
              return
            }

            // Informational events — skip silently
            case "chat.start":
            case "model_load.start":
            case "model_load.progress":
            case "model_load.end":
            case "prompt_processing.start":
            case "prompt_processing.progress":
            case "prompt_processing.end":
            case "reasoning.start":
            case "reasoning.delta":
            case "reasoning.end":
            case "message.start":
            case "message.end":
            case "tool_call.arguments":
              break

            default:
              break
          }

          currentEvent = null
          boundary = buf.indexOf("\n\n")
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }

    // Stream closed without chat.end — treat as error regardless of accumulated text.
    // Without chat.end we have no response_id, so continuing would silently reset
    // the conversation thread (or resume from a stale previous_response_id).
    log.warn("lmstudio.backend", "exec.no_result", {
      cli: "lmstudio",
      session_id: sessionId,
      had_partial_text: !!fullResponse,
      persist: true,
    })
    yield { type: "error", message: fullResponse
      ? "LM Studio stream ended without completing — partial response discarded to preserve thread integrity"
      : "LM Studio closed connection without producing a result"
    }
  }

  /** No-op — LM Studio has no permission protocol. */
  replyPermission() {}

  async createSession({ title, directory }) {
    return { id: `lmstudio-${Date.now()}`, title, directory }
  }

  async abortSession() {}

  async getSessionStatus() {
    return null
  }
}
