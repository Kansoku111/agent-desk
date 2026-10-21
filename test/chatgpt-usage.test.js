import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeUsage, windowLabel } from '../server/chatgpt-usage.js'

test('windowLabel names the usual Codex windows', () => {
  assert.equal(windowLabel(604800), '週間')
  assert.equal(windowLabel(18000), '5時間')
  assert.equal(windowLabel(86400), '1日')
})

test('normalizeUsage keeps the windows, shortest first, with reset times', () => {
  const usage = normalizeUsage({
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 12.5, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 140, limit_window_seconds: 18000, reset_after_seconds: 60 },
    },
  }, 1_000)
  assert.equal(usage.plan, 'plus')
  assert.equal(usage.limitReached, false)
  assert.deepEqual(usage.windows.map((window) => [window.label, window.usedPercent, window.resetAt]), [
    ['5時間', 100, 61_000],
    ['週間', 12.5, 1_800_000_000_000],
  ])
  assert.equal(normalizeUsage({ rate_limit: { allowed: false, primary_window: null } }).limitReached, true)
})
