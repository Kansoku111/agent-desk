import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { liveFile, readTranscript, transcriptWriter } from '../server/transcript-writer.js'
import { fixture } from './helpers/thread-manager.js'

async function setup(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-transcript-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const file = path.join(base, 'task.json')
  const read = (name) => fs.readFile(name, 'utf8').then(JSON.parse, () => null)
  return { file, live: liveFile(file), read }
}

/** Waits for a background write: the writers only promise their direct writes. */
async function until(check) {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('the background write did not happen')
}

const turn = (id, items = []) => ({ id, status: 'running', user: { text: 'go', images: [] }, items })

test('live updates write only the streaming turn, and reading puts it back', async (t) => {
  const { file, live, read } = await setup(t)
  const writer = transcriptWriter(file, 5)
  const done = turn('t1')
  const running = turn('t2')
  const doc = () => ({ version: 1, turns: [done, running], receipts: [{ messageId: 'm1' }] })
  await writer.write(doc())
  const whole = await fs.readFile(file, 'utf8')

  running.items.push({ type: 'tool', id: 'x', output: 'streamed' })
  writer.scheduleLive(running, doc())
  await until(async () => (await read(live))?.turn.items.length === 1)
  assert.equal(await fs.readFile(file, 'utf8'), whole, 'the whole document is not rewritten')
  assert.equal((await read(live)).revision, (await read(file)).revision)

  const loaded = await readTranscript(file, { version: 1, turns: [] })
  assert.deepEqual(loaded.turns.map((entry) => entry.items.length), [0, 1])
  assert.deepEqual(loaded.receipts, [{ messageId: 'm1' }])

  // A flush folds the live file back into the document.
  await writer.flush()
  assert.deepEqual((await read(file)).turns[1].items, [{ type: 'tool', id: 'x', output: 'streamed' }])
  assert.equal(await read(live), null)
})

test('a live file older than the whole document is ignored', async (t) => {
  const { file, live, read } = await setup(t)
  const writer = transcriptWriter(file, 5)
  const running = turn('t1')
  const doc = () => ({ version: 1, turns: [running], receipts: [] })
  await writer.write(doc())
  running.items.push({ type: 'agent', text: 'first' })
  writer.scheduleLive(running, doc())
  await until(async () => Boolean(await read(live)))
  const stale = await fs.readFile(live, 'utf8')
  running.items.push({ type: 'agent', text: 'second' })
  writer.schedule(doc())
  await writer.flush()
  // As if removing the live file had failed after the newer document was written.
  await fs.writeFile(live, stale)
  const loaded = await readTranscript(file, null)
  assert.deepEqual(loaded.turns[0].items.map((item) => item.text), ['first', 'second'])
})

test('the first save in a process writes the whole document, even for a live update', async (t) => {
  const { file, live, read } = await setup(t)
  const writer = transcriptWriter(file, 5)
  const running = turn('t1', [{ type: 'agent', text: 'hello' }])
  writer.scheduleLive(running, { version: 1, turns: [running], receipts: [] })
  await until(async () => Boolean(await read(file)))
  assert.equal((await read(file)).turns[0].items[0].text, 'hello')
  assert.equal(await read(live), null)
})

test('a crash while a turn streams keeps the streamed items, settled as interrupted', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'work for a while' })
  await f.started.promise
  const sessionId = f.manager.threads.get(f.thread.id).sessionId
  const whole = await fs.readFile(f.turnFile, 'utf8')
  for (const id of ['a', 'b', 'c']) {
    f.manager.onUpdate(sessionId, { sessionUpdate: 'tool_call', toolCallId: id, title: `read ${id}`, kind: 'read', status: 'in_progress' })
  }
  const live = liveFile(f.turnFile)
  await until(async () => (await fs.readFile(live, 'utf8').then(JSON.parse, () => null))?.turn.items.length === 3)
  assert.equal(await fs.readFile(f.turnFile, 'utf8'), whole, 'streaming updates leave the whole document alone')

  // Another manager reads the data folder as a restart after a crash would.
  const restarted = f.makeManager()
  await restarted.load()
  const [loaded] = (await restarted.get(f.thread.id)).turns
  assert.deepEqual(loaded.items.map((item) => item.id), ['a', 'b', 'c'])
  assert.equal(loaded.status, 'error')
  await restarted.turnWriters.get(f.thread.id).flush()
  assert.deepEqual((await f.disk()).turns[0].items.map((item) => item.id), ['a', 'b', 'c'])
  await assert.rejects(fs.access(live), { code: 'ENOENT' })
})
