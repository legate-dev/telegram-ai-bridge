import fs from "node:fs"
import path from "node:path"
import { config } from "./config.js"
import { persistLogEvent } from "./log-store.js"

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const threshold = LEVELS[config.logLevel] ?? LEVELS.info
let logDirectoryReady = false
let logStream = null

function ensureParent(filePath) {
  if (logDirectoryReady) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  logDirectoryReady = true
}

function getStream() {
  if (!logStream) {
    ensureParent(config.logFilePath)
    logStream = fs.createWriteStream(config.logFilePath, { flags: "a" })
    logStream.on("error", (err) => {
      process.stderr.write(`log stream error: ${err.message}\n`)
      logStream = null
    })
  }
  return logStream
}

export function flushLogFile() {
  return new Promise((resolve) => {
    if (!logStream) return resolve()
    const stream = logStream
    logStream = null
    stream.once("finish", resolve)
    stream.once("error", resolve)
    stream.end()
  })
}

export function redactString(value) {
  if (typeof value !== "string") return value

  let output = value
  if (config.telegramBotToken) {
    output = output.replaceAll(config.telegramBotToken, "<REDACTED>")
  }
  if (config.kiloServerPassword) {
    output = output.replaceAll(config.kiloServerPassword, "<REDACTED>")
  }

  return output
    // Telegram bot URL
    .replace(/\/bot[0-9]+:[A-Za-z0-9_-]+\//g, "/bot<REDACTED>/")
    // Authorization headers (Bearer before Basic to ensure Bearer is matched specifically)
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, "Authorization: Bearer <REDACTED>")
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic <REDACTED>")
    .replace(/"Authorization"\s*:\s*"Bearer\s+[A-Za-z0-9._\-~+/=]+"/gi, '"Authorization":"Bearer <REDACTED>"')
    .replace(/"Authorization"\s*:\s*"Basic\s+[A-Za-z0-9+/=]+"/gi, '"Authorization":"Basic <REDACTED>"')
    // Bare Bearer tokens (not inside an Authorization header) — defense in depth
    // against error messages that quote the token without the header prefix
    .replace(/\bBearer\s+[A-Za-z0-9._\-~+/=]{16,}/g, "Bearer <REDACTED>")
    // Generic credentials in URLs: https://user:pass@host
    .replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)@/gi, "$1<REDACTED>:<REDACTED>@")
    // LLM API key patterns — include dash-separated prefixes so modern keys like
    // sk-ant-api03-..., sk-proj-..., sk-svcacct-... are captured (the legacy
    // [A-Za-z0-9]{20,} quantifier stopped at the first dash inside the key body).
    .replace(/sk-ant-api\d{2,3}-[A-Za-z0-9_\-]{20,}/g, "sk-ant-<REDACTED>")
    .replace(/sk-(?:proj|svcacct)-[A-Za-z0-9_\-]{20,}/g, "sk-<REDACTED>")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-<REDACTED>")
    .replace(/key-[A-Za-z0-9]{20,}/g, "key-<REDACTED>")
    .replace(/AIzaSy[A-Za-z0-9_-]{33}/g, "<REDACTED>")
    // GitHub tokens — classic PATs, fine-grained PATs, server/refresh/oauth
    .replace(/github_pat_[A-Za-z0-9_]{70,}/g, "github_pat_<REDACTED>")
    .replace(/\bgh[pusro]_[A-Za-z0-9]{36,}/g, "gh_<REDACTED>")
    // GitLab personal access tokens
    .replace(/\bglpat-[A-Za-z0-9_\-]{20,}/g, "glpat-<REDACTED>")
    // HuggingFace tokens
    .replace(/\bhf_[A-Za-z0-9]{20,}/g, "hf_<REDACTED>")
    // Supabase service/anon/publishable keys (sbp_, sbv_, sbs_)
    .replace(/\bsb[pvs]_[A-Za-z0-9_\-]{20,}/g, "sb_<REDACTED>")
    // Stripe keys
    .replace(/(sk|pk|rk)_(live|test)_[A-Za-z0-9]{24,}/g, "$1_$2_<REDACTED>")
    // Slack tokens
    .replace(/xox[bpars]-[A-Za-z0-9-]{10,}/g, "xox_<REDACTED>")
    // AWS access key IDs
    .replace(/(?:AKIA|ASIA)[0-9A-Z]{16}/g, "<REDACTED>")
    // GCP service account JSON private_key field (single-line or escaped newlines)
    .replace(/"private_key"\s*:\s*"[^"]+"/g, '"private_key":"<REDACTED>"')
    // JWT: eyJ-prefixed header followed by two more base64url segments
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<REDACTED_JWT>")
}

function sanitize(value, depth = 0) {
  if (depth > 5) return "[MaxDepth]"
  if (value == null) return value
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      code: value.code,
      cause: sanitize(value.cause, depth + 1),
    }
  }
  if (typeof value === "string") return redactString(value)
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1))
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, sanitize(entryValue, depth + 1)]),
    )
  }
  return value
}

function rotateIfNeeded(filePath) {
  let size
  try {
    size = fs.statSync(filePath).size
  } catch {
    return
  }
  if (size < config.logMaxFileSize) return

  // Release the current stream; it will drain naturally to the renamed file
  // (on POSIX the open fd follows the inode, not the path).
  logStream = null

  const { dir, name } = path.parse(filePath)

  // Shift rotated files up; the oldest (at index logMaxFiles) is overwritten
  for (let i = config.logMaxFiles - 1; i >= 1; i--) {
    const src = path.join(dir, `${name}.${i}.ndjson`)
    if (!fs.existsSync(src)) continue
    fs.renameSync(src, path.join(dir, `${name}.${i + 1}.ndjson`))
  }

  // Rotate the current log to .1.ndjson
  try {
    fs.renameSync(filePath, path.join(dir, `${name}.1.ndjson`))
  } catch {
    // Ignore rename failures
  }

  // Create the new log file synchronously so callers can stat/existsSync it
  // immediately after rotation.
  try {
    fs.closeSync(fs.openSync(filePath, "a"))
  } catch {
    // Ignore creation failures
  }
}

function writeLine(line, level) {
  rotateIfNeeded(config.logFilePath)
  getStream().write(`${line}\n`)
  if (level >= LEVELS.warn) {
    process.stderr.write(`${line}\n`)
    return
  }
  process.stdout.write(`${line}\n`)
}

function emit(levelName, scope, event, data = {}) {
  const level = LEVELS[levelName] ?? LEVELS.info
  if (level < threshold) return

  const payload = sanitize(data)
  const persist = payload.persist === true || level >= LEVELS.warn
  if (payload && typeof payload === "object" && "persist" in payload) {
    delete payload.persist
  }

  const entry = {
    ts: new Date().toISOString(),
    level: levelName,
    scope,
    event,
    ...payload,
  }

  const line = JSON.stringify(entry)
  writeLine(line, level)

  if (!persist) return

  try {
    persistLogEvent(entry)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      scope: "log",
      event: "persist_failed",
      message: redactString(error.message),
    })}\n`)
  }
}

export const log = {
  debug(scope, event, data = {}) {
    emit("debug", scope, event, data)
  },
  info(scope, event, data = {}) {
    emit("info", scope, event, data)
  },
  warn(scope, event, data = {}) {
    emit("warn", scope, event, data)
  },
  error(scope, event, data = {}) {
    emit("error", scope, event, data)
  },
}
