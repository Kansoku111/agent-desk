import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import { createThreadHandlers } from '../server/rpc-handlers-threads.js'
import { beginCreateIntent, completeCreateIntent, createIntentFingerprint } from '../web/src/create-intent.ts'
import { deferred, fixture } from './helpers/thread-manager.js'

class MemoryStorage {
  values = new Map()
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}

function handlersFor(f, threads = f.manager) {
  const settings = { workspaces: [], lastWorkspace: null }
  return createThreadHandlers({
    paths: { ...f.paths, myPc: f.base },
    threads,
    teams: { userWrote() {} },
    subagents: { list: async () => [] },
    mutateSettings: async (change) => change(settings),
  })
}

function createInput(f, createId, patch = {}) {
  return { workspace: f.base, model: '["test","model"]', toolMode: 'native', text: 'hello', images: [], createId, ...patch }
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NEXT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const THIRD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

test('a pending create reuses its key, then a completed identical intent gets a new key', () => {
  const storage = new MemoryStorage()
  const ids = [ID, NEXT_ID]
  const fingerprint = createIntentFingerprint({ text: 'same' })
  const first = beginCreateIntent(fingerprint, storage, () => ids.shift())
  const retry = beginCreateIntent(fingerprint, storage, () => ids.shift())
  assert.equal(retry.id, first.id)
  completeCreateIntent(first.id, storage)
  const nextIntent = beginCreateIntent(fingerprint, storage, () => ids.shift())
  assert.equal(nextIntent.id, NEXT_ID)
})

test('thread.create defaults to PTC and treats an explicit PTC retry as the same request', async (t) => {
  const f = await fixture(t)
  f.runtime.newSession = async () => {
    f.runtime.liveSessions.add('ptc-session')
    return { sessionId: 'ptc-session', configOptions: [{ id: 'agent_desk_tool_mode', currentValue: 'ptc' }] }
  }
  const handlers = handlersFor(f)
  const input = createInput(f, ID, { toolMode: undefined })
  const first = await handlers['thread.create'](input)
  await f.started.promise
  const retry = await handlers['thread.create']({ ...input, toolMode: 'ptc' })
  assert.equal(first.thread.toolMode, 'ptc')
  assert.equal(retry.thread.id, first.thread.id)
  assert.equal(f.calls.prompts.length, 1)
  await assert.rejects(handlers['thread.create']({ ...input, toolMode: 'native' }), /同じ初回作成キーに異なる内容/)
})

test('same-key concurrent thread.create handlers share one durable thread and first turn', async (t) => {
  const f = await fixture(t)
  const handlers = handlersFor(f)
  const input = createInput(f, ID)
  const [first, duplicate] = await Promise.all([handlers['thread.create'](input), handlers['thread.create'](input)])
  await f.started.promise
  assert.equal(first.thread.id, duplicate.thread.id)
  assert.equal(f.manager.threads.size, 2)
  assert.equal(f.calls.prompts.length, 1)
  const index = JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8'))
  assert.equal(index.version, 1)
  assert.equal(index.threads.length, 2)
  assert.deepEqual(Object.keys(index.createReceipts[0]).sort(), ['createId', 'deleted', 'payloadHash', 'threadId'])
  assert.equal(index.createReceipts[0].createId, ID)
  assert.equal(index.createReceipts[0].threadId, first.thread.id)
  assert.equal(index.createReceipts[0].deleted, false)
  assert.match(index.createReceipts[0].payloadHash, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(index.createReceipts).includes('hello'), false)
})

test('same-key retry after server restart reuses the accepted receipt', async (t) => {
  const f = await fixture(t)
  const input = createInput(f, ID)
  const first = await handlersFor(f)['thread.create'](input)
  await f.started.promise
  f.finish.resolve()
  await f.manager.shutdown()

  const restarted = f.makeManager()
  await restarted.load()
  const retry = await handlersFor(f, restarted)['thread.create'](input)
  assert.equal(retry.thread.id, first.thread.id)
  assert.equal((await restarted.get(first.thread.id)).turns.length, 1)
  assert.equal(f.calls.prompts.length, 1)
})

test('the same key with different input is rejected; a different key can intentionally repeat text', async (t) => {
  const f = await fixture(t)
  const handlers = handlersFor(f)
  const first = await handlers['thread.create'](createInput(f, ID))
  await f.started.promise
  await assert.rejects(handlers['thread.create'](createInput(f, ID, { text: 'changed' })), /同じ初回作成キーに異なる内容/)
  const intentional = await handlers['thread.create'](createInput(f, NEXT_ID))
  await waitFor(() => f.calls.prompts.length === 2)
  assert.notEqual(intentional.thread.id, first.thread.id)
  assert.equal((await f.manager.get(first.thread.id)).turns[0].user.text, 'hello')
  assert.equal((await f.manager.get(intentional.thread.id)).turns[0].user.text, 'hello')
  assert.equal(f.calls.prompts.length, 2)
})

test('a persisted-index failure rolls back before admission and the same key can retry', async (t) => {
  const f = await fixture(t)
  const writer = f.manager.indexWriter
  const flush = writer.flush.bind(writer)
  let fail = true
  writer.flush = async () => {
    if (fail) { fail = false; throw new Error('simulated index write failure') }
    return flush()
  }
  const handlers = handlersFor(f)
  const input = createInput(f, ID)
  await assert.rejects(handlers['thread.create'](input), /simulated index write failure/)
  assert.equal(f.manager.threads.size, 1)
  assert.equal(f.manager.createReceipts.size, 0)
  assert.equal(f.calls.prompts.length, 0)
  const retried = await handlers['thread.create'](input)
  await f.started.promise
  assert.ok(retried.thread.id)
  assert.equal(f.manager.threads.size, 2)
  assert.equal(f.calls.prompts.length, 1)
})

test('a failed send is cleaned up only after receipt status says missing', async (t) => {
  const f = await fixture(t)
  const manager = f.manager
  const send = manager.send.bind(manager)
  let fail = true
  manager.send = async (...args) => {
    if (fail) { fail = false; throw new Error('before admission') }
    return send(...args)
  }
  const handlers = handlersFor(f)
  const input = createInput(f, ID)
  await assert.rejects(handlers['thread.create'](input), /before admission/)
  assert.equal(manager.threads.size, 1)
  assert.equal(manager.createReceipts.size, 0)
  const retry = await handlers['thread.create'](input)
  await f.started.promise
  assert.equal(manager.threads.size, 2)
  assert.ok(retry.thread.id)
  assert.equal(f.calls.prompts.length, 1)
})

test('an unreadable receipt preserves the key and reservation; retry never mints another key', async (t) => {
  const f = await fixture(t)
  const manager = f.manager
  const send = manager.send.bind(manager)
  const status = manager.messageStatus.bind(manager)
  let fail = true
  manager.send = async (...args) => {
    if (fail) { fail = false; throw new Error('send outcome unavailable') }
    return send(...args)
  }
  manager.messageStatus = async () => { throw new Error('receipt store unavailable') }
  const handlers = handlersFor(f)
  const input = createInput(f, ID)
  await assert.rejects(handlers['thread.create'](input), /send outcome unavailable/)
  assert.equal(manager.threads.size, 2)
  assert.equal(manager.createReceipts.get(ID).deleted, false)
  manager.messageStatus = status
  const retried = await handlers['thread.create'](input)
  await f.started.promise
  assert.equal(retried.thread.id, manager.createReceipts.get(ID).threadId)
  assert.equal(f.calls.prompts.length, 1)
})

test('manual removal keeps a tombstone and an old create key cannot resurrect the task', async (t) => {
  const f = await fixture(t)
  const handlers = handlersFor(f)
  const input = createInput(f, ID)
  const created = await handlers['thread.create'](input)
  await f.started.promise
  const active = f.manager.active.get(created.thread.id)
  f.finish.resolve()
  await active?.done
  const writer = f.manager.indexWriter
  const flush = writer.flush.bind(writer)
  let failRemovalCommit = true
  writer.flush = async () => {
    if (failRemovalCommit) { failRemovalCommit = false; throw new Error('simulated removal index failure') }
    return flush()
  }
  await assert.rejects(f.manager.remove(created.thread.id), /simulated removal index failure/)
  assert.equal(f.manager.threads.has(created.thread.id), true)
  assert.equal(f.manager.createReceipts.get(ID).deleted, false)
  await f.manager.remove(created.thread.id)
  await assert.rejects(handlers['thread.create'](input), /作成済みタスクは削除済みです/)
  assert.equal(f.manager.threads.size, 1)
  assert.equal(f.manager.createReceipts.get(ID).deleted, true)
  assert.equal(f.calls.prompts.length, 1)
})

test('legacy thread.create without a key keeps its existing behavior', async (t) => {
  const f = await fixture(t)
  const result = await handlersFor(f)['thread.create'](createInput(f, undefined))
  await f.started.promise
  const index = JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8'))
  assert.equal(result.thread.id, f.manager.threads.get(result.thread.id).id)
  assert.equal(index.version, 1)
  assert.equal('createReceipts' in index, false)
  assert.equal(f.calls.prompts.length, 1)
})

test('thread.create returns the latest summary after delayed settings save on both request paths', async (t) => {
  for (const createId of [ID, undefined]) {
    const f = await fixture(t)
    const settingsStarted = deferred()
    const releaseSettings = deferred()
    const settings = { workspaces: [], lastWorkspace: null }
    const handlers = createThreadHandlers({
      paths: { ...f.paths, myPc: f.base },
      threads: f.manager,
      teams: { userWrote() {} },
      subagents: { list: async () => [] },
      mutateSettings: async (change) => {
        settingsStarted.resolve()
        await releaseSettings.promise
        change(settings)
      },
    })
    const request = handlers['thread.create'](createInput(f, createId))
    await settingsStarted.promise
    await f.started.promise
    const task = [...f.manager.threads.values()].find((thread) => thread.id !== f.thread.id)
    const active = f.manager.active.get(task.id)
    f.finish.resolve()
    await active?.done
    const latest = f.manager.summary(f.manager.threads.get(task.id))
    assert.notEqual(latest.status, 'running')
    releaseSettings.resolve()
    const response = await request
    assert.equal(response.thread.status, latest.status)
    // A task that still exists keeps the unchanged response shape.
    assert.equal('removed' in response, false)
  }
})

test('a task deleted while its settings are saved returns the accepted summary, not a TypeError', async (t) => {
  const f = await fixture(t)
  const settings = { workspaces: [], lastWorkspace: null }
  let deletedId
  const handlers = createThreadHandlers({
    paths: { ...f.paths, myPc: f.base },
    threads: f.manager,
    teams: { userWrote() {} },
    subagents: { list: async () => [] },
    mutateSettings: async (change) => {
      // Another client removes the task while the settings save is still running.
      deletedId = [...f.manager.threads.values()].at(-1).id
      await f.manager.remove(deletedId)
      change(settings)
    },
  })
  const input = createInput(f, ID)
  const result = await handlers['thread.create'](input)
  assert.equal(result.thread.id, deletedId)
  // The UI must not show a task the server no longer has.
  assert.equal(result.removed, true)
  assert.equal(f.manager.threads.has(deletedId), false)
  assert.equal(f.manager.list().length, 1)
  assert.equal(f.manager.threads.size, 1)
  // The tombstone stands: an old retry neither recreates nor resends the task.
  await assert.rejects(handlers['thread.create'](input), /作成済みタスクは削除済みです/)
  assert.equal(f.manager.threads.size, 1)
})

test('storage failures before sending fail closed', () => {
  const storage = { getItem: () => null, setItem() { throw new Error('quota') }, removeItem() {} }
  assert.throws(() => beginCreateIntent('fingerprint', storage, () => THIRD_ID), /quota/)
})
