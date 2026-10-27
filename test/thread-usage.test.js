import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { test } from 'node:test'
import { turnUsage } from '../server/usage.js'
import { fixture, deferred } from './helpers/thread-manager.js'

const usage = { requests: 1, input: 100, output: 10, cacheRead: 1000, cacheWrite: 0,
  reasoning: 0, cost: null, models: ['deepseek-official/deepseek-flash'] }

async function savedTurn(f, savedUsage = usage, extra = {}) {
  await fs.mkdir(path.dirname(f.turnFile), { recursive: true })
  f.manager.threads.get(f.thread.id).sessionId = 'old-session'
  await fs.writeFile(f.turnFile, JSON.stringify({ version: 1, receipts: [], turns: [{
    id: 'old-turn', startedAt: 100, endedAt: 200, status: 'done', usage: savedUsage, ...extra,
  }] }))
  f.manager.turns.delete(f.thread.id)
}

test('opening a historical DeepSeek turn fills its cost from the matching bounded log', async (t) => {
  const calls = []
  const f = await fixture(t, { getTurnUsage: async (args) => { calls.push(args); return { ...usage, cost: 0.000024 } } })
  await savedTurn(f)
  const loaded = await f.manager.get(f.thread.id)
  assert.equal(loaded.turns[0].usage.cost, 0.000024)
  assert.equal(calls[0].since, 100)
  assert.equal(calls[0].until, 200)
  assert.equal(calls[0].waitMs, 0)
  await f.manager.shutdown()
  assert.equal((await f.disk()).turns[0].usage.cost, 0.000024)
})

test('a changed session or missing log cannot overwrite a historical usage record', async (t) => {
  const f = await fixture(t, { getTurnUsage: async () => ({ ...usage, requests: 2, cost: 1 }) })
  await savedTurn(f)
  assert.equal((await f.manager.get(f.thread.id)).turns[0].usage.cost, null)
})

const terra = { ...usage, models: ['openai-codex/gpt-6.1-terra'], score: { points: 0, priced: 0, unpriced: 1 } }
const terraRepaired = { ...terra, score: { points: 0.2, priced: 1, unpriced: 0 } }

test('opening an unpriced Terra turn recovers its score from the matching bounded log', async (t) => {
  const calls = []
  const f = await fixture(t, { getTurnUsage: async (args) => { calls.push(args); return terraRepaired } })
  await savedTurn(f, terra)
  const loaded = await f.manager.get(f.thread.id)
  assert.deepEqual(loaded.turns[0].usage, terraRepaired)
  assert.deepEqual(loaded.thread.score, terraRepaired.score)
  assert.equal(calls[0].since, 100)
  assert.equal(calls[0].until, 200)
  assert.equal(calls[0].waitMs, 0)
  await f.manager.shutdown()
  assert.deepEqual((await f.disk()).turns[0].usage, terraRepaired)
})

test('a stored Terra turn is recovered once from real session logs and per-response tiers', async (t) => {
  let calls = 0
  const f = await fixture(t, { getTurnUsage: (args) => { calls++; return turnUsage(args) } })
  const prior = { requests: 2, input: 122000, output: 300, cacheRead: 152001, cacheWrite: 0,
    reasoning: 0, cost: null, models: terra.models, score: { points: 0, priced: 0, unpriced: 2 } }
  await savedTurn(f, prior)
  const event = (seq, time, usage) => ({ type: 'assistant/message', seq, time,
    data: { message: { id: String(seq), source: { provider: 'openai-codex', model: 'gpt-6.1-terra' } }, usage } })
  const events = [{ type: 'session', id: 'old-session' },
    event(1, 110, { inputTokens: 120000, cacheReadTokens: 152001, outputTokens: 100 }),
    event(2, 120, { inputTokens: 2000, outputTokens: 200 }), { type: 'turn/end', time: 150 }]
  const file = path.join(f.paths.dshHome, 'sessions', 'work', 'old-session', 'session.v4.jsonl.zstd')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, zlib.zstdCompressSync(Buffer.from(events.map((entry) => JSON.stringify(entry)).join('\n') + '\n')))
  const loaded = await f.manager.get(f.thread.id)
  const score = loaded.turns[0].usage.score
  assert.ok(Math.abs(score.points * 0.002 - 0.2589501) < 1e-10)
  assert.equal(score.priced, 2)
  assert.equal(score.unpriced, 0)
  assert.equal(loaded.turns[0].usage.cost, null)
  await f.manager.shutdown()
  const reopened = f.makeManager()
  await reopened.load()
  assert.deepEqual((await reopened.get(f.thread.id)).turns[0].usage.score, score)
  assert.equal(calls, 1, 'a saved known score is not recomputed')
})

test('partly missing Terra usage remains explicitly unpriced after recovery', async (t) => {
  const prior = { ...terra, requests: 2, score: { points: 0, priced: 0, unpriced: 2 } }
  const recovered = { ...prior, score: { points: 0.2, priced: 1, unpriced: 1 } }
  const f = await fixture(t, { getTurnUsage: async () => recovered })
  await savedTurn(f, prior)
  assert.deepEqual((await f.manager.get(f.thread.id)).thread.score, recovered.score)
})

test('Terra recovery never changes known, mixed, mismatched, or missing usage', async (t) => {
  for (const [saved, found, extra, shouldRead] of [
    [terra, null, {}, true],
    [terra, { ...terraRepaired, input: 101 }, {}, true],
    [terra, { ...terraRepaired, models: ['openai-codex/other'] }, {}, true],
    [{ ...terra, score: { points: 5, priced: 1, unpriced: 0 } }, terraRepaired, {}, false],
    [{ ...terra, models: [...terra.models, 'anthropic/claude-sonnet-5-5'] }, terraRepaired, {}, false],
    [terra, terraRepaired, { totalScore: { points: 4, priced: 1, unpriced: 1 } }, false],
    [terra, terraRepaired, { endedAt: null }, false],
  ]) {
    const calls = []
    const f = await fixture(t, { getTurnUsage: async () => { calls.push(1); return found } })
    await savedTurn(f, saved, extra)
    assert.deepEqual((await f.manager.get(f.thread.id)).turns[0].usage, saved)
    assert.equal(calls.length > 0, shouldRead)
  }
})

test('removal during historical repricing cannot resurrect the thread', async (t) => {
  const started = deferred(), finish = deferred()
  const f = await fixture(t, { getTurnUsage: async () => { started.resolve(); return finish.promise } })
  await savedTurn(f)
  const opening = f.manager.get(f.thread.id)
  const rejected = assert.rejects(opening, /削除|見つかりません/)
  await started.promise
  const removal = f.manager.remove(f.thread.id)
  finish.resolve({ ...usage, cost: 1 })
  await removal
  await rejected
  assert.equal(f.manager.list().length, 0)
})
