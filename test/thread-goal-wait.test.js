import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, deferred } from './helpers/thread-manager.js'
import { AcpRuntime } from '../server/runtime.js'
import { GOAL_WAIT_CONFIG, isGoalWaiting, setGoalWaiting, goalWaitDriverReady } from '../server/goal-wait.js'

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
