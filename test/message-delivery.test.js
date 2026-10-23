import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Outbox, readQueues } from '../web/src/outbox.ts'
import { TransportError } from '../web/src/rpc-client.ts'
import { fixture } from './helpers/thread-manager.js'

const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
function outboxFor(manager, initial = {}, requestOverride) {
  let saved = JSON.stringify(initial)
  const request = (type, params) => {
    if (type === 'thread.messageStatus') return manager.messageStatus(params.threadId, params.messageId)
    if (type === 'thread.send') return manager.send(params.threadId, params)
    if (type === 'thread.steer') return manager.steer(params.threadId, params)
    throw new Error(`unexpected method: ${type}`)
  }
  const outbox = new Outbox({
    initial,
    newId: () => ID,
    persist: (queues) => { saved = JSON.stringify(queues) },
    changed: () => {},
    request: (type, params) => requestOverride ? requestOverride(type, params, request) : request(type, params),
    thread: (id) => manager.threads.get(id),
    ready: () => true,
    report: () => {},
  })
  return { outbox, saved: () => saved }
}

test('browser reload plus server restart reconciles a real durable send receipt', async (t) => {
  const f = await fixture(t)
  const first = outboxFor(f.manager, {}, async (type, params, request) => {
    await request(type, params)
    throw new TransportError('response dropped after server accepted')
  })
  first.outbox.enqueue(f.thread.id, 'only once', [])
  await first.outbox.flush(f.thread.id)
  await f.started.promise
  assert.equal(readQueues(first.saved())[f.thread.id][0].phase, 'sending')
  f.finish.resolve()
  await f.manager.shutdown()
  const restarted = f.makeManager()
  await restarted.load()
  const reloaded = outboxFor(restarted, readQueues(first.saved()))
  await reloaded.outbox.flush(f.thread.id)
  assert.deepEqual(reloaded.outbox.snapshot(), {})
  assert.equal(f.calls.prompts.length, 1)
  assert.equal((await restarted.get(f.thread.id)).turns.length, 1)
})

test('the outbox respects an uncertain durable steering receipt across APIs', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'initial task' })
  await f.started.promise
  f.runtime.steer = async () => { f.calls.steers.push('accepted?'); throw new Error('connection ended without reply') }
  const sender = outboxFor(f.manager)
  sender.outbox.enqueue(f.thread.id, 'do not replay', [])
  await sender.outbox.steer(f.thread.id, ID)
  assert.equal(sender.outbox.snapshot()[f.thread.id][0].phase, 'uncertain')
  f.finish.resolve()
  await f.manager.shutdown()
  const restarted = f.makeManager()
  await restarted.load()
  const reloaded = outboxFor(restarted, readQueues(sender.saved()))
  await reloaded.outbox.flush(f.thread.id)
  await reloaded.outbox.retry(f.thread.id, ID)
  assert.equal(reloaded.outbox.snapshot()[f.thread.id][0].phase, 'uncertain')
  assert.equal(f.calls.steers.length, 1)
  assert.equal(f.calls.prompts.length, 1)
})
