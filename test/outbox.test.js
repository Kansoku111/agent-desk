import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Outbox, readQueues } from '../web/src/outbox.ts'
import { RequestError, TransportError } from '../web/src/rpc-client.ts'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NEXT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(options = {}) {
  const state = { status: 'idle', ready: true, saved: '{}', reports: [], calls: [], ids: [ID, NEXT_ID] }
  const outbox = new Outbox({
    initial: options.initial ?? {},
    persist: (queues) => { state.saved = JSON.stringify(queues) },
    changed: () => {},
    thread: () => ({ status: state.status }),
    ready: () => state.ready,
    report: (message) => state.reports.push(message),
    newId: () => state.ids.shift(),
    request: async (type, params) => {
      state.calls.push({ type, ...params })
      if (type === 'thread.messageStatus') return { status: 'missing' }
      state.status = 'running'
      return { status: 'accepted', turnId: 'turn', kind: 'send' }
    },
    ...options,
  })
  return { outbox, state }
}

test('a follow-up stays durably in the queue until its acknowledgement', async () => {
  const reply = deferred()
  const called = deferred()
  const { outbox, state } = fixture({ request: () => { called.resolve(); return reply.promise } })
  outbox.enqueue('task', 'hello', [])
  const sending = outbox.flush('task')
  await called.promise
  assert.equal(JSON.parse(state.saved).task[0].phase, 'sending')
  assert.equal(JSON.parse(state.saved).task[0].id, ID)
  assert.equal(outbox.remove('task', ID), false)
  reply.resolve({ turnId: 'turn', status: 'accepted' })
  await sending
  assert.deepEqual(outbox.snapshot(), {})
  assert.equal(state.saved, '{}')
})

test('reload after a lost acknowledgement reconciles the ID without executing twice', async () => {
  let executions = 0
  const first = fixture({ request: async () => { executions++; throw new TransportError('lost ack') } })
  first.outbox.enqueue('task', 'hello', [])
  await first.outbox.flush('task')
  const initial = readQueues(first.state.saved)
  assert.equal(initial.task[0].phase, 'sending')
  const second = fixture({ initial, request: async (type, params) => {
    assert.equal(type, 'thread.messageStatus')
    assert.equal(params.messageId, ID)
    return { status: 'accepted', kind: 'send', turnId: 'turn' }
  } })
  second.state.status = 'running'
  await second.outbox.flush('task')
  assert.equal(executions, 1)
  assert.deepEqual(second.outbox.snapshot(), {})
})

test('a never-received request retries with the same stable ID after reconnect', async () => {
  const first = fixture({ request: async () => { throw new TransportError('offline') } })
  first.outbox.enqueue('task', 'hello', [])
  await first.outbox.flush('task')
  const second = fixture({ initial: readQueues(first.state.saved) })
  await second.outbox.flush('task')
  assert.deepEqual(second.state.calls.map((call) => call.type), ['thread.messageStatus', 'thread.send'])
  assert.ok(second.state.calls.every((call) => call.messageId === ID))
  assert.deepEqual(second.outbox.snapshot(), {})
})

test('unknown steering stays visible and is never automatically resent', async () => {
  const calls = []
  const { outbox, state } = fixture({ request: async (type) => {
    calls.push(type)
    return { status: 'uncertain' }
  } })
  state.status = 'running'
  outbox.enqueue('task', 'hello', [])
  await outbox.steer('task', ID)
  assert.equal(outbox.snapshot().task[0].phase, 'uncertain')
  state.status = 'idle'
  await outbox.flush('task')
  await outbox.retry('task', ID)
  assert.equal(calls.filter((type) => type === 'thread.steer').length, 1)
  assert.equal(calls.filter((type) => type === 'thread.send').length, 0)
  assert.equal(outbox.snapshot().task[0].phase, 'uncertain')
})

test('steering refused before admission keeps the message and its place', async () => {
  const { outbox, state } = fixture({ request: async () => ({ steered: false }) })
  state.status = 'running'
  outbox.enqueue('task', 'first', [])
  outbox.enqueue('task', 'second', [])
  await outbox.steer('task', NEXT_ID)
  assert.deepEqual(outbox.snapshot().task.map((entry) => [entry.id, entry.phase]), [[ID, 'queued'], [NEXT_ID, 'queued']])
})

test('server rejection is held for explicit retry rather than retried in a loop', async () => {
  let fail = true
  const ids = []
  const { outbox } = fixture({ request: async (type, params) => {
    if (type === 'thread.messageStatus') return { status: 'missing' }
    ids.push(params.messageId)
    if (fail) throw new RequestError('sign in first')
    return { turnId: 'turn', status: 'accepted' }
  } })
  outbox.enqueue('task', 'hello', [])
  await outbox.flush('task')
  assert.equal(outbox.snapshot().task[0].phase, 'failed')
  await outbox.flush('task')
  assert.equal(ids.length, 1)
  fail = false
  await outbox.retry('task', ID)
  assert.deepEqual(ids, [ID, ID])
  assert.deepEqual(outbox.snapshot(), {})
})

test('steering rejection after admission checks the durable receipt', async () => {
  const { outbox, state } = fixture({ request: async (type) => {
    if (type === 'thread.messageStatus') return { status: 'uncertain' }
    throw new RequestError('could not save acknowledgement')
  } })
  state.status = 'running'
  outbox.enqueue('task', 'hello', [])
  await outbox.steer('task', ID)
  assert.equal(outbox.snapshot().task[0].phase, 'uncertain')
})

test('queues do not send while disconnected or running', async () => {
  const { outbox, state } = fixture()
  outbox.enqueue('task', 'hello', [])
  state.ready = false
  await outbox.flush('task')
  state.ready = true
  state.status = 'running'
  await outbox.flush('task')
  assert.equal(state.calls.length, 0)
  state.status = 'idle'
  await outbox.flush('task')
  assert.equal(state.calls.length, 1)
})

test('storage failure leaves the composer responsible for the unsaved text', () => {
  const { outbox } = fixture({ persist: () => { throw new Error('quota') } })
  assert.throws(() => outbox.enqueue('task', 'hello', []), /quota/)
  assert.deepEqual(outbox.snapshot(), {})
})

test('failure to persist sending state prevents any network side effect', async () => {
  let writes = 0
  const { outbox, state } = fixture({ persist: () => { if (++writes > 1) throw new Error('quota') } })
  outbox.enqueue('task', 'hello', [])
  await outbox.flush('task')
  assert.equal(state.calls.length, 0)
  assert.equal(outbox.snapshot().task[0].phase, 'queued')
})

test('legacy queues get IDs and malformed storage is ignored safely', () => {
  const migrated = readQueues(JSON.stringify({ task: [{ text: 'old', images: [] }] }), () => ID)
  assert.deepEqual(migrated.task[0], { id: ID, text: 'old', images: [], phase: 'queued' })
  assert.deepEqual(readQueues('{broken'), {})
  assert.deepEqual(readQueues('[]'), {})
  assert.deepEqual(readQueues('{"__proto__":[{"text":"x","images":[]}]}'), {})
  assert.deepEqual(readQueues('{"task":[{"text":5,"images":[]}]}'), {})
})

test('concurrent flushes serialize one task and a fast completed turn drains the next message', async () => {
  const calls = []
  let outbox
  ;({ outbox } = fixture({ request: async (_type, params) => {
    calls.push(params.messageId)
    void outbox.flush('task')
    return { turnId: params.messageId, status: 'accepted' }
  } }))
  outbox.enqueue('task', 'one', [])
  outbox.enqueue('task', 'two', [])
  await Promise.all([outbox.flush('task'), outbox.flush('task')])
  assert.deepEqual(calls, [ID, NEXT_ID])
})

test('a late acknowledgement cannot restore a deleted task queue', async () => {
  const reply = deferred()
  const started = deferred()
  const { outbox } = fixture({ request: () => { started.resolve(); return reply.promise } })
  outbox.enqueue('task', 'hello', [])
  const sending = outbox.flush('task')
  await started.promise
  outbox.forget('task')
  reply.resolve({ turnId: 'turn' })
  await sending
  assert.deepEqual(outbox.snapshot(), {})
})
