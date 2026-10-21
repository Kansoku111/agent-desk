import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fixture, deferred } from './helpers/thread-manager.js'

const usage = { requests: 1, input: 100, output: 10, cacheRead: 1000, cacheWrite: 0,
  reasoning: 0, cost: null, models: ['deepseek-official/deepseek-flash'] }

async function savedTurn(f) {
  await fs.mkdir(path.dirname(f.turnFile), { recursive: true })
  f.manager.threads.get(f.thread.id).sessionId = 'old-session'
  await fs.writeFile(f.turnFile, JSON.stringify({ version: 1, receipts: [], turns: [{
    id: 'old-turn', startedAt: 100, endedAt: 200, status: 'done', usage,
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
