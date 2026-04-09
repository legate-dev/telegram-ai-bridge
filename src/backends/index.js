// ── Backend interface ──
// Every backend must implement:
//   sendMessage({ sessionId, directory, text, agent }) →
//     { text: string } | { error: string } | { question: { questions, precedingText } }
//   createSession({ title, directory }) → { id: string } | null
//   supported → boolean
//
// The { question } result is returned by KiloBackend when the AI calls
// mcp_question mid-turn. The caller should surface the question to the user
// and re-submit their answer as a new turn.

export { KiloBackend } from "./kilo.js"
export { CodexBackend } from "./codex.js"
export { CopilotBackend } from "./copilot.js"
export { GeminiBackend } from "./gemini.js"
export { ClaudeBackend } from "./claude.js"
export { registerBackend, getBackend, supportedClis, detectAvailableClis } from "./registry.js"
