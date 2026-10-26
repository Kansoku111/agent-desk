import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, deferred } from './helpers/thread-manager.js'
import { AcpRuntime } from '../server/runtime.js'
import { GOAL_WAIT_CONFIG, isGoalWaiting, setGoalWaiting, goalWaitDriverReady } from '../server/goal-wait.js'



test('controlled cancellation is acknowledged even if a lost steer acknowledgement left a stale cache', async () => {
  const runtime = new AcpRuntime({ mode: 'danger-full-access', paths: {} })
  const values = []
  runtime.conn = { cancel: async () => assert.fail('must not rely on a one-way cancel notification') }
  runtime.setOption = async (id, config, value) => { values.push(value); return [{ id: GOAL_WAIT_CONFIG, currentValue: value }] }
  await runtime.cancel('parent', true)
  assert.deepEqual(values, ['cancelled'])
})

test('cancellation while a parked leader prepares its next input still reaches the old session', async (t) => {
  const f = await fixture(t)
  f.manager.teamGoalWaiting = () => true
  f.runtime.setGoalWaiting = async () => {}
  await f.manager.send(f.thread.id, { text: 'initial delegation' })
  await f.started.promise
  const first = f.manager.active.get(f.thread.id)
  f.finish.resolve()
  await first.done
  const entered = deferred(), release = deferred()
  f.runtime.setGoalWaiting = async () => { entered.resolve(); await release.promise }
  await f.manager.send(f.thread.id, { text: 'next report' })
  await entered.promise
  const preparing = f.manager.active.get(f.thread.id)
  const cancel = t.mock.method(f.runtime, 'cancel')
  await f.manager.cancel(f.thread.id)
  assert.deepEqual(cancel.mock.calls[0].arguments, [f.manager.threads.get(f.thread.id).sessionId, true])
  release.resolve()
  await preparing.done
  assert.equal(f.calls.prompts.length, 1)
})

test('a stop guard is rechecked after account validation, before any model turn is committed', async (t) => {
  const f = await fixture(t)
  const entered = deferred(), release = deferred()
  let stopped = false
  f.manager.getAccounts = async () => { entered.resolve(); await release.promise; return {} }
  const sending = f.manager.send(f.thread.id, { text: 'old work' }, { guard: () => { if (stopped) throw new Error('stopped before admission') } })
  await entered.promise
  stopped = true
  release.resolve()
  await assert.rejects(sending, /stopped before admission/)
  assert.equal(f.calls.prompts.length, 0)
  assert.equal((await f.manager.get(f.thread.id)).turns.length, 0)
})

test('concurrent wait changes and cancellation are ordered per session', async () => {
  const runtime = new AcpRuntime({ mode: 'danger-full-access', paths: {} })
  const entered = deferred(), release = deferred(), calls = []
  runtime.conn = { cancel: async () => calls.push('notification') }
  runtime.setOption = async (id, config, value) => {
    calls.push(value)
    if (value === 'waiting') { entered.resolve(); await release.promise }
    return [{ id: GOAL_WAIT_CONFIG, currentValue: value }]
  }
  const waiting = runtime.setGoalWaiting('parent', true)
  await entered.promise
  const cancelled = runtime.cancel('parent')
  assert.deepEqual(calls, ['waiting'])
  release.resolve()
  await Promise.all([waiting, cancelled])
  assert.deepEqual(calls, ['waiting', 'cancelled'])
  assert.equal(runtime.goalWaitWrites.size, 0)
  assert.equal(runtime.waitingSessions.has('parent'), true)
  await runtime.setGoalWaiting('parent', false)
  assert.equal(runtime.waitingSessions.has('parent'), false)
})

test('a failed wait write does not poison later writes or block a sibling session', async () => {
  const runtime = new AcpRuntime({ mode: 'danger-full-access', paths: {} })
  const first = deferred(), entered = deferred()
  runtime.setOption = async (id, config, value) => {
    if (id === 'slow' && value === 'waiting') { entered.resolve(); await first.promise; throw new Error('connection failed') }
    return [{ id: GOAL_WAIT_CONFIG, currentValue: value }]
  }
  const failed = assert.rejects(runtime.setGoalWaiting('slow', true), /connection failed/)
  await entered.promise
  const next = runtime.setGoalWaiting('slow', false)
  await runtime.setGoalWaiting('sibling', true)
  assert.equal(runtime.waitingSessions.has('sibling'), true)
  first.resolve()
  await Promise.all([failed, next])
  assert.equal(runtime.waitingSessions.has('slow'), false)
  assert.equal(runtime.goalWaitWrites.size, 0)
})

test('a parked leader can be cancelled even when no parent turn is active', async (t) => {
  const f = await fixture(t)
  f.manager.teamGoalWaiting = () => true
  f.runtime.setGoalWaiting = async () => {}
  await f.manager.send(f.thread.id, { text: 'wait for child' })
  await f.started.promise
  const active = f.manager.active.get(f.thread.id)
  f.finish.resolve()
  await active.done
  const cancel = t.mock.method(f.runtime, 'cancel')
  await f.manager.cancel(f.thread.id)
  assert.deepEqual(cancel.mock.calls[0].arguments, [f.manager.threads.get(f.thread.id).sessionId, true])
  f.manager.teamGoalWaiting = () => undefined
  await f.manager.cancel(f.thread.id)
  assert.equal(cancel.mock.callCount(), 1, 'ordinary idle tasks are unaffected')
})

test('only a newly durable human message answers questions, not rejection, retry or internal reports', async (t) => {
  const f = await fixture(t)
  const accepted = []
  f.manager.userMessageAccepted = (id) => accepted.push(id)
  const human = { userInitiated: true }
  await assert.rejects(f.manager.send(f.thread.id, { text: '' }, human))
  const flush = t.mock.method(f.manager.indexWriter, 'flush', async () => { throw new Error('disk full') })
  await assert.rejects(f.manager.send(f.thread.id, { text: 'answer' }, human), /disk full/)
  flush.mock.restore()
  assert.deepEqual(accepted, [])
  const message = { text: 'answer', messageId: 'f1a2666d-7319-41d4-9825-c4c4863b4183' }
  await f.manager.send(f.thread.id, message, human)
  await f.started.promise
  assert.deepEqual(accepted, [f.thread.id])
  await f.manager.send(f.thread.id, message, human)
  await assert.rejects(f.manager.send(f.thread.id, { text: 'other answer' }, human), /まだ作業中/)
  assert.equal(accepted.length, 1)
  const active = f.manager.active.get(f.thread.id)
  f.finish.resolve()
  await active.done
  await f.manager.send(f.thread.id, { text: 'an internal child report' })
  assert.equal(accepted.length, 1)
})

test('human steering applies answered-question scheduling atomically and ignores rejected/retried deliveries', async (t) => {
  const f = await fixture(t)
  f.manager.teamGoalWaiting = (thread, { userInput = false } = {}) => !userInput
  f.runtime.setGoalWaiting = async () => {}
  const accepted = [], gates = []
  f.manager.userMessageAccepted = (id) => accepted.push(id)
  f.runtime.steer = async (id, blocks, waiting) => { gates.push(waiting); return true }
  await f.manager.send(f.thread.id, { text: 'work' })
  await f.started.promise
  const message = { text: 'the human answer', messageId: '39ef8ef6-42e7-43ad-8217-aa15c4ac4da1' }
  await f.manager.steer(f.thread.id, message, { userInitiated: true })
  assert.deepEqual(gates, [false])
  assert.deepEqual(accepted, [f.thread.id])
  await f.manager.steer(f.thread.id, message, { userInitiated: true })
  assert.equal(gates.length, 1)
  f.runtime.steer = async () => false
  assert.equal((await f.manager.steer(f.thread.id, { text: 'not taken' }, { userInitiated: true })).steered, false)
  f.runtime.steer = async () => { throw new Error('transport closed') }
  assert.equal((await f.manager.steer(f.thread.id, { text: 'uncertain', messageId: 'b3eed349-9e75-4435-a7cb-ab8bcd5a713d' }, { userInitiated: true })).status, 'uncertain')
  assert.equal(accepted.length, 1)
})

test('goal scheduling gate is exact-agent scoped and leaves the goal service untouched', () => {
  goalWaitDriverReady()
  const agent = {}, other = {}
  const record = { agent, assertActive() {} }
  assert.equal(setGoalWaiting(record, 'waiting')[0].currentValue, 'waiting')
  assert.equal(isGoalWaiting(agent), true)
  assert.equal(isGoalWaiting(other), false)
  assert.throws(() => setGoalWaiting(record, 'paused'), /unknown/)
  assert.equal(setGoalWaiting(record, 'ready')[0].currentValue, 'ready')
  assert.equal(isGoalWaiting(agent), false)
})

test('missing driver support or missing acknowledgement fails closed', async () => {
  const fresh = await import('../server/goal-wait.js?unpatched-driver-fixture')
  assert.throws(() => fresh.setGoalWaiting({ agent: {}, assertActive() {} }, 'waiting'), /unavailable/)
  const runtime = new AcpRuntime({ mode: 'danger-full-access', paths: {}, onUpdate() {}, onPermission() {} })
  runtime.setOption = async () => []
  await assert.rejects(runtime.setGoalWaiting('session', true), /not applied/)
  const calls = []
  runtime.setOption = async (...args) => {
    calls.push(args)
    return [{ id: GOAL_WAIT_CONFIG, currentValue: 'waiting' }]
  }
  await runtime.setGoalWaiting('session', true)
  assert.deepEqual(calls, [['session', GOAL_WAIT_CONFIG, 'waiting']])
})

test('parent scheduling is recomputed before every explicit prompt and can change during delegation', async (t) => {
  const f = await fixture(t)
  let waiting = true
  const gates = []
  f.manager.teamGoalWaiting = () => waiting
  f.runtime.setGoalWaiting = async (id, value) => gates.push([id, value])
  await f.manager.send(f.thread.id, { text: 'delegate work' })
  await f.started.promise
  assert.deepEqual(gates, [[f.manager.threads.get(f.thread.id).sessionId, true]])
  waiting = false
  await f.manager.setGoalWaiting(f.thread.id, false)
  f.finish.resolve()
  await f.manager.active.get(f.thread.id).done
  await f.manager.send(f.thread.id, { text: 'the child report' })
  await f.manager.active.get(f.thread.id).done
  assert.deepEqual(gates.map((entry) => entry[1]), [true, false, false])
  assert.equal(f.calls.prompts.length, 2)
})

test('ordinary tasks never call the eco scheduling option', async (t) => {
  const f = await fixture(t)
  f.runtime.setGoalWaiting = async () => { throw new Error('must not affect ordinary tasks') }
  await f.manager.send(f.thread.id, { text: 'ordinary task' })
  await f.started.promise
  assert.equal(f.calls.prompts.length, 1)
})

test('an unapplied wait cannot start an expensive parent prompt', async (t) => {
  const f = await fixture(t)
  f.manager.teamGoalWaiting = () => true
  f.runtime.setGoalWaiting = async () => { throw new Error('goal wait unavailable') }
  await f.manager.send(f.thread.id, { text: 'eco work' })
  await f.manager.active.get(f.thread.id).done
  assert.equal(f.calls.prompts.length, 0)
  const view = await f.manager.get(f.thread.id)
  assert.equal(view.turns[0].status, 'error')
  assert.match(view.turns[0].error.message, /goal wait unavailable/)
})

test('cancellation during wait setup does not admit the parent model prompt', async (t) => {
  const f = await fixture(t)
  const entered = deferred(), ready = deferred()
  f.manager.teamGoalWaiting = () => true
  f.runtime.setGoalWaiting = async () => { entered.resolve(); await ready.promise }
  await f.manager.send(f.thread.id, { text: 'eco work' })
  await entered.promise
  const stopped = f.manager.cancel(f.thread.id)
  ready.resolve()
  await stopped
  assert.equal(f.calls.prompts.length, 0)
})
