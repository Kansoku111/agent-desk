import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deferred, fixture } from './helpers/thread-manager.js'
import { handoffThreadToClaude } from '../server/normal-fallback-handoff.js'

const target = '["other","fallback"]'
const routes = () => [{ model: target, effort: 'low' }]
function runtimeOptions(f) {
  let model = f.thread.model, effort = 'low'
  const options = () => [
    { id: 'model', currentValue: model, options: [{ value: model }] },
    { id: 'reasoning_effort', currentValue: effort, options: [{ value: 'low', name: 'Low' }] },
  ]
  f.runtime.newSession = async () => { f.runtime.liveSessions.add('session'); return { sessionId: 'session', configOptions: options() } }
  f.runtime.setOption = async (_id, key, value) => {
    if (key === 'model') model = value
    if (key === 'reasoning_effort') effort = value
    return options()
  }
}

test('a hidden dsh handoff target cannot be operated before reveal', async (t) => {
  const f = await fixture(t)
  runtimeOptions(f)
  const events = []
  f.manager.on('thread', (entry) => events.push(entry.id))
  const created = await f.manager.create({ workspace: f.base, model: f.thread.model, effort: 'low',
    usageFallbackFrom: { kind: 'terminal', id: 'source' }, usageFallbackPending: true, toolMode: 'native' })
  assert.equal(f.manager.list().some((entry) => entry.id === created.id), false)
  await assert.rejects(f.manager.get(created.id), /準備中/)
  await assert.rejects(f.manager.send(created.id, { text: 'manual' }), /準備中/)
  await assert.rejects(f.manager.cancel(created.id), /準備中/)
  assert.throws(() => f.manager.remove(created.id), /準備中/)
  await f.manager.deliverUsageFallback(created.id, { text: 'continue' }, { model: f.thread.model, effort: 'low' }, () => {})
  assert.equal(events.includes(created.id), false)
  await f.manager.revealUsageFallback(created.id)
  assert.equal(f.manager.list().some((entry) => entry.id === created.id), true)
  assert.equal(events.includes(created.id), true)
})

test('hidden dsh target is restored as interrupted without automatic replay', async (t) => {
  const f = await fixture(t)
  const target = await f.manager.create({ workspace: f.base, model: f.thread.model,
    usageFallbackFrom: { kind: 'terminal', id: 'source' }, usageFallbackPending: true })
  const restored = f.makeManager()
  await restored.load()
  const found = restored.list().find((entry) => entry.id === target.id)
  assert.equal(found.usageFallbackInterrupted, true)
  assert.equal(found.status, 'idle')
  assert.equal(f.calls.prompts.length, 0)
})

test('ordinary dsh task retries an exhausted human turn once with its saved route', async (t) => {
  const selected = routes()
  const f = await fixture(t, { usageFallbackRoutes: () => selected })
  runtimeOptions(f)
  const done = deferred(), prompts = []
  f.runtime.prompt = async (_id, blocks) => {
    prompts.push(blocks)
    if (prompts.length === 1) throw new Error('usage_limit_reached')
    return { stopReason: 'end_turn' }
  }
  f.manager.on('turn-finished', () => { if (prompts.length === 2) done.resolve() })
  await f.manager.send(f.thread.id, { text: 'do the work', plan: true }, { userInitiated: true })
  selected.splice(0)
  await done.promise
  const { thread, turns } = await f.manager.get(f.thread.id)
  assert.equal(thread.model, target)
  assert.equal(thread.effort, 'low')
  assert.equal(turns.length, 2)
  assert.equal(turns[0].usageFallback.model, target)
  assert.equal(turns[1].usageFallback.sourceTurnId, turns[0].id)
  assert.equal(turns[1].user.plan, true)
  assert.match(prompts[1].map((block) => block.text ?? '').join(' '), /重複実行しない/)
  const disk = await f.disk()
  assert.equal(disk.turns[0].usageFallback.model, target)
})

test('ordinary dsh task never changes route for transient throttling or internal turns', async (t) => {
  for (const [message, userInitiated] of [['429 rate limit', true], ['usage_limit_reached', false]]) {
    const f = await fixture(t, { usageFallbackRoutes: routes })
    runtimeOptions(f)
    let count = 0
    f.runtime.prompt = async () => { count++; throw new Error(message) }
    const done = deferred()
    f.manager.once('turn-finished', done.resolve)
    await f.manager.send(f.thread.id, { text: 'work' }, { userInitiated })
    await done.promise
    assert.equal(f.manager.pendingFallbacks.size, 0)
    assert.equal(f.manager.threads.get(f.thread.id).model, f.thread.model)
    assert.equal(count, 1)
  }
})

test('a fallback that reaches its own limit stops without cycling', async (t) => {
  const f = await fixture(t, { usageFallbackRoutes: routes })
  runtimeOptions(f)
  const done = deferred()
  let count = 0
  f.runtime.prompt = async () => { count++; throw new Error('usage_limit_reached') }
  f.manager.on('turn-finished', () => { if (count === 2) done.resolve() })
  await f.manager.send(f.thread.id, { text: 'work' }, { userInitiated: true })
  await done.promise
  assert.equal(count, 2)
  assert.equal(f.manager.pendingFallbacks.size, 0)
  assert.equal((await f.manager.get(f.thread.id)).turns.at(-1).status, 'error')
})

test('changing the next model while a turn runs never gets overwritten by fallback', async (t) => {
  const f = await fixture(t, { usageFallbackRoutes: routes })
  runtimeOptions(f)
  const started = deferred(), fail = deferred(), finished = deferred()
  let count = 0
  f.runtime.prompt = async () => { count++; started.resolve(); await fail.promise; throw new Error('usage_limit_reached') }
  f.manager.once('turn-finished', finished.resolve)
  await f.manager.send(f.thread.id, { text: 'work' }, { userInitiated: true })
  await started.promise
  const manual = '["third","manual"]'
  await f.manager.update(f.thread.id, { model: manual })
  fail.resolve()
  await finished.promise
  const { thread, turns } = await f.manager.get(f.thread.id)
  assert.equal(thread.model, manual)
  assert.equal(turns[0].executedModel, f.thread.model)
  assert.match(turns[0].items.at(-1).text, /実行中にモデルまたは推論レベルが変更/)
  assert.equal(count, 1)
  assert.equal(f.manager.pendingFallbacks.size, 0)
  await f.manager.shutdown()
  assert.match((await f.disk()).turns[0].items.at(-1).text, /実行中にモデルまたは推論レベルが変更/)
})

test('changing the next reasoning level while a turn runs prevents fallback', async (t) => {
  const f = await fixture(t, { usageFallbackRoutes: routes })
  runtimeOptions(f)
  const started = deferred(), fail = deferred(), finished = deferred()
  f.runtime.prompt = async () => { started.resolve(); await fail.promise; throw new Error('usage_limit_reached') }
  f.manager.once('turn-finished', finished.resolve)
  await f.manager.send(f.thread.id, { text: 'work' }, { userInitiated: true })
  await started.promise
  await f.manager.update(f.thread.id, { effort: 'high' })
  fail.resolve()
  await finished.promise
  const { thread, turns } = await f.manager.get(f.thread.id)
  assert.equal(thread.effort, 'high')
  assert.equal(thread.model, f.thread.model)
  assert.match(turns[0].items.at(-1).text, /推論レベルが変更/)
})

test('fallback stops if the runtime cannot confirm the actual source model', async (t) => {
  const f = await fixture(t, { usageFallbackRoutes: routes })
  f.runtime.prompt = async () => { throw new Error('usage_limit_reached') }
  const finished = deferred()
  f.manager.once('turn-finished', finished.resolve)
  await f.manager.send(f.thread.id, { text: 'work' }, { userInitiated: true })
  await finished.promise
  const { thread, turns } = await f.manager.get(f.thread.id)
  assert.equal(thread.model, f.thread.model)
  assert.equal(turns[0].executedModel, null)
  assert.match(turns[0].items.at(-1).text, /使用したモデルを確認できない/)
})

test('ordinary fallback stops when earlier goal state cannot be proven inactive', async (t) => {
  const f = await fixture(t, { usageFallbackRoutes: routes })
  runtimeOptions(f)
  f.manager.turns.get(f.thread.id).push({ id: 'goal', status: 'done', user: { text: '/goal complete the project', images: [] }, items: [] })
  f.runtime.prompt = async () => { throw new Error('usage_limit_reached') }
  const failed = deferred(), idle = deferred()
  f.manager.on('turn', ({ turn }) => { if (turn.usageFallback?.status === 'failed') failed.resolve(turn) })
  f.manager.on('idle', () => { assert.equal(f.manager.busy, false); idle.resolve() })
  await f.manager.send(f.thread.id, { text: 'continue' }, { userInitiated: true })
  const turn = await failed.promise
  await idle.promise
  assert.equal(f.manager.pendingFallbacks.size, 0)
  assert.match(turn.items.at(-1).text, /ゴールの状態/)
  assert.equal(f.manager.threads.get(f.thread.id).model, f.thread.model)
})

test('fallback refuses to run when the runtime does not apply the selected model', async (t) => {
  const f = await fixture(t, { usageFallbackRoutes: routes })
  runtimeOptions(f)
  const setOption = f.runtime.setOption
  f.runtime.setOption = async (id, key, value) => key === 'model' && value === target ? setOption(id, 'model', f.thread.model) : setOption(id, key, value)
  const done = deferred()
  let count = 0, finished = 0
  f.runtime.prompt = async () => { count++; throw new Error('usage_limit_reached') }
  f.manager.on('turn-finished', () => { if (++finished === 2) done.resolve() })
  await f.manager.send(f.thread.id, { text: 'work' }, { userInitiated: true })
  await done.promise
  const { turns } = await f.manager.get(f.thread.id)
  assert.equal(count, 1)
  assert.match(turns.at(-1).error.message, /フォールバック先モデルの適用を確認できません/)
})

test('fallback preserves image context by refusing unknown image routes', async (t) => {
  const f = await fixture(t, { usageFallbackRoutes: routes })
  runtimeOptions(f)
  f.manager.turns.get(f.thread.id).push({ id: 'previous', status: 'done', user: { text: 'earlier', images: [{ file: 'abcdef.png' }] }, items: [] })
  f.runtime.prompt = async () => { throw new Error('usage_limit_reached') }
  const refused = deferred()
  f.manager.on('turn', ({ turn }) => { if (turn.usageFallback?.status === 'failed') refused.resolve(turn) })
  await f.manager.send(f.thread.id, { text: 'work' }, { userInitiated: true })
  const turn = await refused.promise
  assert.match(turn.items.at(-1).text, /画像を含む会話/)
  assert.equal(f.manager.threads.get(f.thread.id).model, f.thread.model)
})

test('a full-access dsh task durably links a Claude target before one handoff', async (t) => {
  const calls = [], visible = deferred()
  let f
  const terminals = {
    create: async (options) => { calls.push(['create', options]); return { id: 'claude-target' } },
    deliverUsageFallback: async (id, prompt, guard) => {
      guard()
      const index = JSON.parse(await (await import('node:fs/promises')).readFile(f.paths.threadsIndex, 'utf8'))
      assert.equal(index.threads[0].fallbackTo.id, id)
      assert.equal(f.manager.summary(f.manager.threads.get(f.thread.id)).fallbackTo, undefined)
      calls.push(['deliver', id, prompt])
    },
    revealUsageFallback: async (id) => calls.push(['reveal', id]),
    stopUsageFallback: () => assert.fail('unexpected stop'),
    discardUsageFallback: async () => assert.fail('unexpected discard'),
  }
  f = await fixture(t, { usageFallbackRoutes: () => [{ model: 'claude:haiku', effort: 'low' }],
    handoffClaude: (options) => handoffThreadToClaude({ ...options, terminals }) })
  await f.manager.update(f.thread.id, { permissionMode: 'danger-full-access' })
  runtimeOptions(f)
  f.runtime.prompt = async () => { throw new Error('usage_limit_reached') }
  f.manager.on('thread', (view) => { if (view.fallbackTo) visible.resolve(view) })
  await f.manager.send(f.thread.id, { text: 'work' }, { userInitiated: true })
  const view = await visible.promise
  assert.deepEqual(view.fallbackTo, { kind: 'terminal', id: 'claude-target' })
  assert.deepEqual(calls.map((entry) => entry[0]), ['create', 'deliver', 'reveal'])
  assert.match(calls[1][2], /work/)
  await assert.rejects(f.manager.send(f.thread.id, { text: 'duplicate' }, { userInitiated: true }), /切り替え済み/)
  await assert.rejects(f.manager.update(f.thread.id, { model: target }), /切り替え済み/)
})

test('a sandboxed dsh task stops rather than weakening permissions for Claude', async (t) => {
  let created = false
  const terminals = { create: async () => { created = true } }
  const f = await fixture(t, { usageFallbackRoutes: () => [{ model: 'claude:haiku', effort: 'low' }],
    handoffClaude: (options) => handoffThreadToClaude({ ...options, terminals }) })
  runtimeOptions(f)
  f.runtime.prompt = async () => { throw new Error('usage_limit_reached') }
  const refused = deferred()
  f.manager.on('turn', ({ turn }) => { if (turn.usageFallback?.status === 'failed') refused.resolve(turn) })
  await f.manager.send(f.thread.id, { text: 'work' }, { userInitiated: true })
  const failed = await refused.promise
  assert.match(failed.items.at(-1).text, /サンドボックス権限/)
  assert.equal(created, false)
  assert.equal(f.manager.threads.get(f.thread.id).fallbackTo, undefined)
})

test('cancel during fallback validation prevents model replacement and retry', async (t) => {
  const validating = deferred(), release = deferred()
  let accounts = 0
  const f = await fixture(t, { usageFallbackRoutes: routes, getAccounts: async () => {
    if (++accounts === 2) { validating.resolve(); await release.promise }
    return {}
  } })
  runtimeOptions(f)
  let count = 0
  f.runtime.prompt = async () => { count++; throw new Error('usage_limit_reached') }
  await f.manager.send(f.thread.id, { text: 'work' }, { userInitiated: true })
  await validating.promise
  await f.manager.cancel(f.thread.id)
  release.resolve()
  await f.manager.requests.get(f.thread.id)
  assert.equal(f.manager.threads.get(f.thread.id).model, f.thread.model)
  assert.equal(count, 1)
})
