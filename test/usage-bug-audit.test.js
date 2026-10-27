import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { setCatalogPricing, turnUsage } from '../server/usage.js'
import { dailyUsage, localDay, summarizeHistory, UsageHistory } from '../server/usage-history.js'

// 監査の採用候補 2（孫の利用量）と 5（未算定の表示）の回帰テスト。
const sonnet = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
const usage = { inputTokens: 1000, outputTokens: 100 }
const now = Date.now()
const sonnetCost = (inputTokens, outputTokens) => (inputTokens * 2 + outputTokens * 10) / 1e6
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)
const frame = (events) => zlib.zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n'))
const response = (id, seq, provider, model, value = usage) => ({
  type: 'assistant/message', seq, time: now + seq, data: { message: { id, source: { provider, model } }, usage: value },
})

async function sessionsIn(home, files) {
  for (const [id, events] of Object.entries(files)) {
    const file = path.join(home, 'sessions', '--work--', id, 'session.v4.jsonl.zstd')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, frame(events))
  }
}

async function tempHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-bug-audit-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  return home
}

test('turn usage counts a grandchild the subagent started, as the history does', async (t) => {
  setCatalogPricing({ 'anthropic/claude-sonnet-5-5': sonnet })
  t.after(() => setCatalogPricing({}))
  const home = await tempHome(t)
  await sessionsIn(home, {
    parent: [{ type: 'session', id: 'parent' }, response('p1', 1, 'openai-codex', 'gpt-5.5'), { type: 'turn/end', seq: 2, time: now + 3 }],
    child: [{ type: 'session', id: 'child', parentSession: 'parent', delegationDepth: 1 }, response('c1', 1, 'anthropic', 'claude-sonnet-5-5')],
    grandchild: [{ type: 'session', id: 'grandchild', parentSession: 'child', delegationDepth: 2 }, response('g1', 1, 'anthropic', 'claude-sonnet-5-5')],
  })
  const turn = await turnUsage({ dshHome: home, sessionId: 'parent', since: now - 1000, waitMs: 0 })
  const history = await new UsageHistory({ dshHome: home, file: path.join(home, 'usage-history.json'), now: () => now }).refresh()
  assert.equal(turn.requests, 3)
  assert.equal(turn.requests, history.all.requests)
  assert.equal(turn.input, history.all.input)
  near(turn.cost, 2 * sonnetCost(1000, 100))
  near(history.all.cost, turn.cost)
})

test('subagent folders that name each other are not reached from the turn', async (t) => {
  setCatalogPricing({ 'anthropic/claude-sonnet-5-5': sonnet })
  t.after(() => setCatalogPricing({}))
  const home = await tempHome(t)
  await sessionsIn(home, {
    parent: [{ type: 'session', id: 'parent' }, response('p1', 1, 'openai-codex', 'gpt-5.5'), { type: 'turn/end', seq: 2, time: now + 3 }],
    child: [{ type: 'session', id: 'child', parentSession: 'parent' }, response('c1', 1, 'anthropic', 'claude-sonnet-5-5')],
    a: [{ type: 'session', id: 'a', parentSession: 'b' }, response('a1', 1, 'anthropic', 'claude-sonnet-5-5')],
    b: [{ type: 'session', id: 'b', parentSession: 'a' }, response('b1', 1, 'anthropic', 'claude-sonnet-5-5')],
  })
  const turn = await turnUsage({ dshHome: home, sessionId: 'parent', since: now - 1000, waitMs: 0 })
  assert.equal(turn.requests, 2)
})

test('a billed model without a known price is unpriced at every level; free and subscription usage are not', () => {
  const pricing = new Map([['anthropic/claude-sonnet-5-5', sonnet], ['anthropic/free', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]])
  const events = [
    response('k1', 1, 'anthropic', 'claude-sonnet-5-5'),
    response('u1', 2, 'anthropic', 'new-model'),
    response('f1', 3, 'anthropic', 'free'),
    response('s1', 4, 'openai-codex', 'gpt-5.5'),
  ]
  const day = localDay(now)
  const summary = summarizeHistory({ a: { days: dailyUsage(events, pricing) } }, now)
  assert.equal(summary.all.requests, 4)
  near(summary.all.cost, sonnetCost(1000, 100))
  assert.equal(summary.all.unpriced, 1)
  assert.equal(summary.today.unpriced, 1)
  assert.equal(summary.month.unpriced, 1)
  assert.equal(summary.providers.anthropic.all.unpriced, 1)
  assert.equal(summary.providers['openai-codex'].all.unpriced, 0)
  assert.equal(summary.providers['openai-codex'].all.cost, null)
  const model = (name) => summary.models.find((entry) => entry.model === name)
  assert.equal(model('anthropic/new-model').all.cost, null)
  assert.equal(model('anthropic/new-model').all.unpriced, 1)
  assert.equal(model('anthropic/free').all.cost, 0)
  assert.equal(model('anthropic/free').all.unpriced, 0)
  assert.equal(model('openai-codex/gpt-5.5').all.unpriced, 0)
  const point = summary.daily.find((entry) => entry.day === day)
  assert.equal(point.unpriced, 1)
  near(point.cost, sonnetCost(1000, 100))
  const onlyUnknown = summarizeHistory({ b: { days: dailyUsage([response('u2', 1, 'anthropic', 'new-model')], pricing) } }, now)
  assert.equal(onlyUnknown.today.cost, null)
  assert.equal(onlyUnknown.today.unpriced, 1)
  const empty = summarizeHistory({}, now)
  assert.equal(empty.all.cost, null)
  assert.equal(empty.all.unpriced, 0)
})

test('an existing history cache is repriced once, and its unpriced responses are counted, deleted logs included', async (t) => {
  const home = await tempHome(t)
  const dshHome = path.join(home, 'dsh-home')
  const kept = path.join(dshHome, 'sessions', '--work--', 'kept', 'session.v4.jsonl.zstd')
  await fs.mkdir(path.dirname(kept), { recursive: true })
  await fs.writeFile(kept, frame([response('k1', 1, 'anthropic', 'claude-sonnet-5-5'), response('u1', 2, 'anthropic', 'new-model')]))
  const stat = await fs.stat(kept)
  const pricing = new Map([['anthropic/claude-sonnet-5-5', sonnet]])
  // Rows as the previous version wrote them: no unpriced count.
  const row = (requests, input, cost) => ({ requests, input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost })
  const day = localDay(now)
  const cacheFile = path.join(home, 'usage-history.json')
  await fs.writeFile(cacheFile, JSON.stringify({ version: 1, pricing: 'before-unpriced-count', files: {
    '--work--/deleted': { size: 10, mtimeMs: 1, days: { [day]: { 'anthropic/new-model': row(2, 2000, null) } } },
    '--work--/kept': { size: stat.size, mtimeMs: stat.mtimeMs, offset: 0, days: { [day]: {
      'anthropic/claude-sonnet-5-5': row(1, 1000, 0.002), 'anthropic/new-model': row(1, 1000, null),
    } } },
  } }))
  const summary = await new UsageHistory({ dshHome, file: cacheFile, pricing: async () => pricing, now: () => now }).refresh()
  near(summary.all.cost, sonnetCost(1000, 100))
  assert.equal(summary.all.unpriced, 3)
  assert.equal(summary.all.input, 4000)
  const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
  assert.equal(cached.files['--work--/deleted'].days[day]['anthropic/new-model'].unpriced, 2)
  assert.equal(cached.files['--work--/kept'].days[day]['anthropic/new-model'].unpriced, 1)
  assert.equal(cached.files['--work--/kept'].days[day]['anthropic/claude-sonnet-5-5'].unpriced, 0)
})
