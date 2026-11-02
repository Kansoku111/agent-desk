import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import childBackend, { TeamChildCompaction, CHILD_CONTEXT_BUDGET, childCompactionPolicy } from '../server/team-child-compaction.js'

function fixture(t, Engine = TeamChildCompaction, config = {}) {
  const ctx = new Context()
  const models = new Map(), state = new WeakMap(), compacted = [], lookups = []
  ctx.provide('llm', { resolveModelInfo: async (provider, model) => {
    lookups.push([provider, model])
    return models.get(provider + '/' + model) ?? { context: { contextWindow: 1_000_000 }, defaultMaxTokens: 32_768 }
  }, stream() { throw new Error('No model calls allowed') } })
  ctx.provide('sessions', { flush() {} })
  ctx.provide('tokenMeter', { measure: (session) => ({ totalTokens: state.get(session),
    nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 40_000 })) }) })
  const engine = new Engine(ctx, { auto: false, ...config })
  engine.compactRegion = async (start, end, agent) => {
    compacted.push({ start, end, model: agent.session.requestHeader().config.model })
    state.set(agent.session, 100_000)
    return { shadowedSeqs: [start, end], shadowedTokenCount: 300_000 }
  }
  const agent = (model = 'large', total = 400_000, request = {}) => {
    const header = { config: { provider: 'fixture', model, maxTokens: 32_768, ...request } }
    const events = Array.from({ length: 10 }, (_, seq) => ({ seq, type: seq === 0 ? 'system/message' : 'user/message', data: {} }))
    const session = { seq: 10, surface: { nodes: events.map((e) => e.seq), replaceGeneration: 0 },
      eventAt: (seq) => events[seq], requestHeader: () => header }
    state.set(session, total)
    return { session, options: {} }
  }
  t.after(() => ctx.fiber.dispose())
  return { ctx, engine, agent, models, state, compacted, lookups }
}
const signal = () => new AbortController().signal
const target = { provider: 'fixture', model: 'large' }
const info = (window) => ({ context: { contextWindow: window }, defaultMaxTokens: 32_768 })
const threshold = (config, policy, window, reply = 32_768) => Math.floor(Math.min(
  window * (policy?.thresholdRatio ?? config.thresholdRatio), window - reply - (policy?.headroomTokens ?? config.headroomTokens)))

test('child bootstrap preserves the disabled stock config and its expression scope', () => {
  const config = { auto: false, headroomTokens: { __jsExpr: 'headroom' }, modelPolicies: [{ ...target, thresholdRatio: .3 }] }
  const before = structuredClone(config)
  const entry = { options: { name: '@deepseek-ai/dsh-compaction-basic', config }, disabled: true, ctx: { headroom: 12_345 } }
  let mounted
  const tree = { resolve: (id) => { assert.equal(id, 'compaction-basic'); return entry } }
  childBackend.apply({ fiber: { entry: { parent: { tree } } },
    plugin: (Engine, options) => { mounted = { Engine, options } } })
  assert.equal(mounted.Engine, TeamChildCompaction)
  assert.deepEqual(mounted.options, { ...config, headroomTokens: 12_345 })
  assert.deepEqual(config, before)
})

test('child bootstrap refuses a missing, active or replaced stock backend', () => {
  for (const entry of [undefined, { disabled: false, options: { name: '@deepseek-ai/dsh-compaction-basic' } },
    { disabled: true, options: { name: 'other-backend' } }]) {
    assert.throws(() => childBackend.apply({ fiber: { entry: { parent: { tree: { resolve: () => entry } } } }, plugin() { assert.fail('must not mount') } }), /disabled stock/)
  }
})

test('common budget preserves earlier/same thresholds and bounds larger ones without route allowlists', (t) => {
  const { engine } = fixture(t)
  assert.equal(CHILD_CONTEXT_BUDGET, 400_000)
  for (const window of [128_000, 256_000, 500_000, 1_000_000, 1_048_576, 4_000_000]) {
    const before = structuredClone(engine.config)
    const policy = childCompactionPolicy(engine.config, target, info(window), 32_768)
    assert.equal(threshold(engine.config, policy, window), Math.min(threshold(engine.config, null, window), 400_000))
    assert.deepEqual(engine.config, before)
  }
  for (const provider of ['new-company', 'local-llm', 'future-provider']) {
    assert.equal(childCompactionPolicy(engine.config, { provider, model: 'unlisted-model' }, info(1_000_000), 32_768).thresholdRatio, .4)
  }
})

test('an exact model policy keeps earlier thresholds, summarizer and retry settings', (t) => {
  const original = { ...target, thresholdRatio: .2, headroomTokens: 77_000, retainRatio: .1,
    summarizationProvider: 'fixture-summary', summarizationModel: 'summary', maxTokens: 1234, compactionRetries: 0, maxOverflowRetries: 0 }
  const { engine } = fixture(t, TeamChildCompaction, { modelPolicies: [original] })
  assert.deepEqual(childCompactionPolicy(engine.config, target, info(1_000_000), 32_768), original)
  const other = childCompactionPolicy(engine.config, { provider: 'fixture', model: 'other' }, info(1_000_000), 32_768)
  assert.equal(other.thresholdRatio, .4)
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, .2)
})

test('bounding a route preserves custom settings and legal retained tails', (t) => {
  const original = { ...target, thresholdRatio: .7, retainTokens: 175_000, summarizationProvider: 'fixture-summary',
    summarizationModel: 'summary', maxTokens: 4096, compactionRetries: 0, maxOverflowRetries: 0 }
  const { engine } = fixture(t, TeamChildCompaction, { modelPolicies: [original] })
  assert.deepEqual(childCompactionPolicy(engine.config, target, info(1_000_000), 32_768), { ...original, thresholdRatio: .4 })
})

test('only tails that no longer fit are reduced; invalid capacities/pressure remain upstream errors', (t) => {
  const { engine } = fixture(t, TeamChildCompaction, { retainRatio: .6 })
  const policy = childCompactionPolicy(engine.config, target, info(1_000_000), 32_768)
  assert.equal(policy.retainTokens, 200_000)
  assert.equal(policy.retainRatio, undefined)
  for (const bad of [{}, info(0), info(NaN), info(1.5)]) assert.equal(childCompactionPolicy(engine.config, target, bad, 0), undefined)
  assert.equal(childCompactionPolicy(engine.config, target, info(1_000_000), -1), undefined)
  assert.equal(childCompactionPolicy(engine.config, target, info(1_000_000), 1_000_000), undefined)
})

test('upstream backend starts a large child at the budget, with no window/request mutation', async (t) => {
  const f = fixture(t), a = f.agent()
  const before = structuredClone(a.session.requestHeader())
  assert.notEqual(await f.engine.compactIfNeeded(a, 'pressure', signal()), null)
  assert.equal(f.compacted.length, 1)
  assert.deepEqual(a.session.requestHeader(), before)
  assert.equal(f.models.size, 0)
  assert.equal(f.engine.config.auto, false)
})

test('baseline parent/normal backend stays unchanged at the same pressure', async (t) => {
  const f = fixture(t, BasicCompactionEngine), a = f.agent()
  assert.equal(await f.engine.compactIfNeeded(a, 'pressure', signal()), null)
  assert.equal(f.compacted.length, 0)
})

test('a child below budget is not summarized; smaller windows keep their original boundary', async (t) => {
  const f = fixture(t)
  assert.equal(await f.engine.compactIfNeeded(f.agent('large', 399_999), 'pressure', signal()), null)
  f.models.set('fixture/small', info(256_000))
  assert.notEqual(await f.engine.compactIfNeeded(f.agent('small', 180_000), 'pressure', signal()), null)
  assert.deepEqual(f.compacted.map((x) => x.model), ['small'])
})

test('pruning is still tried before an auxiliary summary call', async (t) => {
  const f = fixture(t), a = f.agent()
  let prunes = 0
  f.ctx.provide('toolResultPruner', { pruneSession(session) { prunes++; f.state.set(session, 350_000) } })
  assert.equal(await f.engine.compactIfNeeded(a, 'pressure', signal()), null)
  assert.equal(prunes, 1)
  assert.equal(f.compacted.length, 0)
})

test('repeated/resumed routes do not compound caps, and capacity changes restore the original policy', async (t) => {
  const f = fixture(t), a = f.agent('same', 10_000)
  await f.engine.compactIfNeeded(a, 'pressure', signal())
  await f.engine.compactIfNeeded(a, 'pressure', signal())
  assert.equal(f.engine.config.modelPolicies.length, 1)
  assert.equal(f.engine.config.modelPolicies[0].thresholdRatio, .4)
  f.models.set('fixture/same', info(256_000))
  await f.engine.compactIfNeeded(a, 'pressure', signal())
  assert.deepEqual(f.engine.config.modelPolicies, [])
  const resumed = fixture(t)
  await resumed.engine.compactIfNeeded(resumed.agent('same', 10_000), 'pressure', signal())
  assert.equal(resumed.engine.config.modelPolicies[0].thresholdRatio, .4)
})

test('concurrent routes retain independent caps and preserve configured target overrides', async (t) => {
  const f = fixture(t, TeamChildCompaction, { modelPolicies: [{ provider: 'fixture', model: 'small', thresholdRatio: .3, retainRatio: .1 }] })
  f.models.set('fixture/huge', info(2_000_000))
  f.models.set('fixture/small', info(256_000))
  await Promise.all(['large', 'huge', 'small'].map((m) => f.engine.compactIfNeeded(f.agent(m, 10_000), 'pressure', signal())))
  const policies = Object.fromEntries(f.engine.config.modelPolicies.map(p => [p.model, p.thresholdRatio]))
  assert.deepEqual(policies, { large: .4, huge: .2, small: .3 })
})

test('a cancellation or missing route does not start any model operation', async (t) => {
  const f = fixture(t), a = f.agent()
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.engine.compactIfNeeded(a, 'pressure', controller.signal), { name: 'AbortError' })
  assert.equal(f.lookups.length, 0)
  a.session.requestHeader = () => undefined
  assert.equal(await f.engine.compactIfNeeded(a, 'pressure', signal()), null)
  assert.equal(f.lookups.length, 0)
})

test('overflow recovery still uses the upstream entry path', async (t) => {
  const f = fixture(t), a = f.agent('large', 450_000)
  await f.engine.compactIfNeeded(a, 'context-overflow', signal())
  assert.equal(f.lookups.length, 0)
  assert.equal(f.compacted.length, 1)
  assert.deepEqual(f.engine.config.modelPolicies, [])
})
