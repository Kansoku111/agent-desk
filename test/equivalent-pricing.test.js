import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { EquivalentPricing, publicEquivalentRates } from '../server/equivalent-pricing.js'
import { ModelRegistry, MODEL_REGISTRY_URL } from '../server/model-registry.js'
import { OpenCodeGoRegistry } from '../server/opencode-go-registry.js'
import { catalogRates, publicTextRates } from '../server/pricing-rates.js'
import { loadPricing, priceResponse, scoreResponse, setCatalogPricing, setEquivalentPricing } from '../server/usage.js'

const cost = { input: 1, output: 5, cache_read: 0.05, cache_write: 1.25,
  tiers: [{ input: 2, output: 7.5, cache_read: 0.1, cache_write: 2.5, tier: { type: 'context', size: 272000 } }],
  context_over_200k: { input: 2, output: 7.5, cache_read: 0.1, cache_write: 2.5 } }
const body = (models = { 'gpt-new': { id: 'gpt-new', cost } }) => ({ openai: { id: 'openai', models } })
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, String(a) + ' != ' + b)

async function fixture(t, fetchImpl, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-equivalent-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'prices.json')
  const registry = new ModelRegistry({ fetchImpl, now: options.now })
  const pricing = await new EquivalentPricing({ file, registry, ...options }).load()
  return { file, registry, pricing }
}

test('exact OpenAI ids and explicit context tiers convert without guessing missing rates', () => {
  const rates = publicEquivalentRates(body({
    'gpt-new': { id: 'gpt-new', cost },
    alias: { id: 'different', cost },
    'no-rate': { id: 'no-rate', cost: { input: 1, output: 5 } },
    special: { id: 'special', type: 'decision', cost },
  }))
  assert.deepEqual(Object.keys(rates), ['openai-codex/gpt-new', 'openai-codex/no-rate'])
  assert.deepEqual(rates['openai-codex/no-rate'], { input: 1, output: 5 })
  const mapped = new Map(Object.entries(rates))
  near(scoreResponse(mapped, 'openai-codex/gpt-new', { inputTokens: 272000, outputTokens: 1000 }, 1).points * 0.002, 0.277)
  near(scoreResponse(mapped, 'openai-codex/gpt-new', { inputTokens: 120000, cacheReadTokens: 152001, outputTokens: 1000 }, 1).points * 0.002, 0.2627001)
  assert.equal(scoreResponse(mapped, 'openai-codex/no-rate', { cacheReadTokens: 1 }, 1).unpriced, 1)
  assert.equal(scoreResponse(mapped, 'openai-codex/gpt-newer', { inputTokens: 1 }, 1).unpriced, 1)
  assert.equal(priceResponse(mapped, 'openai-codex/gpt-new', { inputTokens: 1000 }, 1), null)
})

test('malformed rates and unrepresentable conditions stay unknown', () => {
  for (const bad of [
    { ...cost, input: -1 }, { ...cost, output: Infinity }, { ...cost, cache_read: '0.05' },
    { ...cost, future_condition: 1 }, { ...cost, reasoning: 99 }, { ...cost, tiers: null },
    { ...cost, tiers: [{ ...cost.tiers[0], tier: { type: 'output', size: 1 } }] },
    { ...cost, tiers: [{ ...cost.tiers[0], tier: { type: 'context', size: 0 } }] },
    { ...cost, tiers: [cost.tiers[0], cost.tiers[0]] },
    { ...cost, tiers: [{ ...cost.tiers[0], tier: { ...cost.tiers[0].tier, region: 'special' } }] },
    { ...cost, tiers: undefined }, { ...cost, context_over_200k: { input: 9, output: 9 } },
  ]) assert.equal(publicTextRates(bad), null)
  assert.equal(catalogRates({ input: 1, output: 2, tiers: [{ inputTokensAbove: -1, input: 2, output: 3 }] }), null)
  assert.equal(catalogRates({ input: 1, output: 2, unknownTier: 3 }), null)
})

test('shared catalog deduplicates downloads and supports force without credentials', async () => {
  const calls = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const registry = new ModelRegistry({ fetchImpl: async (url, options) => { calls.push({ url, options }); await gate; return Response.json(body()) } })
  const first = registry.get(), second = registry.get()
  assert.equal(first, second)
  release()
  assert.deepEqual(await first, await second)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, MODEL_REGISTRY_URL)
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers, undefined)
  await registry.get()
  assert.equal(calls.length, 1)
  await registry.get({ force: true })
  assert.equal(calls.length, 2)
})

test('Go definitions and equivalent pricing reuse the same public download', async (t) => {
  let calls = 0
  const go = { id: 'go-new', name: 'Go New', tool_call: true, reasoning: true,
    modalities: { input: ['text'], output: ['text'] }, limit: { context: 100000, output: 10000 }, cost: { input: 1, output: 2 } }
  const all = { ...body(), 'opencode-go': { id: 'opencode-go', npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/inference/go/openai/v1', models: { [go.id]: go } } }
  const { registry, pricing, file } = await fixture(t, async () => { calls++; return Response.json(all) })
  const base = { 'openai-completions': { known: { id: 'known', provider: 'opencode-go',
    api: 'openai-completions', baseUrl: 'https://opencode.ai/inference/go/openai/v1' } } }
  const goRegistry = await new OpenCodeGoRegistry({ file: file + '.go', registry, base: async () => base }).load()
  await pricing.refresh({ force: true })
  await goRegistry.refresh(['go-new'], { force: true })
  assert.equal(calls, 1)
  assert.equal(goRegistry.groups['openai-completions']['go-new'].id, 'go-new')
  assert.ok(pricing.rates['openai-codex/gpt-new'])
  all['opencode-go'].models['go-next'] = { ...go, id: 'go-next', name: 'Go Next' }
  await goRegistry.refresh(['go-new', 'go-next'])
  assert.equal(calls, 2, 'a newly missing id refreshes an already used snapshot')
  assert.equal(goRegistry.groups['openai-completions']['go-next'].id, 'go-next')
  await goRegistry.refresh(['go-new', 'go-next'], { force: true })
  assert.equal(calls, 3, 'a direct forced Go refresh does not reuse its own old snapshot')
})

test('prices persist, update, keep last good entries and respect automatic-update settings', async (t) => {
  let enabled = true, calls = 0, current = body(), now = 1000
  const notifications = []
  const { pricing, registry, file } = await fixture(t, async () => { calls++; return Response.json(current) },
    { enabled: () => enabled, now: () => now, onChange: (value) => notifications.push(value) })
  assert.equal(await pricing.refresh(), true)
  assert.equal(calls, 1)
  assert.equal(notifications.length, 1)
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(saved.entries['openai-codex/gpt-new'].source, MODEL_REGISTRY_URL)
  assert.equal(saved.entries['openai-codex/gpt-new'].checkedAt, now)
  assert.equal(await pricing.refresh(), false)
  assert.equal(calls, 1)
  const loaded = await new EquivalentPricing({ file, registry, enabled: () => enabled, now: () => now }).load()
  assert.deepEqual(loaded.rates, pricing.rates)
  now++
  current = body({ 'gpt-new': { id: 'gpt-new', cost: { ...cost, input: 3 } },
    'gpt-next': { id: 'gpt-next', cost: { input: 2, output: 10 } } })
  assert.equal(await pricing.refresh({ force: true }), true)
  assert.equal(pricing.rates['openai-codex/gpt-new'].input, 3)
  current = body({ 'gpt-new': { id: 'gpt-new', cost: { input: -1, output: 1 } },
    'gpt-next': { id: 'gpt-next', cost: { input: 2, output: 10 } } })
  await pricing.refresh({ force: true })
  assert.equal(pricing.rates['openai-codex/gpt-new'].input, 3, 'invalid replacement keeps last-good value')
  const lastGood = await fs.readFile(file, 'utf8')
  current = { error: true }
  assert.equal(await pricing.refresh({ force: true }), false)
  assert.equal(pricing.failed, true)
  assert.equal(await fs.readFile(file, 'utf8'), lastGood)
  enabled = false
  assert.deepEqual(pricing.rates, {})
  const before = calls
  await pricing.refresh({ force: true })
  assert.equal(calls, before)
  enabled = true
  assert.equal(pricing.rates['openai-codex/gpt-new'].input, 3)
})

test('public prices fill unknown GPT ids without replacing real catalog or billed prices', async (t) => {
  const { pricing } = await fixture(t, async () => Response.json(body()))
  await pricing.refresh()
  setEquivalentPricing({ ...pricing.rates, 'anthropic/gpt-new': { input: 1, output: 5 },
    'openai-codex/gpt-6.1-sol': { input: 99, output: 99 },
    'openai-codex/gpt-6.1-terra': { input: 3, output: 5 },
    'openai-codex/invalid': { input: -1, output: 2 } })
  setCatalogPricing({})
  t.after(() => { setEquivalentPricing({}); setCatalogPricing({}) })
  const unknown = await loadPricing()
  near(scoreResponse(unknown, 'openai-codex/gpt-new', { inputTokens: 1000 }, 0).points, 0.5)
  assert.equal(priceResponse(unknown, 'openai-codex/gpt-new', { inputTokens: 1000 }, 0), null)
  assert.equal(unknown.get('anthropic/gpt-new'), undefined)
  assert.equal(unknown.get('openai-codex/invalid'), undefined)
  assert.equal(unknown.get('openai-codex/gpt-6.1-sol').input, 2, 'installed model pricing outranks public fallback')
  // The offline seed's only OpenAI model, gpt-6.1-terra, entered the installed catalog with pi-ai 1.5.0,
  // so the catalog now outranks the public fallback here. No shipped model is left to show
  // "public pricing outranks the offline seed"; that is the order of the first two Map sources.
  assert.equal(unknown.get('openai-codex/gpt-6.1-terra').input, 1, 'installed model pricing outranks the public fallback and the offline seed')
  setCatalogPricing({ 'openai-codex/gpt-new': { input: 7, output: 20 } })
  near(scoreResponse(await loadPricing(), 'openai-codex/gpt-new', { inputTokens: 1000 }, 0).points, 3.5)
})

test('a price update cannot be lost while catalog files are being read', async (t) => {
  setCatalogPricing({})
  setEquivalentPricing({ 'openai-codex/new-test': { input: 1, output: 2 } })
  t.after(() => { setCatalogPricing({}); setEquivalentPricing({}) })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const read = fs.readFile.bind(fs)
  let first = true
  t.mock.method(fs, 'readFile', async (...args) => {
    if (first && String(args[0]).endsWith('openai-codex.json')) { first = false; entered.resolve(); await release.promise }
    return read(...args)
  })
  const loading = loadPricing()
  await entered.promise
  setEquivalentPricing({ 'openai-codex/new-test': { input: 8, output: 2 } })
  release.resolve()
  assert.equal((await loading).get('openai-codex/new-test').input, 8)
  assert.equal((await loadPricing()).get('openai-codex/new-test').input, 8)
})

test('startup refreshes a recent cache that predates new GPT prices, then waits six hours from completion', async (t) => {
  const interval = 6 * 60 * 60 * 1000
  let now = 1_000, calls = 0
  let current = body()
  const { pricing: initial, registry, file } = await fixture(t, async () => { calls++; return Response.json(current) }, { now: () => now })
  await initial.refresh()
  now += 60 * 60 * 1000
  current = body({
    'gpt-new': { id: 'gpt-new', cost },
    'gpt-6.2-sol': { id: 'gpt-6.2-sol', cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5,
      tiers: [{ input: 4, output: 15, cache_read: 0.2, cache_write: 5, tier: { type: 'context', size: 272000 } }],
      context_over_200k: { input: 4, output: 15, cache_read: 0.2, cache_write: 5 } } },
  })
  // A new server starts with last-good disk rates but no in-memory registry.
  const restarted = await new EquivalentPricing({ file, registry: new ModelRegistry({ fetchImpl: registry.fetchImpl, now: () => now }), now: () => now }).load()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => restarted.stop())
  assert.equal(restarted.rates['openai-codex/gpt-6.2-sol'], undefined)
  restarted.start()
  t.mock.timers.tick(0)
  assert.equal(calls, 2, 'even a recent saved cache is refreshed on startup')
  now += 500 // Simulate a download finishing after its timer fired.
  t.mock.timers.tick(500)
  await restarted.pending
  const pricing = new Map(Object.entries(restarted.rates))
  near(scoreResponse(pricing, 'openai-codex/gpt-6.2-sol', { inputTokens: 272000, outputTokens: 1000 }, 1).points * 0.002, 0.554)
  near(scoreResponse(pricing, 'openai-codex/gpt-6.2-sol', { inputTokens: 120000, cacheReadTokens: 152001, outputTokens: 1000 }, 1).points * 0.002, 0.5254002)
  now += interval - 500
  t.mock.timers.tick(interval - 500)
  assert.equal(calls, 2, 'still fresh at six hours from timer start')
  now += 500
  t.mock.timers.tick(500)
  assert.equal(calls, 3, 'download duration cannot make the next timer skip a cycle')
  await restarted.pending
})

test('newly offered GPT ids without rates bypass the cache but priced ids and disabled updates do not', async (t) => {
  let calls = 0, enabled = true, current = body()
  const { pricing } = await fixture(t, async () => { calls++; return Response.json(current) }, { enabled: () => enabled })
  await pricing.refresh()
  const known = new Map(Object.entries(pricing.rates))
  assert.equal(await pricing.refreshForModels(['gpt-new'], known), false)
  assert.equal(calls, 1)
  const id = 'gpt-6.2-astra', key = 'openai-codex/' + id
  current = body({ [id]: { id, cost: { input: 8, output: 40, cache_read: 0.4, cache_write: 10,
    tiers: [{ input: 16, output: 60, cache_read: 0.8, cache_write: 20, tier: { type: 'context', size: 272000 } }],
    context_over_200k: { input: 16, output: 60, cache_read: 0.8, cache_write: 20 } } } })
  enabled = false
  assert.equal(await pricing.refreshForModels([id], known), false)
  assert.equal(calls, 1)
  enabled = true
  assert.equal(await pricing.refreshForModels([id], known), true)
  assert.equal(calls, 2)
  const updated = new Map(Object.entries(pricing.rates))
  near(scoreResponse(updated, key, { inputTokens: 120000, cacheReadTokens: 152001, outputTokens: 1000 }, 1).points * 0.002, 2.1016008)
  assert.equal(await pricing.refreshForModels([id], updated), false)
  assert.equal(calls, 2)
})

test('invalid saved prices cannot suppress a fresh lookup', async (t) => {
  let calls = 0
  const { pricing, file } = await fixture(t, async () => { calls++; return Response.json(body()) }, { now: () => 1000 })
  await fs.writeFile(file, JSON.stringify({ version: 1, checkedAt: 999, entries: {
    'anthropic/example': { rates: { input: 1, output: 2 }, checkedAt: 999, source: MODEL_REGISTRY_URL },
    'openai-codex/gpt-bad': { rates: { input: -1, output: 2 }, checkedAt: 999, source: MODEL_REGISTRY_URL },
  } }))
  await pricing.load()
  assert.deepEqual(pricing.rates, {})
  await pricing.refresh()
  assert.equal(calls, 1)
  assert.ok(pricing.rates['openai-codex/gpt-new'])
})

test('stopping during an in-flight request prevents a late write or notification', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let notified = false
  const { pricing, file } = await fixture(t, async () => { await gate; return Response.json(body()) }, { onChange: () => { notified = true } })
  const refresh = pricing.refresh()
  const stopped = pricing.stop()
  release()
  await stopped
  assert.equal(await refresh, false)
  assert.equal(notified, false)
  await assert.rejects(fs.access(file), { code: 'ENOENT' })
})
