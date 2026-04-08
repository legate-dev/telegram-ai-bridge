import { checkRateLimit } from "./rate-limit.js"
import { log } from "./log.js"

/**
 * grammY middleware that enforces a per-user rate limit on slash commands and
 * callback queries (per-update).
 *
 * Ordering requirement: this middleware MUST be registered AFTER the auth
 * middleware so that unauthorised users are rejected before consuming a
 * rate-limit bucket slot.
 *
 * System updates without a ctx.from (channel posts, etc.) are passed through
 * without touching any bucket.
 *
 * Plain text messages (non-command) are passed through here without consuming
 * a slot — the rate-limit check is deferred to processTextMessage() after
 * fragment coalescing, so that a multi-fragment Telegram message (split at
 * 4096 chars) counts as one logical turn rather than N separate slots.
 */
export async function rateLimitMiddleware(ctx, next) {
  const userId = ctx.from?.id
  if (!userId) return await next()

  // Pass plain text (non-command) messages through — rate-limit check happens
  // after coalescing inside processTextMessage(). Use the bot_command entity at
  // offset 0 as the authoritative classifier: Telegram tags real bot commands
  // with this entity, while Unix paths like /Users/foo/repo are plain text and
  // must not be misclassified as commands.
  const entities = ctx.message?.entities ?? []
  const isBotCommand = entities.some((e) => e.type === "bot_command" && e.offset === 0)
  const isPlainText = !ctx.callbackQuery && !!ctx.message?.text && !isBotCommand
  if (isPlainText) return await next()

  const result = checkRateLimit(userId)
  if (result.allowed) return await next()

  const retrySec = Math.max(1, Math.ceil(result.retryAfterMs / 1000))
  const kind = ctx.callbackQuery
    ? "callback"
    : isBotCommand
      ? "command"
      : ctx.message
        ? "message"
        : "update"

  log.warn("telegram.middleware", "rate_limit.blocked", {
    user_id: userId,
    kind,
    retry_after_ms: result.retryAfterMs,
  })

  if (ctx.callbackQuery) {
    try {
      await ctx.answerCallbackQuery({
        text: `Rate limit exceeded. Retry in ${retrySec}s.`,
        show_alert: true,
      })
    } catch (err) {
      log.debug("telegram.middleware", "rate_limit.callback_answer_failed", { error: String(err) })
    }
  } else {
    try {
      await ctx.reply(`⚠️ Rate limit exceeded. Retry in ${retrySec}s.`)
    } catch (err) {
      log.debug("telegram.middleware", "rate_limit.reply_failed", { error: String(err) })
    }
  }
  // Do NOT call next() — the update is dropped here
}
