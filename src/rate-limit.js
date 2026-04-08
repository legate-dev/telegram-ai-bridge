import { config } from "./config.js"

/**
 * Simple in-memory sliding-window rate limiter keyed by user ID.
 * Tracks timestamps of recent requests and evicts expired entries.
 */
const buckets = new Map()

function evict(timestamps, now) {
  const cutoff = now - config.rateLimitWindowMs
  while (timestamps.length && timestamps[0] <= cutoff) {
    timestamps.shift()
  }
}

/**
 * Check whether a user is within rate limits.
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 */
export function checkRateLimit(userId) {
  const now = Date.now()
  const key = String(userId)

  if (!buckets.has(key)) {
    buckets.set(key, [])
  }

  const timestamps = buckets.get(key)
  evict(timestamps, now)

  if (timestamps.length >= config.rateLimitMax) {
    const retryAfterMs = timestamps[0] + config.rateLimitWindowMs - now
    return { allowed: false, retryAfterMs }
  }

  timestamps.push(now)
  return { allowed: true }
}

// Periodic cleanup of stale buckets (every 5 minutes)
setInterval(() => {
  const now = Date.now()
  for (const [key, timestamps] of buckets) {
    evict(timestamps, now)
    if (!timestamps.length) buckets.delete(key)
  }
}, 5 * 60 * 1000).unref()
