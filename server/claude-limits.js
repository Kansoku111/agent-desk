// The Claude subscription's limit windows, as Claude Code reports them in the
// `rate_limit_event` of its own output (see claude-runner.js). Nothing asks for
// them: they ride along with a turn a team already runs, so they are as fresh
// as the last turn.
const WINDOWS = [
  { key: 'five_hour', label: '5時間', seconds: 5 * 3600 },
  { key: 'seven_day', label: '週間', seconds: 7 * 86400 },
]

/** Unix seconds, or milliseconds if that is what came. */
function toMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value < 1e12 ? value * 1000 : value
}

/**
 * The windows of one event reduced to what the UI shows, or null when it
 * carries no usage (older Claude Code builds send only a status and a reset).
 * `utilization` is a fraction of the limit, 0 to 1.
 */
export function normalizeClaudeLimits(info, now = Date.now()) {
  const reported = info?.unifiedWindows
  if (!reported || typeof reported !== 'object') return null
  const windows = []
  for (const { key, label, seconds } of WINDOWS) {
    const entry = reported[key]
    if (typeof entry?.utilization !== 'number' || !Number.isFinite(entry.utilization)) continue
    windows.push({
      label,
      seconds,
      usedPercent: Math.max(0, Math.min(100, entry.utilization * 100)),
      resetAt: toMs(entry.resetsAt),
    })
  }
  return windows.length ? { status: 'ok', windows, fetchedAt: now } : null
}

/** A newer reading wins window by window; a window it does not carry keeps its last reading. */
export function mergeClaudeLimits(previous, next) {
  if (previous?.status !== 'ok') return next
  const fresh = new Set(next.windows.map((window) => window.seconds))
  const windows = [...previous.windows.filter((window) => !fresh.has(window.seconds)), ...next.windows]
    .sort((a, b) => a.seconds - b.seconds)
  return { ...next, windows }
}

/** What was saved last run, if it still has the shape of a reading. */
export function readSavedClaudeLimits(saved) {
  if (saved?.status !== 'ok' || !Array.isArray(saved.windows) || typeof saved.fetchedAt !== 'number') return null
  const windows = saved.windows.filter((window) => typeof window?.seconds === 'number' && typeof window.usedPercent === 'number')
  return windows.length ? { status: 'ok', windows, fetchedAt: saved.fetchedAt } : null
}
