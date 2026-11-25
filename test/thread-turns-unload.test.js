import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import { fixture, tick } from './helpers/thread-manager.js'
import { transcriptWriter } from '../server/transcript-writer.js'

const LATER = 11 * 60_000
const MESSAGE_ID = '6f1c1d6e-3a52-4c55-9a3e-1b7f2d9c8a41'

async function finishedTurn(t) {
  const f = await fixture(t)
  const finished = new Promise((resolve) => f.manager.once('turn-finished', resolve))
  await f.manager.send(f.thread.id, { text: 'question', messageId: MESSAGE_ID })
  await f.started.promise
  f.manager.onUpdate(f.manager.threads.get(f.thread.id).sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } })
  f.finish.resolve()
  await finished
  await f.manager.turnWriters.get(f.thread.id).flush()
  await tick()
  return f
}

// Every task opened since startup stayed in memory; long ones are hundreds of MB once parsed.
test('an idle task leaves memory and reads back the same turns and receipts', async (t) => {
  const f = await finishedTurn(t)
  const before = structuredClone((await f.manager.get(f.thread.id)).turns)
  f.manager.pruneTurns(Date.now() + LATER)
  assert.equal(f.manager.turns.has(f.thread.id), false)
  assert.equal(f.manager.turnWriters.has(f.thread.id), false)
  assert.deepEqual((await f.manager.get(f.thread.id)).turns, before)
  assert.deepEqual(await f.manager.messageStatus(f.thread.id, MESSAGE_ID), { status: 'accepted', turnId: before[0].id, kind: 'send' })
  const again = await f.manager.send(f.thread.id, { text: 'question', messageId: MESSAGE_ID })
  assert.equal(again.status, 'accepted')
  assert.equal(f.calls.prompts.length, 1, 'a known message is not sent twice after a reload')
})

test('a recently used task stays, and past the count only the newest idle ones do', async (t) => {
  const f = await finishedTurn(t)
  f.manager.pruneTurns(Date.now() + 60_000)
  assert.equal(f.manager.turns.has(f.thread.id), true)
  const created = []
  for (let i = 0; i < 6; i++) {
    created.push(await f.manager.create({ workspace: f.base, model: '["test","model"]', toolMode: 'native' }))
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  f.manager.pruneTurns(Date.now() + 60_000)
  assert.deepEqual([...f.manager.turns.keys()].sort(), created.slice(-4).map((thread) => thread.id).sort())
})

test('a running task and an unsaved one stay in memory', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'question' })
  await f.started.promise
  f.manager.pruneTurns(Date.now() + LATER)
  assert.equal(f.manager.turns.has(f.thread.id), true)
  const finished = new Promise((resolve) => f.manager.once('turn-finished', resolve))
  f.finish.resolve()
  await finished
  // The finished turn is scheduled to be written but not yet on disk.
  f.manager.pruneTurns(Date.now() + LATER)
  assert.equal(f.manager.turns.has(f.thread.id), true)
  await f.manager.turnWriters.get(f.thread.id).flush()
  await tick()
  f.manager.pruneTurns(Date.now() + LATER)
  assert.equal(f.manager.turns.has(f.thread.id), false)
})

test('team tasks stay in memory: the team reads their turns directly', async (t) => {
  const f = await fixture(t)
  const child = await f.manager.create({ workspace: f.base, model: '["test","model"]', toolMode: 'native', team: { id: 'team-1', childId: 'child-1' } })
  f.manager.pruneTurns(Date.now() + LATER)
  assert.equal(f.manager.turns.has(child.id), true)
  assert.equal(f.manager.turns.has(f.thread.id), false)
})

test('an update for an unloaded task is applied after its turns are read back', async (t) => {
  const f = await finishedTurn(t)
  const sessionId = f.manager.threads.get(f.thread.id).sessionId
  f.manager.pruneTurns(Date.now() + LATER)
  f.manager.onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' late' } })
  f.manager.onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' later' } })
  const { turns } = await f.manager.get(f.thread.id)
  await f.manager.updateLoads.get(f.thread.id)
  const text = turns.at(-1).items.filter((item) => item.type === 'agent').map((item) => item.text).join('')
  assert.match(text, /answer late later$/)
  await f.manager.turnWriters.get(f.thread.id).flush()
  assert.match(JSON.stringify((await f.disk()).turns), /late later/)
})

test('an unloaded task is never saved as empty', async (t) => {
  const f = await finishedTurn(t)
  f.manager.pruneTurns(Date.now() + LATER)
  await f.manager.update(f.thread.id, { title: 'renamed' })
  await f.manager.shutdown()
  assert.equal((await f.disk()).turns.length, 1)
  assert.equal(f.manager.threads.get(f.thread.id).title, 'renamed')
})

test('the writer is idle only when the file holds the latest document', async (t) => {
  const dir = await fs.mkdtemp(`${(await import('node:os')).tmpdir()}/agent-desk-writer-`)
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const writer = transcriptWriter(`${dir}/t.json`, 5)
  assert.equal(writer.idle(), true)
  writer.schedule({ version: 1, turns: [] })
  assert.equal(writer.idle(), false)
  await writer.flush()
  await tick()
  assert.equal(writer.idle(), true)
  writer.scheduleLive({ id: 'turn' }, { version: 1, turns: [{ id: 'turn' }] })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(writer.idle(), false, 'a live file is not folded into the document yet')
  await writer.flush()
  await tick()
  assert.equal(writer.idle(), true)
})
