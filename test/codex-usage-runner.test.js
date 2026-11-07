import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { CodexRunner } from '../server/codex-runner.js'
import { setCatalogPricing } from '../server/usage.js'

const rates = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }] }
class FakeServer extends EventEmitter {
  thread = 0
  turn = 0
  async use(fn) { return fn() }
  async rawRequest(method, params = {}) {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fake@example.test' } }
    if (method === 'model/list') return { data: [{ model: 'gpt-mock', displayName: 'Mock', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
    if (method === 'thread/start') return { thread: { id: 'thread-' + ++this.thread } }
    if (method === 'thread/resume') return { thread: { id: params.threadId } }
    if (method === 'turn/start') return { turn: { id: 'turn-' + ++this.turn } }
    return {}
  }
  async stop() {}
}
const row = (input, output = 0) => ({ inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output })
const dollars = score => score.points * 0.002
async function setup(t) {
  const parent = path.resolve(os.tmpdir())
  const dir = await fs.mkdtemp(path.join(parent, 'codex-usage-test-'))
  assert.equal(path.dirname(dir), parent)
  const server = new FakeServer()
  setCatalogPricing({ 'openai-codex/gpt-mock': rates })
  const runner = await new CodexRunner({ home: dir, attachmentsDir: dir, server }).load()
  t.after(async () => { await runner.shutdown(); setCatalogPricing({}); assert.equal(path.dirname(dir), parent); assert.match(path.basename(dir), /^codex-usage-test-/); await fs.rm(dir, { recursive: true, force: true }) })
  const task = await runner.create({ workspace: dir, model: 'gpt-mock', effort: 'low' })
  return { dir, server, runner, task }
}
async function start(f) {
  f.runner.run(f.task.id, 'synthetic')
  const turnId = await f.runner.waitForStart(f.task.id)
  return { threadId: f.runner.get(f.task.id).sessionId, turnId }
}
function usage(f, ids, total, last) {
  f.server.emit('notification', 'thread/tokenUsage/updated', { ...ids, tokenUsage: { total, ...(last ? { last } : {}), modelContextWindow: 272000 } })
}
async function finish(f, ids) {
  const completed = once(f.runner, 'finished')
  f.server.emit('notification', 'turn/completed', { threadId: ids.threadId, turn: { id: ids.turnId, status: 'completed', items: [] } })
  await completed
}

test('runner prices and persists distinct response tiers across turns', async t => {
  const f = await setup(t)
  const a = await start(f)
  usage(f, a, row(150000, 10), row(150000, 10))
  usage(f, a, row(150000, 10), row(150000, 10))
  usage(f, a, row(300000, 20), row(150000, 10))
  await finish(f, a)
  const first = f.runner.turns(f.task.id)[0]
  assert.equal(first.usage.requests, 2)
  assert.equal(first.usage.requestsExact, true)
  assert.ok(Math.abs(dollars(first.usage.score) - 0.03001) < 1e-12)
  const b = await start(f)
  usage(f, b, row(600000, 30), row(300000, 10))
  await finish(f, b)
  const second = f.runner.turns(f.task.id)[1]
  assert.equal(second.usage.requests, 1)
  assert.ok(Math.abs(dollars(second.usage.score) - 0.0600075) < 1e-12)
  assert.ok(Math.abs(dollars(second.totalScore) - 0.0900175) < 1e-12)
  const saved = JSON.parse(await fs.readFile(path.join(f.dir, 'codex-tasks', f.task.id + '.json'), 'utf8'))
  assert.equal(saved.turns[0].usage.requestsExact, true)
  assert.equal(saved.turns[0].usage.requests, 2)
})

test('missed response usage is partial and the next turn rebases correctly', async t => {
  const f = await setup(t)
  const a = await start(f)
  usage(f, a, row(300000, 20), row(150000, 10))
  await finish(f, a)
  const first = f.runner.turns(f.task.id)[0].usage
  assert.equal(first.requests, 1)
  assert.equal(first.requestsExact, false)
  assert.equal(first.score.unpriced, 1)
  assert.ok(Math.abs(dollars(first.score) - 0.015005) < 1e-12)
  const b = await start(f)
  usage(f, b, row(300100, 22), row(100, 2))
  await finish(f, b)
  const next = f.runner.turns(f.task.id)[1].usage
  assert.equal(next.requestsExact, true)
  assert.equal(next.input, 100)
  assert.equal(next.output, 2)
})

test('a later turn warns when the unchanged cumulative score includes a legacy GP turn', async t => {
  const f = await setup(t)
  const a = await start(f)
  usage(f, a, row(100, 10), row(100, 10))
  await finish(f, a)
  delete f.runner.turns(f.task.id)[0].usage.requestsExact
  const b = await start(f)
  usage(f, b, row(200, 20), row(100, 10))
  await finish(f, b)
  const second = f.runner.turns(f.task.id)[1]
  assert.equal(second.usage.requestsExact, true)
  assert.equal(second.previousLegacyEstimate, true)
})

test('restart retains old amounts and flags a later interrupted cumulative turn', async t => {
  const f = await setup(t)
  const a = await start(f)
  usage(f, a, row(100, 10), row(100, 10))
  await finish(f, a)
  const b = await start(f)
  usage(f, b, row(200, 20), row(100, 10))
  await finish(f, b)
  const file = path.join(f.dir, 'codex-tasks', f.task.id + '.json')
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  const original = structuredClone(saved.turns[0].usage.score)
  delete saved.turns[0].usage.requestsExact
  delete saved.turns[1].previousLegacyEstimate
  saved.turns[1].status = 'running'
  await f.runner.shutdown()
  await fs.writeFile(file, JSON.stringify(saved))
  const restored = await new CodexRunner({ home: f.dir, attachmentsDir: f.dir, server: new FakeServer() }).load()
  try {
    const turns = restored.turns(f.task.id)
    assert.deepEqual(turns[0].usage.score, original)
    assert.equal(turns[0].usage.requestsExact, undefined)
    assert.equal(turns[1].status, 'cancelled')
    assert.equal(turns[1].previousLegacyEstimate, true)
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.deepEqual(onDisk.turns[0].usage.score, original)
    assert.equal(onDisk.turns[1].previousLegacyEstimate, true)
  } finally { await restored.shutdown() }
})

test('a rejected final total invalidates the next turn baseline', async t => {
  const f = await setup(t)
  const a = await start(f)
  usage(f, a, row(100, 10), row(100, 10))
  usage(f, a, row(90, 10), row(1))
  await finish(f, a)
  assert.equal(f.runner.turns(f.task.id)[0].usage.requestsExact, false)
  const b = await start(f)
  usage(f, b, row(200, 20), row(100, 10))
  await finish(f, b)
  assert.equal(f.runner.turns(f.task.id)[1].usage, undefined)
  const c = await start(f)
  usage(f, c, row(300, 30), row(100, 10))
  await finish(f, c)
  assert.equal(f.runner.turns(f.task.id)[2].usage.input, 100)
})
