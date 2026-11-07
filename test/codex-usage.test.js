import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexUsageAccumulator } from '../server/codex-usage.js'

const rates = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
  tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }] }
const pricing = new Map([['openai-codex/gpt-mock', rates]])
const row = (input, output = 0, cached = 0, write = 0, reasoning = 0) => ({ inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: write, outputTokens: output, reasoningOutputTokens: reasoning })
const summarize = a => a.summarize(pricing, 'gpt-mock', 0)
const usd = score => score.points * 0.002

test('prices each response at its own context tier and counts duplicates once', () => {
  const a = new CodexUsageAccumulator(null, true)
  a.observe({ total: row(150000, 10), last: row(150000, 10) })
  a.observe({ total: row(150000, 10), last: row(150000, 10) })
  a.observe({ total: row(300000, 20), last: row(150000, 10) })
  const result = summarize(a)
  assert.equal(result.requests, 2)
  assert.equal(result.requestsExact, true)
  assert.equal(result.input, 300000)
  assert.equal(result.output, 20)
  assert.ok(Math.abs(usd(result.score) - 0.03001) < 1e-12)
  assert.equal(result.score.unpriced, 0)
})

test('one long response uses the higher tier', () => {
  const a = new CodexUsageAccumulator(null, true)
  a.observe({ total: row(300000, 10), last: row(300000, 10) })
  const result = summarize(a)
  assert.equal(result.requests, 1)
  assert.ok(Math.abs(usd(result.score) - 0.0600075) < 1e-12)
})

test('a missed notification preserves only the last known response as a lower bound', () => {
  const a = new CodexUsageAccumulator(null, true)
  a.observe({ total: row(300000, 20), last: row(150000, 10) })
  const result = summarize(a)
  assert.equal(result.requests, 1)
  assert.equal(result.requestsExact, false)
  assert.equal(result.input, 300000)
  assert.ok(Math.abs(usd(result.score) - 0.015005) < 1e-12)
  assert.equal(result.score.unpriced, 1)
})

test('missing last usage remains unknown rather than pricing the aggregate', () => {
  const a = new CodexUsageAccumulator(null, true)
  a.observe({ total: row(300000, 20) })
  const result = summarize(a)
  assert.equal(result.input, 300000)
  assert.equal(result.requestsExact, false)
  assert.equal(result.score.priced, 0)
  assert.equal(result.score.unpriced, 1)
})

test('a later turn uses the saved cumulative baseline and cache split', () => {
  const a = new CodexUsageAccumulator(row(100, 10, 20, 0, 2), true)
  a.observe({ total: row(300, 30, 100, 0, 8), last: row(200, 20, 80, 0, 6) })
  const result = summarize(a)
  assert.deepEqual([result.input, result.cacheRead, result.output, result.reasoning], [120, 80, 20, 6])
  assert.equal(result.requestsExact, true)
})

test('malformed, decreasing and ambiguous zero notifications never become exact', () => {
  const a = new CodexUsageAccumulator(null, true)
  assert.equal(a.observe({ total: row(20, 10), last: row(20, 10) }), true)
  assert.equal(a.observe({ total: row(10, 10), last: row(1, 0) }), false)
  assert.equal(a.observe({ total: row(40, 10, 50), last: row(20) }), false)
  const result = summarize(a)
  assert.equal(result.input, 20)
  assert.equal(result.requestsExact, false)
  assert.equal(result.score.unpriced, 1)
  const b = new CodexUsageAccumulator(null, true)
  b.observe({ total: row(0), last: row(0) })
  assert.equal(summarize(b).requestsExact, false)
})

test('impossible cache deltas and impossible unseen remainders are rejected', () => {
  const a = new CodexUsageAccumulator(null, true)
  a.observe({ total: row(90, 0), last: row(90, 0) })
  assert.equal(a.observe({ total: row(100, 0, 90), last: row(10, 0) }), false)
  assert.equal(summarize(a).input, 90)
  const b = new CodexUsageAccumulator(null, true)
  b.observe({ total: row(100, 0, 90), last: row(90, 0) })
  const result = summarize(b)
  assert.equal(result.requestsExact, false)
  assert.equal(result.score.priced, 0)
  assert.equal(result.score.unpriced, 1)
})

test('a missing cache count and changed duplicate last value are not trusted', () => {
  const a = new CodexUsageAccumulator(null, true)
  assert.equal(a.observe({ total: { inputTokens: 100, outputTokens: 10 }, last: row(100, 10) }), false)
  assert.equal(a.latestRejected, true)
  const b = new CodexUsageAccumulator(null, true)
  b.observe({ total: row(100, 10), last: row(100, 10) })
  b.observe({ total: row(100, 10), last: row(99, 10) })
  assert.equal(summarize(b).requestsExact, false)
})

test('a rejected final update is not healed by repeating an older total', () => {
  const a = new CodexUsageAccumulator(null, true)
  a.observe({ total: row(100, 10), last: row(100, 10) })
  a.observe({ total: row(90, 10), last: row(1) })
  a.observe({ total: row(100, 10), last: row(100, 10) })
  assert.equal(a.latestRejected, true)
})

test('an unknown baseline can be rebased but not priced for the current turn', () => {
  const a = new CodexUsageAccumulator(null, false)
  const latest = { total: row(500, 50), last: row(200, 20) }
  assert.equal(a.observe(latest), true)
  assert.equal(a.latest, latest)
  assert.equal(summarize(a), null)
})
