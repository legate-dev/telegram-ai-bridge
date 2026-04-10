// ── Backend interface ──
// Every backend must implement:
//   sendMessage({ sessionId, directory, text, agent, model }) →
//     Promise<{ text, threadId? } | { error } | { question } | { permission, messageCountBefore }>
//     OR AsyncGenerator<event>  ← used by ClaudeBackend
//   createSession({ title, directory }) → { id: string } | null
//   supported → boolean
//
// AsyncGenerator backends (Claude) yield typed events:
//   { type: "text", content }  |  { type: "thinking", content }
//   { type: "tool_use", toolName, toolInput }
//   { type: "permission", requestId, toolName, toolInput, toolInputRaw }
//   { type: "question", requestId, questions[] }
//   { type: "result", sessionId, inputTokens, outputTokens }
//   { type: "error", message }
//
// AsyncGenerator backends also expose replyPermission(requestId, "allow"|"deny")
// so the perm: callback handler can write control_response to Claude's stdin.
//
// Promise backends (Kilo, Codex, Copilot, Gemini) use the legacy shape:
//   { question } — KiloBackend when AI calls mcp_question mid-turn
//   { permission, messageCountBefore } — KiloBackend when tool approval is required

export { KiloBackend } from "./kilo.js"
export { CodexBackend } from "./codex.js"
export { CopilotBackend } from "./copilot.js"
export { GeminiBackend } from "./gemini.js"
export { ClaudeBackend } from "./claude.js"
export { LmStudioBackend } from "./lmstudio.js"
export { registerBackend, getBackend, supportedClis, detectAvailableClis } from "./registry.js"
