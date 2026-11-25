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

const chunk = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const agentText = (turn) => turn.items.filter((item) => item.type === 'agent').map((item) => item.text).join('')

test('a late update whose turns cannot be read back is held and applied when they can', async (t) => {
  const f = await finishedTurn(t)
  const sessionId = f.manager.threads.get(f.thread.id).sessionId
  f.manager.pruneTurns(Date.now() + LATER)
  await fs.rename(f.turnFile, `${f.turnFile}.away`)
  f.manager.onUpdate(sessionId, chunk(' late'))
  await f.manager.updateLoads.get(f.thread.id)
  assert.equal(f.manager.heldUpdates.get(f.thread.id).length, 1)
  await fs.rename(`${f.turnFile}.away`, f.turnFile)
  const { turns } = await f.manager.get(f.thread.id)
  assert.match(agentText(turns.at(-1)), /answer late$/)
  assert.equal(f.manager.heldUpdates.has(f.thread.id), false)
})

test('a dropped task whose file went missing fails instead of reading as empty', async (t) => {
  const f = await finishedTurn(t)
  f.manager.pruneTurns(Date.now() + LATER)
  await fs.rm(f.turnFile)
  await assert.rejects(f.manager.get(f.thread.id), /履歴ファイルが見つかりません/)
  await assert.rejects(f.manager.messageStatus(f.thread.id, MESSAGE_ID), /履歴ファイルが見つかりません/)
  await assert.rejects(f.manager.send(f.thread.id, { text: 'question', messageId: MESSAGE_ID }), /履歴ファイルが見つかりません/)
  assert.equal(f.calls.prompts.length, 1, 'the accepted message is not sent again')
  await assert.rejects(fs.stat(f.turnFile), { code: 'ENOENT' })
})

test('an empty task that was never sent still opens after it was dropped', async (t) => {
  const f = await fixture(t)
  f.manager.pruneTurns(Date.now() + LATER)
  assert.equal(f.manager.turns.has(f.thread.id), false)
  assert.deepEqual((await f.manager.get(f.thread.id)).turns, [])
})

test('a late update received just before shutdown is saved', async (t) => {
  const f = await finishedTurn(t)
  const sessionId = f.manager.threads.get(f.thread.id).sessionId
  f.manager.pruneTurns(Date.now() + LATER)
  f.manager.onUpdate(sessionId, chunk(' before shutdown'))
  await f.manager.shutdown()
  assert.match(agentText((await f.disk()).turns.at(-1)), /answer before shutdown$/)
})

test('a late update of a finished turn is saved whole, so the task can still leave memory', async (t) => {
  const f = await finishedTurn(t)
  f.manager.onUpdate(f.manager.threads.get(f.thread.id).sessionId, chunk(' late'))
  await new Promise((resolve) => setTimeout(resolve, 600))
  await tick()
  await assert.rejects(fs.stat(f.turnFile.replace(/\.json$/, '.live.json')), { code: 'ENOENT' })
  assert.match(agentText((await f.disk()).turns.at(-1)), /answer late$/)
  f.manager.pruneTurns(Date.now() + LATER)
  assert.equal(f.manager.turns.has(f.thread.id), false)
})

test('the next send starts only after late updates of the last turn are applied', async (t) => {
  const f = await finishedTurn(t)
  const sessionId = f.manager.threads.get(f.thread.id).sessionId
  f.manager.pruneTurns(Date.now() + LATER)
  for (let i = 0; i < 20; i++) f.manager.onUpdate(sessionId, chunk(` ${i}`))
  const finished = new Promise((resolve) => f.manager.once('turn-finished', resolve))
  await f.manager.send(f.thread.id, { text: 'next' })
  await finished
  const { turns } = await f.manager.get(f.thread.id)
  assert.equal(turns.length, 2)
  assert.equal(agentText(turns[0]), 'answer' + Array.from({ length: 20 }, (_, i) => ` ${i}`).join(''))
})
