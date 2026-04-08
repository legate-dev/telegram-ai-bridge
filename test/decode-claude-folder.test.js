import { after, mock, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Mock module dependencies so cli-scanner can be imported in isolation.
// config values are irrelevant here since we call decodeClaudeFolder directly.
// All three symbols must be provided because src/cli-scanner.js imports them
// from ./db.js: upsertCliSession (core), reconcileCliSessions (added in #59),
// getCliSessionById (added in #71 for per-session message_count cache lookup).
await mock.module("../src/db.js", {
  namedExports: {
    upsertCliSession: () => {},
    reconcileCliSessions: () => {},
    getCliSessionById: () => null,
  },
})
await mock.module("../src/log.js", {
  namedExports: {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  },
})
await mock.module("../src/config.js", {
  namedExports: {
    config: {
      scanPathClaude: "/nonexistent",
      scanPathCodex: "/nonexistent",
      scanPathCopilot: "/nonexistent",
      scanPathQwen: "/nonexistent",
      scanPathGemini: "/nonexistent",
      scanPathKilo: "/nonexistent",
    },
  },
})

const { decodeClaudeFolder } = await import("../src/cli-scanner.js")

// ── Fixture setup ──
//
// Create a tmpdir INSIDE $HOME so the decoded paths pass the security boundary
// check in decodeClaudeFolder (canonical path must start with os.homedir() + "/").
// Using a "cdt-" prefix ensures the basename itself contains a hyphen, which
// forces the greedy algorithm to kick in when resolving that segment too.

const tmpDir = fs.mkdtempSync(path.join(os.homedir(), "cdt-"))
process.on("exit", () => {
  try { fs.rmSync(tmpDir, { recursive: true }) } catch {}
})

// Directory tree:
//   $HOME/cdt-XXXXXX/          ← tmpDir (basename contains a hyphen — greedy test for tmpBase)
//     my-project/              ← hyphen in name → greedy "-" join
//     my_lib/                  ← underscore in name → greedy "_" join (encoded as "my-lib")
//     .config/                 ← dotfile → greedy "." join on empty part from "--config"
fs.mkdirSync(path.join(tmpDir, "my-project"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, "my_lib"), { recursive: true })
fs.mkdirSync(path.join(tmpDir, ".config"), { recursive: true })

// Claude encodes a path by replacing every `/`, `.`, and `_` with `-`.
// Pre-existing `-` chars in directory names are left as-is, creating
// ambiguity that the greedy algorithm must resolve.
function encode(absPath) {
  return absPath.replace(/[/._]/g, "-")
}

// ── Tests ──

test("decodeClaudeFolder: greedy hyphen — resolves hyphenated dir (not split segments)", async () => {
  // target: $HOME/cdt-XXXXXX/my-project
  // encoded: -home-...-cdt-XXXXXX-my-project
  // old replace(/-/g,"/"): /home/.../cdt/XXXXXX/my/project (wrong)
  // new greedy: finds cdt-XXXXXX in $HOME, then my-project inside it (correct)
  const target = path.join(tmpDir, "my-project")
  const folderName = encode(target)

  const decoded = await decodeClaudeFolder(folderName)

  assert.equal(decoded, target,
    "greedy '-' join should resolve the hyphenated directory name correctly")
})

test("decodeClaudeFolder: greedy underscore — resolves underscore dir from hyphen-encoded name", async () => {
  // Directory on disk: my_lib (underscore)
  // Claude encodes '_' as '-', so folder ends with "-my-lib"
  // Greedy tries "-" join (my-lib → absent), then "_" join (my_lib → found)
  const target = path.join(tmpDir, "my_lib")
  const folderName = encode(target)  // ends with "-my-lib"

  const decoded = await decodeClaudeFolder(folderName)

  assert.equal(decoded, target,
    "greedy '_' join should recover an underscore directory from its hyphen-encoded form")
})

test("decodeClaudeFolder: dotfile — resolves .config from double-dash encoded name", async () => {
  // Directory on disk: .config
  // Claude encodes '.' as '-', so the leading dot becomes '-': folder has "--config"
  // Splitting "...-XXXXXX--config" by "-" yields [..., "", "config"].
  // Greedy tries ["","config"].join(".") → ".config" which exists on disk.
  const target = path.join(tmpDir, ".config")
  const folderName = encode(target)  // ends with "--config"

  const decoded = await decodeClaudeFolder(folderName)

  assert.equal(decoded, target,
    "greedy '.' join on empty+name parts should resolve a dotfile directory")
})

test("decodeClaudeFolder: returns /unknown for path outside HOME", async () => {
  // "-etc-passwd" would decode to /etc/passwd which is outside HOME
  const decoded = await decodeClaudeFolder("-etc-passwd")

  assert.equal(decoded, "/unknown",
    "decoded path outside HOME should be rejected with /unknown")
})

test("decodeClaudeFolder: returns /unknown when depth exceeds MAX_DEPTH (20)", async () => {
  // Build a folder whose encoded form has 21 path segments (strip leading "-",
  // split on "-" → 21 parts). Each greedy iteration consumes at least 1 part,
  // so the loop runs 21 times; on the 21st ++depth (21 > MAX_DEPTH=20) fires.
  const deepFolder = "-" + Array(21).fill("a").join("-")

  const decoded = await decodeClaudeFolder(deepFolder)

  assert.equal(decoded, "/unknown",
    "folder with more than MAX_DEPTH=20 segments should return /unknown")
})

// ── Symlink traversal regression tests ──
//
// Creates separate tmp dirs INSIDE $HOME that mimic ~/.claude/projects/
// entries containing a symlink pointing OUTSIDE home.
//
// Two distinct properties are tested:
//
//  Option B (realpath boundary check): the final resolved path is followed
//    through any remaining symlinks; if the real target is outside HOME the
//    function returns /unknown. The symlink name has NO hyphens so the greedy
//    algorithm is unaffected by Option A — this test targets Option B alone.
//
//  Option A (readdir symlink-filter): the symlink is filtered from directory
//    entries during traversal so the greedy algorithm never builds a path
//    through the symlink target. The symlink name MUST contain a hyphen so
//    the greedy can form it as a multi-part candidate from entries (a
//    hyphen-free name would use parts[i] directly regardless). An extra
//    segment after the symlink is added to trigger a readdir call on the
//    symlink's target in the next loop iteration if the filter were absent.
//
// Cleanup uses after() (not process.on("exit")) because exit handlers must
// be synchronous and cannot await the async fs.rm call.
// ── Option B: final realpath check rejects symlink whose target is outside HOME ──
{
  const symlinkFixtureDir = fs.mkdtempSync(path.join(os.homedir(), "cdt-sym-"))

  after(async () => {
    await fsp.rm(symlinkFixtureDir, { recursive: true }).catch(() => {})
  })

  // Symlink name has NO hyphens. The greedy algorithm uses parts[i] directly
  // (bestLen=1) regardless of what entries contains, so Option A's filtering
  // has no effect here. The decoded path terminates at the symlink itself and
  // the realpath boundary check (Option B) rejects it.
  const symlinkName = "extlink"
  const symlinkPath = path.join(symlinkFixtureDir, symlinkName)
  fs.symlinkSync(os.tmpdir(), symlinkPath)

  test("decodeClaudeFolder: symlink inside fixture pointing outside HOME → /unknown", async () => {
    const target = path.join(symlinkFixtureDir, symlinkName)
    const folderName = encode(target)

    const decoded = await decodeClaudeFolder(folderName, new Map())

    assert.equal(decoded, "/unknown",
      "a symlink pointing outside HOME should be rejected with /unknown")
  })
}

// ── lstat guard: per-iteration check prevents readdir on hyphen-free symlink target ──
{
  const lstatFixtureDir = fs.mkdtempSync(path.join(os.homedir(), "cdt-lstat-"))

  after(async () => {
    await fsp.rm(lstatFixtureDir, { recursive: true }).catch(() => {})
  })

  // Symlink name has NO hyphens ("extlink"). The greedy algorithm falls back to
  // bestSegment = parts[i] unconditionally when no entry in entries matches —
  // this fallback is independent of the readdir symlink filter. After appending
  // "extlink" to resolved, the NEXT iteration would call readdir(resolved) where
  // resolved ends at the symlink, causing OS-level traversal into os.tmpdir().
  // The lstat guard at the top of each iteration detects the symlink and rejects
  // before any readdir call can follow it.
  fs.symlinkSync(os.tmpdir(), path.join(lstatFixtureDir, "extlink"))

  test("decodeClaudeFolder: lstat guard prevents readdir on hyphen-free symlink target", async (t) => {
    const origReaddir = fsp.readdir
    const readdirPaths = []
    t.mock.method(fsp, "readdir", (...args) => {
      readdirPaths.push(String(args[0]))
      return origReaddir.apply(fsp, args)
    })

    // Encode lstatFixtureDir/extlink/subdir — the "subdir" segment forces
    // a readdir call in the iteration after "extlink" is resolved. Without
    // the lstat guard, that readdir would follow the symlink into os.tmpdir().
    const folderName = encode(path.join(lstatFixtureDir, "extlink", "subdir"))
    const result = await decodeClaudeFolder(folderName, new Map())

    assert.equal(result, "/unknown",
      "decoder must return /unknown when a hyphen-free symlink is encountered")

    const externalDir = os.tmpdir()
    const calledOnExternal = readdirPaths.some(
      (p) => p === externalDir || p.startsWith(externalDir + path.sep)
    )
    assert.equal(calledOnExternal, false,
      "readdir must not be called on the external symlink target (lstat guard)")
  })
}

// ── Option A: readdir filter prevents traversal into external symlink target ──
{
  const rdspyFixtureDir = fs.mkdtempSync(path.join(os.homedir(), "cdt-rdspy-"))

  after(async () => {
    await fsp.rm(rdspyFixtureDir, { recursive: true }).catch(() => {})
  })

  // Symlink name CONTAINS a hyphen so the greedy algorithm can form it as a
  // 2-part candidate ("ext" + "link") from entries. Without Option A the
  // filter, entries includes "ext-link" and the greedy matches it; the next
  // loop iteration then calls readdir on the symlink's target (os.tmpdir()).
  // With Option A in place, "ext-link" is absent from entries and bestLen
  // stays at 1 — the decoder never descends into the symlink target at all.
  fs.symlinkSync(os.tmpdir(), path.join(rdspyFixtureDir, "ext-link"))

  test("decodeClaudeFolder: readdir not called on external symlink target (Option A)", async (t) => {
    // Spy on fsp.readdir, recording every directory path it is called with.
    // Both this file and cli-scanner.js import the same fsp singleton, so
    // this mock intercepts calls made inside decodeClaudeFolder.
    const origReaddir = fsp.readdir
    const readdirPaths = []
    t.mock.method(fsp, "readdir", (...args) => {
      readdirPaths.push(String(args[0]))
      return origReaddir.apply(fsp, args)
    })

    // Encode a path through the hyphenated symlink plus one extra segment
    // ("subdir"). Without Option A: greedy matches "ext-link" (2 parts from
    // entries), resolves to rdspyFixtureDir/ext-link = os.tmpdir(), and the
    // next iteration calls readdir(os.tmpdir()). With Option A: "ext-link" is
    // filtered, bestLen=1 ("ext"), and the decoder never reaches os.tmpdir().
    const folderName = encode(path.join(rdspyFixtureDir, "ext-link", "subdir"))
    await decodeClaudeFolder(folderName, new Map())

    const externalDir = os.tmpdir()
    const calledOnExternal = readdirPaths.some(
      (p) => p === externalDir || p.startsWith(externalDir + path.sep)
    )
    assert.equal(calledOnExternal, false,
      "readdir must not be called on the external symlink target (symlink-filtering, Option A)")
  })
}
