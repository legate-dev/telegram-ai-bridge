import { getLmStudioMessages, appendLmStudioMessage } from "../db.js"
import { config } from "../config.js"
import { log } from "../log.js"
import { isChatModel } from "../model-discovery.js"

// ── LM Studio Backend ──
//
// Connects to a locally running LM Studio server via its OpenAI-compatible
// REST API (/v1/chat/completions with stream:true).
//
// Unlike CLI-based backends, LM Studio is stateless — the OpenAI-compatible
// endpoint has no built-in thread persistence. The bridge maintains
// per-session conversation history in SQLite and prepends it to every
// request so the model has full context.
//
// Config:
//   LMSTUDIO_BASE_URL          — LM Studio server URL (default http://127.0.0.1:1234)
//   LMSTUDIO_MODEL             — model identifier to request (default: auto-detect first loaded)
//   LMSTUDIO_TIMEOUT_MS        — request timeout in ms (default 120000)
//   LMSTUDIO_MAX_TOKENS        — max tokens per response (default 2048)
//   LMSTUDIO_DETECT_TIMEOUT_MS — timeout for auto-detect /v1/models probe (default 3000)

/**
 * Fetch the first non-embedding model from LM Studio's /v1/models endpoint.
 * Returns empty string if the server is unreachable or no models are loaded.
 * @param {string} baseUrl
 * @returns {Promise<string>}
 */
async function autoDetectModel(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(config.lmstudioDetectTimeoutMs),
    })
    if (!res.ok) return ""
    const { data } = await res.json()
    const chatModels = (data ?? []).filter(isChatModel)
    return chatModels[0]?.id ?? ""
  } catch {
    return ""
  }
}

export class LmStudioBackend {
  constructor() {
    this.name = "lmstudio"
    this.supported = false
  }

  /**
   * Send a message to LM Studio and stream events via AsyncGenerator.
   *
   * Yields:
   *   { type: "text",   text: string }
   *   { type: "result", sessionId: string, inputTokens: number, outputTokens: number }
   *   { type: "error",  message: string }  — terminal; generator ends after this
   *
   * Reasoning-only chunks (reasoning_content without content) are skipped so
   * Qwen3 / DeepSeek-R1 thinking tokens don't appear in the Telegram reply.
   *
   * @param {{ sessionId: string, directory: string, text: string, model?: string }} opts
   */
  async *sendMessage({ sessionId, directory, text, model }) {
    void directory // LM Studio is HTTP-based — directory is unused but accepted for interface parity
    const configuredModel = model || config.lmstudioModel
    const useModel = configuredModel || await autoDetectModel(config.lmstudioBaseUrl)

    const history = getLmStudioMessages(sessionId)
    const messages = [...history, { role: "user", content: text }]

    log.info("lmstudio.backend", "exec.start", {
      cli: "lmstudio",
      session_id: sessionId,
      model: useModel || "(none loaded)",
      text_length: text.length,
      history_length: history.length,
    })

    let response
    try {
      response = await fetch(`${config.lmstudioBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: useModel,
          messages,
          stream: true,
          max_tokens: config.lmstudioMaxTokens,
        }),
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
      const body = await response.text().catch(() => "")
      let detail = ""
      try { detail = JSON.parse(body).error?.message ?? "" } catch {}
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

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let fullResponse = ""
    let inputTokens = 0
    let outputTokens = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const payload = line.slice(6).trim()

          if (payload === "[DONE]") {
            if (!fullResponse) {
              yield { type: "error", message: "LM Studio returned no text content" }
              return
            }
            appendLmStudioMessage(sessionId, "user", text)
            appendLmStudioMessage(sessionId, "assistant", fullResponse)
            yield { type: "result", sessionId, inputTokens, outputTokens }
            return
          }

          let chunk
          try { chunk = JSON.parse(payload) } catch { continue }

          // Capture token counts when the server populates usage
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0
            outputTokens = chunk.usage.completion_tokens ?? 0
          }

          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue

          // Skip reasoning_content-only chunks (Qwen3 thinking mode, DeepSeek-R1)
          if (delta.content) {
            fullResponse += delta.content
            yield { type: "text", text: delta.content }
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }

    // Connection closed without [DONE]
    if (!fullResponse) {
      log.warn("lmstudio.backend", "exec.no_result", {
        cli: "lmstudio",
        session_id: sessionId,
        persist: true,
      })
      yield { type: "error", message: "LM Studio closed connection without producing a result" }
    } else {
      // Partial stream — save what we got
      appendLmStudioMessage(sessionId, "user", text)
      appendLmStudioMessage(sessionId, "assistant", fullResponse)
      yield { type: "result", sessionId, inputTokens, outputTokens }
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
