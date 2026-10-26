import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addScores, emptyScore, formatEquivalentUsd, scoreFromUsd, scoresUpTo } from '../shared/usage-score.js'
import { loadPricing, resetPricing, responseCost, scoreResponse, setCatalogPricing, summarizeUsage } from '../server/usage.js'

const sol = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }
const luna = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
const pricing = new Map([['openai-codex/sol', sol], ['openai-codex/luna', luna]])
const response = (seq, model, usage) => ({ type: 'assistant/message', seq, time: seq + 1,
  data: { message: { source: { provider: 'openai-codex', model } }, usage } })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)

test('points use a fixed USD equivalent and separate input/output/cache rates', () => {
  const usage = { inputTokens: 2000, cacheReadTokens: 376000, outputTokens: 174 }
  const parent = scoreResponse(pricing, 'openai-codex/sol', usage, 0)
  const child = scoreResponse(pricing, 'openai-codex/luna', usage, 0)
  near(parent.points, 21.67)
  near(child.points, 2.0235)
  near(scoreResponse(pricing, 'openai-codex/sol', { cacheReadTokens: 1000 }, 0).points,
    scoreResponse(pricing, 'openai-codex/luna', { cacheReadTokens: 1000 }, 0).points * 10)
  near(scoreResponse(pricing, 'openai-codex/sol', { outputTokens: 1000 }, 0).points,
    scoreResponse(pricing, 'openai-codex/luna', { outputTokens: 1000 }, 0).points * 20)
})

test('subscription responses get points without pretending to be API bills; duplicate events count once', () => {
  const events = [response(1, 'sol', { inputTokens: 1000 }), response(2, 'luna', { outputTokens: 1000 })]
  const total = summarizeUsage([...events, events[0]], 0, pricing)
  assert.equal(total.requests, 2)
  assert.equal(total.cost, null)
  near(total.score.points, 1.25)
  assert.equal(total.score.priced, 2)
  assert.equal(total.score.unpriced, 0)
})

test('unknown models or incomplete rates are unpriced, never zero-cost known usage', () => {
  const total = summarizeUsage([response(1, 'sol', { inputTokens: 1000 }), response(2, 'missing', { inputTokens: 1000 })], 0, pricing)
  assert.deepEqual(total.score, { points: 1, priced: 1, unpriced: 1 })
  assert.equal(formatEquivalentUsd(total.score), '≥ $0.002')
  assert.equal(formatEquivalentUsd(scoreResponse(pricing, 'missing', { inputTokens: 1 }, 0)), '—')
  assert.equal(responseCost({ input: 1, output: 1 }, { cacheReadTokens: 1 }), null)
  assert.equal(responseCost(sol, { inputTokens: -1 }), null)
  assert.equal(responseCost(sol, { outputTokens: NaN }), null)
  assert.equal(responseCost({ input: 1, output: 1 }, { inputTokens: 1000 }), 0.001)
})

test('response tiers and cache creation are scored before session aggregation', () => {
  const tiered = new Map([['m', { ...sol, tiers: [{ inputTokensAbove: 1000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] }]])
  assert.equal(scoreResponse(tiered, 'm', { inputTokens: 1000 }, 0).points, 1)
  assert.equal(scoreResponse(tiered, 'm', { inputTokens: 1001 }, 0).points, 2.002)
  assert.equal(scoreResponse(tiered, 'm', { cacheWriteTokens: 1000 }, 0).points, 1.25)
  assert.equal(scoreResponse(tiered, 'm', { inputTokens: 500, cacheReadTokens: 501 }, 0).points, 1.0501)
})

test('cumulative scores preserve retries, missing usage and totals beyond retained turns', () => {
  const one = scoreFromUsd(0.002)
  const turns = [{ status: 'done', usage: { score: one } }, { status: 'error' }, { status: 'cancelled', usage: { score: one } }, { status: 'running' }]
  assert.deepEqual(scoresUpTo(turns).at(-1), { points: 2, priced: 2, unpriced: 1 })
  assert.deepEqual(scoresUpTo([{ status: 'done', totalScore: { points: 100, priced: 50, unpriced: 0 } }, { status: 'done', usage: { score: one } }]).at(-1),
    { points: 101, priced: 51, unpriced: 0 })
  assert.equal(formatEquivalentUsd(emptyScore()), '$0.00')
  assert.equal(formatEquivalentUsd(scoreFromUsd(0.000001)), '$0.000001')
  assert.equal(formatEquivalentUsd(undefined), '—')
  assert.deepEqual(addScores(one, null), { points: 1, priced: 1, unpriced: 1 })
})

test('saved points convert to cumulative USD without changing their value or representation', () => {
  const saved = JSON.parse('{"points":21.67,"priced":5,"unpriced":0}')
  const before = JSON.stringify(saved)
  assert.equal(formatEquivalentUsd(saved), '$0.04334')
  assert.equal(JSON.stringify(saved), before)
  const cumulative = scoresUpTo([{ status: 'done', usage: { score: saved } },
    { status: 'done', usage: { score: scoreFromUsd(0.01) } }]).at(-1)
  assert.equal(formatEquivalentUsd(cumulative), '$0.05334')
})

test('USD formatting preserves micro-costs and never rounds an unpriced lower bound upwards', () => {
  assert.equal(formatEquivalentUsd(scoreFromUsd(0)), '$0.00')
  assert.equal(formatEquivalentUsd(scoreFromUsd(0.0000001)), '< $0.000001')
  assert.equal(formatEquivalentUsd(scoreFromUsd(0.0433409)), '$0.043341')
  assert.equal(formatEquivalentUsd({ ...scoreFromUsd(0.0433409), unpriced: 1 }), '≥ $0.04334')
  assert.equal(formatEquivalentUsd({ ...scoreFromUsd(0.0000001), unpriced: 1 }), '≥ $0.00')
  assert.equal(formatEquivalentUsd(scoreFromUsd(1234.56789)), '$1,234.56789')
  assert.equal(formatEquivalentUsd({ points: 0, priced: 0, unpriced: 3 }), '—')
  assert.equal(formatEquivalentUsd(null), '—')
})

test('catalog overlays carry new-model rates without changing a previously recorded score', async () => {
  setCatalogPricing({ 'openai-codex/new-model': sol })
  try {
    const first = scoreResponse(await loadPricing(), 'openai-codex/new-model', { inputTokens: 1000 }, 0)
    setCatalogPricing({ 'openai-codex/new-model': luna })
    const later = scoreResponse(await loadPricing(), 'openai-codex/new-model', { inputTokens: 1000 }, 0)
    near(first.points, 1)
    near(later.points, 0.05)
    near(first.points, 1)
  } finally {
    setCatalogPricing({})
    resetPricing()
  }
})
