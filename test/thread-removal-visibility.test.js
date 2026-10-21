import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deferred, fixture, pending } from './helpers/thread-manager.js'

test('hello/list keeps a task visible until its durable deletion commits', async (t) => {
  const f = await fixture(t)
  await f.manager.indexWriter.flush()
  const entered = deferred()
  const commit = deferred()
  const writer = f.manager.indexWriter
  const flush = writer.flush
  let first = true
  t.mock.method(writer, 'flush', async () => {
    if (first) { first = false; entered.resolve(); await commit.promise }
    return flush()
  })
  const removal = f.manager.remove(f.thread.id)
  await entered.promise
  try {
    await pending(removal)
    assert.deepEqual(f.manager.list().map((thread) => thread.id), [f.thread.id])
  } finally {
    commit.resolve()
    await removal
  }
  assert.deepEqual(f.manager.list(), [])
})

test('a failed index commit never publishes a temporary disappearance', async (t) => {
  const f = await fixture(t)
  await f.manager.indexWriter.flush()
  const entered = deferred()
  const commit = deferred()
  const writer = f.manager.indexWriter
  const flush = writer.flush
  let first = true
  t.mock.method(writer, 'flush', () => {
    if (first) { first = false; entered.resolve(); return commit.promise }
    return flush()
  })
  const removal = f.manager.remove(f.thread.id)
  const rejected = assert.rejects(removal, /index locked/)
  await entered.promise
  try {
    assert.deepEqual(f.manager.list().map((thread) => thread.id), [f.thread.id])
  } finally {
    commit.reject(new Error('index locked'))
    await rejected
  }
  assert.deepEqual(f.manager.list().map((thread) => thread.id), [f.thread.id])
})
