import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { deferred, fixture, pending, tick } from './helpers/thread-manager.js'

test('remove waits for startup completion and cannot resurrect a deleted thread', async (t) => {
  const f = await fixture(t)
  const startup = deferred()
  f.pool.get = () => startup.promise
  await f.manager.send(f.thread.id, { text: 'hello' })
  const active = f.manager.active.get(f.thread.id)
  assert.ok(active.done instanceof Promise)
  const removal = f.manager.remove(f.thread.id)
  await pending(removal)
  assert.equal(active.cancelled, true)
  startup.resolve(f.runtime)
  await removal
  await active.done
  assert.equal(f.calls.sessions, 0)
  assert.equal(f.calls.prompts.length, 0)
  assert.deepEqual(f.manager.list(), [])
  const events = []
  f.manager.on('thread', (event) => events.push(event))
  f.manager.on('turn', (event) => events.push(event))
  await f.manager.shutdown()
  await tick()
  assert.deepEqual(events, [])
  await assert.rejects(fs.access(f.turnFile), { code: 'ENOENT' })
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8')).threads, [])
})

test('remove closes a session whose creation was already in flight', async (t) => {
  const f = await fixture(t)
  const creating = deferred()
  const release = deferred()
  f.runtime.newSession = async () => {
    creating.resolve()
    await release.promise
    f.runtime.liveSessions.add('late-session')
    return { sessionId: 'late-session', configOptions: [] }
  }
  await f.manager.send(f.thread.id, { text: 'hello' })
  await creating.promise
  const removal = f.manager.remove(f.thread.id)
  await pending(removal)
  release.resolve()
  await removal
  assert.deepEqual(f.calls.closed, ['late-session'])
  assert.equal(f.calls.prompts.length, 0)
  assert.equal(f.manager.sessionIndex.size, 0)
  await assert.rejects(fs.access(f.turnFile), { code: 'ENOENT' })
})

test('removal fences a send waiting for account validation', async (t) => {
  const validating = deferred()
  const release = deferred()
  const f = await fixture(t, { getAccounts: async () => { validating.resolve(); return release.promise } })
  const sending = f.manager.send(f.thread.id, { text: 'hello' })
  const rejected = assert.rejects(sending, /削除/)
  await validating.promise
  const removal = f.manager.remove(f.thread.id)
  await pending(removal)
  release.resolve({})
  await rejected
  await removal
  assert.equal(f.calls.sessions, 0)
  assert.equal(f.calls.prompts.length, 0)
  assert.equal(f.manager.busy, false)
})

test('cancellation during attachment loading is rechecked before prompt', async (t) => {
  const f = await fixture(t)
  const reading = deferred()
  const release = deferred()
  const original = fs.readFile
  const image = path.join(f.paths.attachmentsDir, 'abcdef.png')
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file !== image) return original(file, ...args)
    reading.resolve()
    return release.promise
  })
  await f.manager.send(f.thread.id, { text: '', images: [{ file: 'abcdef.png', mimeType: 'image/png' }] })
  const active = f.manager.active.get(f.thread.id)
  await reading.promise
  await f.manager.cancel(f.thread.id)
  await pending(active.done)
  release.resolve(Buffer.from('fake picture'))
  await active.done
  assert.equal(f.calls.prompts.length, 0)
  assert.equal((await f.manager.get(f.thread.id)).turns[0].status, 'cancelled')
})

test('cancellation while configuring the session is checked before model execution', async (t) => {
  const f = await fixture(t)
  const configuring = deferred()
  const release = deferred()
  f.runtime.setOption = async () => { configuring.resolve(); await release.promise; return [] }
  await f.manager.send(f.thread.id, { text: 'hello' })
  await configuring.promise
  const active = f.manager.active.get(f.thread.id)
  await f.manager.cancel(f.thread.id)
  await pending(active.done)
  release.resolve()
  await active.done
  assert.equal(f.calls.prompts.length, 0)
  assert.equal((await f.manager.get(f.thread.id)).turns[0].status, 'cancelled')
})

test('shutdown waits for startup and persists the cancelled outcome before returning', async (t) => {
  const f = await fixture(t)
  const startup = deferred()
  f.pool.get = () => startup.promise
  await f.manager.send(f.thread.id, { text: 'hello' })
  const shutdown = f.manager.shutdown()
  await pending(shutdown)
  await assert.rejects(f.manager.send(f.thread.id, { text: 'too late' }), /終了/)
  startup.resolve(f.runtime)
  await shutdown
  assert.equal(f.calls.sessions, 0)
  assert.equal(f.manager.busy, false)
  assert.equal((await f.disk()).turns[0].status, 'cancelled')
})

test('checkpoint after, changes and tidy complete before idle and the next turn', async (t) => {
  const afterStarted = deferred()
  const after = deferred()
  const tidyStarted = deferred()
  const tidy = deferred()
  const f = await fixture(t, { checkpoints: {
    async snapshot(_workspace, label) {
      if (label.endsWith('/after')) { afterStarted.resolve(); await after.promise }
      return { commit: label.endsWith('/after') ? 'after' : 'before' }
    },
    async changes() { return [{}] },
    async tidy() { tidyStarted.resolve(); await tidy.promise },
    async forget() {},
  } })
  await f.manager.send(f.thread.id, { text: 'edit' })
  await f.started.promise
  const active = f.manager.active.get(f.thread.id)
  let idle = 0
  f.manager.on('thread', (thread) => { if (thread.status === 'idle') idle++ })
  f.finish.resolve()
  await afterStarted.promise
  await pending(active.done)
  assert.equal(f.manager.busy, true)
  assert.equal(idle, 0)
  await assert.rejects(f.manager.send(f.thread.id, { text: 'next' }), /まだ作業中/)
  after.resolve()
  await tidyStarted.promise
  await pending(active.done)
  assert.equal(idle, 0)
  tidy.resolve()
  await active.done
  assert.equal(idle, 1)
  assert.equal(f.manager.busy, false)
  const turn = (await f.manager.get(f.thread.id)).turns[0]
  assert.equal(turn.status, 'done')
  assert.equal(turn.checkpoint.changed, 1)
  await f.manager.send(f.thread.id, { text: 'next' })
})

test('remove waits for after-checkpoint cleanup before forgetting snapshots', async (t) => {
  const afterStarted = deferred()
  const after = deferred()
  const order = []
  const f = await fixture(t, { checkpoints: {
    async snapshot(_workspace, label) {
      if (label.endsWith('/after')) { afterStarted.resolve(); await after.promise; order.push('after') }
      return { commit: label }
    },
    async changes() { order.push('changes'); return [] },
    async tidy() { order.push('tidy') },
    async forget() { order.push('forget') },
  } })
  await f.manager.send(f.thread.id, { text: 'edit' })
  await f.started.promise
  f.finish.resolve()
  await afterStarted.promise
  const removal = f.manager.remove(f.thread.id)
  await pending(removal)
  assert.deepEqual(order, [])
  after.resolve()
  await removal
  assert.deepEqual(order, ['after', 'changes', 'tidy', 'forget'])
  await assert.rejects(fs.access(f.turnFile), { code: 'ENOENT' })
})

test('a follow-up sent directly by the idle listener starts only after checkpoint after', async (t) => {
  const order = []
  const f = await fixture(t, { checkpoints: {
    async snapshot(_workspace, label) { order.push(label.endsWith('/after') ? 'after' : 'before'); return { commit: label } },
    async changes() { return [] },
    async tidy() { order.push('tidy') },
    async forget() {},
  } })
  let next
  const queued = deferred()
  f.manager.on('thread', (thread) => {
    if (thread.status === 'idle' && !next) {
      order.push('idle')
      next = f.manager.send(thread.id, { text: 'next' })
      queued.resolve()
    }
  })
  await f.manager.send(f.thread.id, { text: 'first' })
  await f.started.promise
  f.finish.resolve()
  await queued.promise
  await next
  const active = f.manager.active.get(f.thread.id)
  await active?.done
  assert.deepEqual(order.slice(0, 5), ['before', 'after', 'tidy', 'idle', 'before'])
  assert.equal(f.calls.prompts.length, 2)
})

test('shutdown includes usage collection rather than letting it rewrite after exit', async (t) => {
  const reading = deferred()
  const release = deferred()
  const f = await fixture(t, { getTurnUsage: async () => { reading.resolve(); return release.promise } })
  await f.manager.send(f.thread.id, { text: 'hello' })
  await f.started.promise
  f.finish.resolve()
  await reading.promise
  const shutdown = f.manager.shutdown()
  await pending(shutdown)
  assert.equal(f.manager.busy, true)
  release.resolve({ requests: 1, input: 10, output: 20 })
  await shutdown
  assert.equal((await f.disk()).turns[0].status, 'done')
  assert.deepEqual((await f.disk()).turns[0].usage, { requests: 1, input: 10, output: 20 })
})
