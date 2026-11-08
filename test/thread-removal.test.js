import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { deferred, fixture } from './helpers/thread-manager.js'

async function savedThread(t, options) {
  const f = await fixture(t, options)
  await f.manager.send(f.thread.id, { text: 'keep this transcript until deletion commits' })
  await f.started.promise
  const active = f.manager.active.get(f.thread.id)
  f.finish.resolve()
  await active.done
  await f.manager.turnWriters.get(f.thread.id).flush()
  await f.manager.indexWriter.flush()
  return f
}

test('committed removal does not wait for optional checkpoint garbage collection', async (t) => {
  const f = await savedThread(t)
  const cleanup = deferred()
  const calls = []
  f.manager.checkpoints = { forget: (...args) => { calls.push(args); return cleanup.promise } }
  try {
    const removal = f.manager.remove(f.thread.id)
    assert.notEqual(await Promise.race([removal.then(() => 'removed'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 1000))]), 'blocked')
    assert.deepEqual(f.manager.list(), [])
    assert.deepEqual(calls, [[f.thread.workspace, f.thread.id]])
  } finally {
    cleanup.resolve()
  }
})

test('remove drains a previously failed transcript writer without requiring another successful save', async (t) => {
  const f = await savedThread(t)
  const writer = f.manager.turnWriters.get(f.thread.id)
  const mkdir = fs.mkdir
  let fail = true
  t.mock.method(fs, 'mkdir', (dir, ...args) => {
    if (dir === path.dirname(f.turnFile) && fail) { fail = false; return Promise.reject(new Error('previous EPERM')) }
    return mkdir(dir, ...args)
  })
  await assert.rejects(writer.write(await f.disk()), /previous EPERM/)
  // Real flush() retains the failed write even though mkdir now works again.
  await assert.rejects(writer.flush(), /previous EPERM/)
  await f.manager.remove(f.thread.id)
  assert.deepEqual(f.manager.list(), [])
  await assert.rejects(fs.access(f.turnFile), { code: 'ENOENT' })
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8')).threads, [])
})

test('failed index commit preserves the transcript and thread so removal can be retried', async (t) => {
  const f = await savedThread(t)
  const before = await fs.readFile(f.turnFile, 'utf8')
  const removed = []
  f.manager.on('removed', (event) => removed.push(event))
  const writer = f.manager.indexWriter
  const flush = writer.flush
  let fail = true
  t.mock.method(writer, 'flush', () => {
    if (fail) { fail = false; return Promise.reject(new Error('index EPERM')) }
    return flush()
  })
  await assert.rejects(f.manager.remove(f.thread.id), /index EPERM/)
  assert.equal(f.manager.list().length, 1)
  assert.equal(await fs.readFile(f.turnFile, 'utf8'), before)
  assert.equal((await f.manager.get(f.thread.id)).turns.length, 1)
  assert.deepEqual(removed, [])
  await writer.flush()
  assert.equal(JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8')).threads.length, 1)
  const reloaded = f.makeManager()
  await reloaded.load()
  assert.equal((await reloaded.get(f.thread.id)).turns.length, 1)
  await f.manager.remove(f.thread.id)
  assert.deepEqual(removed, [{ threadId: f.thread.id }])
  await assert.rejects(fs.access(f.turnFile), { code: 'ENOENT' })
})

test('locked transcript cleanup cannot resurrect a committed deletion, including after restart', async (t) => {
  const f = await savedThread(t)
  const removed = []
  f.manager.on('removed', (event) => removed.push(event))
  const rm = fs.rm
  t.mock.method(fs, 'rm', (file, ...args) => {
    if (file === f.turnFile) return Promise.reject(new Error('file EPERM'))
    return rm(file, ...args)
  })
  t.mock.method(console, 'warn', () => {})
  await f.manager.remove(f.thread.id)
  assert.deepEqual(f.manager.list(), [])
  assert.deepEqual(removed, [{ threadId: f.thread.id }])
  await fs.access(f.turnFile) // An orphan is harmless: load() only reads the index.
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8')).threads, [])
  const reloaded = f.makeManager()
  await reloaded.load()
  assert.deepEqual(reloaded.list(), [])
  // Later unrelated saves must not put the orphan back into the index.
  const other = await f.manager.create({ workspace: f.base })
  await f.manager.indexWriter.flush()
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8')).threads.map((thread) => thread.id), [other.id])
})

test('a failed concurrent removal restores only its own thread in the latest index', async (t) => {
  const f = await savedThread(t)
  const other = await f.manager.create({ workspace: f.base })
  const committing = deferred()
  const failedCommit = deferred()
  const writer = f.manager.indexWriter
  const flush = writer.flush
  let first = true
  t.mock.method(writer, 'flush', () => {
    if (first) { first = false; committing.resolve(); return failedCommit.promise }
    return flush()
  })
  const removal = f.manager.remove(f.thread.id)
  const rejected = assert.rejects(removal, /index EPERM/)
  await committing.promise
  try {
    await f.manager.remove(other.id)
  } finally {
    failedCommit.reject(new Error('index EPERM'))
  }
  await rejected
  assert.deepEqual(f.manager.list().map((thread) => thread.id), [f.thread.id])
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8')).threads.map((thread) => thread.id), [f.thread.id])
  await fs.access(f.turnFile)
  await f.manager.remove(f.thread.id)
})

test('a failed rollback is reported without losing the transcript or in-memory retry state', async (t) => {
  const f = await savedThread(t)
  const writer = f.manager.indexWriter
  const flush = writer.flush
  let flushes = 0
  // Fail the deletion commit and then its attempted rollback, but allow retry.
  t.mock.method(writer, 'flush', () => {
    if (++flushes <= 2) return Promise.reject(new Error(flushes === 1 ? 'index EPERM' : 'rollback EPERM'))
    return flush()
  })
  await assert.rejects(f.manager.remove(f.thread.id), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors.map((cause) => cause.message), ['index EPERM', 'rollback EPERM'])
    return true
  })
  assert.equal((await f.manager.get(f.thread.id)).turns.length, 1)
  await fs.access(f.turnFile)
  await f.manager.remove(f.thread.id)
  assert.deepEqual(f.manager.list(), [])
})

test('removed event reaches the UI before slow checkpoint garbage collection', async (t) => {
  const cleaning = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  const f = await savedThread(t, { checkpoints: {
    async snapshot() { return { commit: 'snapshot' } },
    async changes() { return [] },
    async tidy() {},
    async forget() { cleaning.resolve(); await release.promise },
  } })
  const removed = []
  f.manager.on('removed', (event) => removed.push(event))
  const removal = f.manager.remove(f.thread.id)
  try {
    await cleaning.promise
    await removal
    assert.deepEqual(removed, [{ threadId: f.thread.id }])
    assert.deepEqual(f.manager.list(), [])
    assert.deepEqual(JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8')).threads, [])
  } finally {
    release.resolve()
    await removal
  }
})

test('removing a task of its own deletes its attachments; a team task keeps them', async (t) => {
  const f = await fixture(t)
  const dir = f.paths.attachmentsDir
  const image = '0f8e2b0c-1234-4abc-9def-0123456789ab.png'
  const other = '1f8e2b0c-1234-4abc-9def-0123456789ab/notes.txt'
  const unrelated = '2f8e2b0c-1234-4abc-9def-0123456789ab.png'
  const teamImage = '3f8e2b0c-1234-4abc-9def-0123456789ab.png'
  await fs.mkdir(path.join(dir, path.dirname(other)), { recursive: true })
  for (const file of [image, other, unrelated, teamImage]) await fs.writeFile(path.join(dir, file), 'bytes')
  const exists = (file) => fs.access(path.join(dir, file)).then(() => true, () => false)
  const run = async (manager, threadId, images) => {
    await manager.send(threadId, { text: 'look at these', images })
    const active = manager.active.get(threadId)
    f.finish.resolve()
    await active.done
  }
  await run(f.manager, f.thread.id, [{ file: image, mimeType: 'image/png', name: 'a.png' }, { file: other, mimeType: 'text/plain', name: 'notes.txt' }])
  const team = await f.manager.create({ workspace: f.base, model: '["test","model"]', toolMode: 'native', team: { id: 'team-1', role: 'child' } })
  await run(f.manager, team.id, [{ file: teamImage, mimeType: 'image/png', name: 'b.png' }])

  // Read back from disk, as after a restart, when the transcript is not in memory.
  await f.manager.turnWriters.get(f.thread.id).flush()
  f.manager.turns.delete(f.thread.id)
  await f.manager.remove(f.thread.id)
  assert.equal(await exists(image), false)
  assert.equal(await exists(path.dirname(other)), false, 'the upload folder goes with its file')
  assert.equal(await exists(unrelated), true)
  await f.manager.remove(team.id)
  assert.equal(await exists(teamImage), true, 'team tasks share files with other records')
})
