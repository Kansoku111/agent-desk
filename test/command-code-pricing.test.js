import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadPricing, priceResponse, responseCost, scoreResponse, setCatalogPricing, summarizeUsage } from '../server/usage.js'
import { formatEquivalentCost } from '../shared/usage-score.js'
import { usageModelId } from '../web/src/util.ts'
import { catalogRates } from '../server/pricing-rates.js'
import { isLocalModelId } from '../server/local-llm.js'
import snapshot from '../server/command-code-pricing.json' with { type: 'json' }

const when = Date.UTC(2026, 10, 3)
const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }

test('every bundled official snapshot rate has a valid route, ID and tier structure', () => {
  assert.equal(new URL(snapshot.source).hostname, 'unpkg.com')
  assert.ok(snapshot.source.includes('/command-code@') && snapshot.source.endsWith('/dist/cli.mjs'))
  assert.match(snapshot.checkedAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(Object.keys(snapshot.models).length > 0)
  for (const [key, rates] of Object.entries(snapshot.models)) {
    const slash = key.indexOf('/')
    assert.ok(['command-code', 'command-code-claude'].includes(key.slice(0, slash)), key)
    assert.ok(isLocalModelId(key.slice(slash + 1)), key)
    assert.deepEqual(catalogRates(rates), rates, key)
    assert.ok(rates.input > 0 || rates.output > 0, 'short-lived free offers are not pinned as zero')
  }
})

test('usage details keep slash-bearing model IDs intact', () => {
  assert.equal(usageModelId('command-code/deepseek/deepseek-v4.1-flash'), 'deepseek/deepseek-v4.1-flash')
  assert.equal(usageModelId('command-code/Qwen/Qwen3.8-27B'), 'Qwen/Qwen3.8-27B')
  assert.equal(usageModelId('openai-codex/gpt-6-luna'), 'gpt-6-luna')
  assert.equal(usageModelId('unknown'), 'unknown')
})

test('Command Code scores exact model IDs without inventing an actual bill', async () => {
  const prices = await loadPricing()
  for (const [key, expected] of [
    ['command-code/deepseek/deepseek-v4.1-flash', 0.753],
    ['command-code/Qwen/Qwen3.8-27B', 3.44],
    ['command-code/z-ai/glm-5.3-flash', 0.68],
  ]) {
    const score = scoreResponse(prices, key, usage, when)
    assert.equal(score.priced, 1, key)
    assert.equal(score.unpriced, 0, key)
    assert.ok(Math.abs(score.points * 0.002 - expected) < 1e-12, key)
    assert.notEqual(formatEquivalentCost(score), '—', key)
    assert.equal(priceResponse(prices, key, usage, when), null, 'subscription equivalent is not an actual bill')
  }
})

test('unknown IDs, unverified free offers and unknown cache writes remain unpriced', async () => {
  const prices = await loadPricing()
  for (const key of ['command-code/new/model', 'command-code/reflection/beam:free']) {
    assert.deepEqual(scoreResponse(prices, key, usage, when), { points: 0, priced: 0, unpriced: 1 })
  }
  const partial = scoreResponse(prices, 'command-code/Qwen/Qwen3.8-27B', { ...usage, cacheWriteTokens: 1 }, when)
  assert.deepEqual(partial, { points: 0, priced: 0, unpriced: 1 })
})

test('the official Command Code snapshot retains each context tier', async () => {
  const prices = await loadPricing()
  const rates = prices.get('command-code/Qwen/Qwen3.7-Flash')
  assert.deepEqual(rates.tiers.map((tier) => tier.inputTokensAbove), [32000, 256000])
  assert.equal(responseCost(rates, { inputTokens: 32000 }), 32000 * 0.03 / 1e6)
  assert.equal(responseCost(rates, { inputTokens: 32001 }), 32001 * 0.1 / 1e6)
  assert.equal(responseCost(rates, { inputTokens: 256001 }), 256001 * 0.2 / 1e6)
})

test('known GPT and Claude IDs use the direct API tiers, not flat snapshot rates', async () => {
  const prices = await loadPricing()
  for (const [route, native] of [['command-code/gpt-6-luna', 'openai-codex/gpt-6-luna'], ['command-code-claude/claude-haiku-5-5', 'anthropic/claude-haiku-5-5']]) {
    assert.deepEqual(prices.get(route), prices.get(native))
    const rates = prices.get(route)
    assert.ok(rates?.tiers?.length, route)
    const above = rates.tiers[0].inputTokensAbove + 1
    assert.equal(responseCost(rates, { inputTokens: above, outputTokens: 10 }), responseCost(prices.get(native), { inputTokens: above, outputTokens: 10 }))
  }
})

test('updated native rates propagate to Command Code exact-ID equivalents', async () => {
  const key = 'openai-codex/gpt-6-luna'
  const rate = { input: 4, output: 8, cacheRead: 0.2, cacheWrite: 1, tiers: [{ inputTokensAbove: 100, input: 6, output: 12, cacheRead: 0.4, cacheWrite: 2 }] }
  try {
    setCatalogPricing({ [key]: rate })
    const prices = await loadPricing()
    assert.deepEqual(prices.get('command-code/gpt-6-luna'), rate)
  } finally { setCatalogPricing({}) }
})

test('Command Code usage totals include API equivalent but no metered bill', async () => {
  const prices = await loadPricing()
  const events = [{ type: 'assistant/message', time: when, data: { message: { source: { provider: 'command-code', model: 'Qwen/Qwen3.8-27B' } }, usage } }]
  const total = summarizeUsage(events, when, prices)
  assert.equal(total.cost, null)
  assert.equal(total.score.priced, 1)
  assert.equal(total.score.unpriced, 0)
  assert.equal(formatEquivalentCost(total.score), '$3.44')
})
