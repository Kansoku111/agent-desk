import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatGptUsage, normalizeCodexRateLimits, normalizeUsage, windowLabel } from '../server/chatgpt-usage.js'
import { createAccountHandlers } from '../server/rpc-handlers-accounts.js'

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

const snapshot = () => ({
  rateLimitsByLimitId: { codex: {
    limitId: 'codex', planType: 'plus', rateLimitReachedType: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1_800_100_000 },
  } },
})

test('sparse Codex notifications preserve the other window and nullable metadata in broadcasts and RPC', async () => {
  let reads = 0
  let live
  const broadcasts = []
  const tracker = new ChatGptUsage({ rateLimits: async () => { reads++; return snapshot() } }, usage => {
    live = usage
    broadcasts.push(usage)
  })
  await tracker.refresh()
  tracker.update({ rateLimits: {
    limitId: 'codex', planType: null, secondary: null,
    primary: { usedPercent: 30, windowDurationMins: null, resetsAt: null },
  } })
  assert.equal(live.plan, 'plus')
  assert.deepEqual(live.windows.map(window => [window.label, window.usedPercent, window.resetAt]), [
    ['5時間', 30, 1_800_000_000_000], ['週間', 50, 1_800_100_000_000],
  ])
  assert.equal(broadcasts.length, 2)
  const handlers = createAccountHandlers({ getChatgptUsage: () => live, refreshChatGptUsage: () => tracker.refresh() })
  assert.equal((await handlers['chatgpt.usage']()).usage, live)
  assert.equal(reads, 1)
})

test('updates for another bucket never replace the Codex quota', async () => {
  const broadcasts = []
  const tracker = new ChatGptUsage({ rateLimits: async () => snapshot() }, usage => broadcasts.push(usage))
  await tracker.refresh()
  assert.equal(tracker.update({ rateLimits: {
    limitId: 'other-model', primary: { usedPercent: 99, windowDurationMins: 300 },
  } }), null)
  assert.equal(broadcasts.length, 1)
  assert.equal(broadcasts[0].windows[0].usedPercent, 25)
  assert.deepEqual(normalizeCodexRateLimits({ rateLimits: {
    limitId: 'other-model', primary: { usedPercent: 99, windowDurationMins: 300 },
  } }).windows, [])
})

test('unknown or invalid durations never appear as zero-hour windows', () => {
  for (const duration of [null, undefined, 0, -1, NaN, Infinity]) {
    assert.deepEqual(normalizeCodexRateLimits({ rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: duration },
    } }).windows, [])
  }
})

test('a full read can clear old windows and metadata, unlike a sparse notification', async () => {
  let body = snapshot()
  const tracker = new ChatGptUsage({ rateLimits: async () => body })
  await tracker.refresh()
  body = { rateLimits: { limitId: 'codex', planType: null, primary: null, secondary: null } }
  const empty = await tracker.refresh()
  assert.equal(empty.plan, null)
  assert.deepEqual(empty.windows, [])
  const next = tracker.update({ rateLimits: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300 } } })
  assert.equal(next.plan, null)
  assert.deepEqual(next.windows.map(window => window.usedPercent), [0])
})

test('sign-out and failed reads discard the old account snapshot', async () => {
  let body = snapshot()
  let fail = false
  const tracker = new ChatGptUsage({ rateLimits: async () => {
    if (fail) throw new Error('offline fixture')
    return body
  } })
  await tracker.refresh()
  body = null
  assert.equal((await tracker.refresh()).status, 'signed-out')
  assert.equal(tracker.snapshot, null)
  body = snapshot()
  await tracker.refresh()
  fail = true
  assert.equal((await tracker.refresh()).status, 'error')
  assert.equal(tracker.snapshot, null)
  const next = tracker.update({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } })
  assert.equal(next.plan, null)
  assert.equal(next.windows.length, 1)
})
