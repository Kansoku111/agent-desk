// ChatGPT limits from the official bundled Codex app-server (separate from SIWC).
import { CODEX_SIGNIN_HINT } from './codex-app-server.js'

/** A readable name for a limit window. */
export function windowLabel(seconds) {
  if (seconds === 604800) return '週間'
  if (seconds === 86400) return '1日'
  if (seconds % 3600 === 0) return `${seconds / 3600}時間`
  return `${Math.round(seconds / 60)}分`
}

/** The usage response reduced to what the UI shows. */
export function normalizeUsage(body, now = Date.now()) {
  const limits = body?.rate_limit ?? {}
  const windows = [limits.primary_window, limits.secondary_window]
    .filter(entry => entry && typeof entry.used_percent === 'number')
    .map(entry => ({
      label: windowLabel(entry.limit_window_seconds),
      seconds: entry.limit_window_seconds,
      usedPercent: Math.max(0, Math.min(100, entry.used_percent)),
      resetAt: typeof entry.reset_at === 'number'
        ? entry.reset_at * 1000
        : typeof entry.reset_after_seconds === 'number' ? now + entry.reset_after_seconds * 1000 : null,
    }))
    .sort((a, b) => a.seconds - b.seconds)
  return {
    status: 'ok',
    plan: typeof body?.plan_type === 'string' ? body.plan_type : null,
    limitReached: Boolean(limits.limit_reached) || limits.allowed === false,
    windows,
    fetchedAt: now
  }
}
// A notification carries one bucket; never display another model's quota as Codex.
function codexLimits(body) {
  const limits = body?.rateLimitsByLimitId?.codex ?? body?.rateLimits
  return limits && (limits.limitId == null || limits.limitId === 'codex') ? limits : null
}

export function normalizeCodexRateLimits(body, now = Date.now()) {
  const limits = codexLimits(body) ?? {}
  // A null duration is unknown, not a zero-hour window.
  const window = entry => entry && Number.isFinite(entry.usedPercent)
    && Number.isFinite(entry.windowDurationMins) && entry.windowDurationMins > 0 ? {
    used_percent: entry.usedPercent,
    limit_window_seconds: entry.windowDurationMins * 60,
    reset_at: entry.resetsAt
  } : null
  return normalizeUsage({
    plan_type: limits.planType ?? null,
    rate_limit: {
      primary_window: window(limits.primary),
      secondary_window: window(limits.secondary),
      limit_reached: Boolean(limits.rateLimitReachedType)
    }
  }, now)
}
// Rolling notifications are sparse: null means unavailable, not a deletion.
function available(previous, patch) {
  return { ...previous, ...Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value != null)) }
}

/** Keeps the last full Codex snapshot so rolling updates cannot erase its windows or metadata. */
export class ChatGptUsage {
  constructor(codex, changed = () => {}) {
    this.codex = codex
    this.changed = changed
    this.snapshot = null
  }

  publish(usage) {
    this.changed(usage)
    return usage
  }

  update(body, now = Date.now()) {
    const patch = codexLimits(body)
    if (!patch) return null
    const next = available(this.snapshot, patch)
    for (const key of ['primary', 'secondary']) {
      if (patch[key]) next[key] = available(this.snapshot?.[key], patch[key])
    }
    this.snapshot = next
    return this.publish(normalizeCodexRateLimits({ rateLimits: next }, now))
  }

  async refresh() {
    let usage
    try {
      const body = await this.codex.rateLimits()
      // A full read is authoritative, including null values and sign-out.
      this.snapshot = codexLimits(body)
      usage = body ? normalizeCodexRateLimits(body) : { status: 'signed-out', message: CODEX_SIGNIN_HINT }
    } catch {
      this.snapshot = null
      usage = {
        status: 'error',
        message: 'Codex の利用上限を取得できませんでした。設定 → アカウントの Codex 接続を確認してください。'
      }
    }
    return this.publish(usage)
  }
}

export async function fetchChatGptUsage(codex) {
  return new ChatGptUsage(codex).refresh()
}
