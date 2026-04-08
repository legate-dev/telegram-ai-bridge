import path from "node:path"

/**
 * Generate a meaningful session title of the form `{workspace-basename} — {MonDD-HHmm}`.
 * Falls back to `session` as the prefix when the directory is the bridge's own CWD or ".".
 */
export function generateSessionTitle(directory) {
  const resolved = directory ? path.resolve(directory) : process.cwd()
  const basename = path.basename(resolved)
  const prefix = (!basename || basename === "." || resolved === process.cwd()) ? "session" : basename

  const now = new Date()
  const month = now.toLocaleString("en-US", { month: "short", timeZone: "UTC" })
  const day = String(now.getUTCDate()).padStart(2, "0")
  const hours = String(now.getUTCHours()).padStart(2, "0")
  const minutes = String(now.getUTCMinutes()).padStart(2, "0")
  const suffix = `${month}${day}-${hours}${minutes}`

  return `${prefix} \u2014 ${suffix}`
}

// NOTE: `isBridgeSessionTitle` was removed when bridge ownership detection
// changed to use the deterministic `source='bridge'` flag on `cli_sessions`
// (set by createNewSession), NOT title pattern matching. See
// `getKiloBridgeSessions()` in `db.js` for the canonical query.
// Do NOT reintroduce a title-based heuristic — it caused multiple
// false-positive deletions.
