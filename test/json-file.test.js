import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { debouncedWriter, writeJson } from '../server/json-file.js'

test('a debounced write holds the value as it was when the write was queued', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-file-'))
  try {
    const file = path.join(dir, 'doc.json')
    const value = { version: 1, turns: [{ id: 'a', items: [{ text: 'before' }] }] }
    const writer = debouncedWriter(file, 5)
    const written = writer.write(value)
    value.turns[0].items[0].text = 'after'
    await written
    const expected = path.join(dir, 'expected.json')
    await writeJson(expected, { version: 1, turns: [{ id: 'a', items: [{ text: 'before' }] }] })
    assert.equal(await fs.readFile(file, 'utf8'), await fs.readFile(expected, 'utf8'))
    assert.equal(await fs.readFile(file, 'utf8'), `${JSON.stringify({ version: 1, turns: [{ id: 'a', items: [{ text: 'before' }] }] }, null, 2)}\n`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a written file is synced to disk before it replaces the old one', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-file-sync-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const events = []
  const { open, rename } = fs
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open.apply(fs, args)
    const sync = handle.sync.bind(handle)
    handle.sync = async () => { events.push('sync'); await sync() }
    return handle
  })
  t.mock.method(fs, 'rename', async (from, to) => { events.push('rename'); return rename.call(fs, from, to) })
  await writeJson(path.join(dir, 'doc.json'), { version: 1 })
  assert.deepEqual(events, ['sync', 'rename'])
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'doc.json'), 'utf8')), { version: 1 })
  assert.deepEqual(await fs.readdir(dir), ['doc.json'])
})

test('a background write that fails is retried with its value once the obstacle is gone', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-file-retry-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  t.mock.method(console, 'error', () => {})
  const file = path.join(dir, 'doc.json')
  // A directory in the way makes every replace fail, as a locked file would.
  await fs.mkdir(file)
  const writer = debouncedWriter(file, 5)
  writer.schedule({ receipt: 'accepted' })
  // Long enough for the first attempt to fail (on Windows, the rename is retried for about a second first).
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await fs.rm(file, { recursive: true })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fs.readFile(file, 'utf8').catch(() => null)) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { receipt: 'accepted' })
})
