import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ThreadManager } from '../server/threads.js'

const THREAD_ID = '11111111-1111-4111-8111-111111111111'
const TURN_ID = '22222222-2222-4222-8222-222222222222'
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333'

/** A data folder whose transcript holds this turn, as an app crash leaves it. */
async function seeded(t, turn, receipts = []) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-interrupted-'))
  const paths = {
    threadsIndex: path.join(base, 'threads.json'),
    threadsDir: path.join(base, 'threads'),
    attachmentsDir: path.join(base, 'attachments'),
    dshHome: path.join(base, 'dsh-home'),
    runtimeCwd: path.join(base, 'runtime'),
  }
  await fs.mkdir(paths.threadsDir, { recursive: true })
  await fs.writeFile(paths.threadsIndex, JSON.stringify({ version: 1, threads: [{
    id: THREAD_ID, title: 'interrupted', workspace: base, model: '["test","model"]', effort: '',
    permissionMode: 'workspace-write', toolMode: 'native', sessionId: null,
    createdAt: turn.startedAt, updatedAt: turn.startedAt, archived: false, usage: null, score: null,
  }] }))
  const turnFile = path.join(paths.threadsDir, THREAD_ID + '.json')
  await fs.writeFile(turnFile, JSON.stringify({ version: 1, turns: [turn], receipts }))

  const managers = []
  t.after(async () => {
    for (const manager of managers) await manager.shutdown().catch(() => {})
    await fs.rm(base, { recursive: true, force: true })
  })
  const pool = Object.assign(new EventEmitter(), {
    get: async () => { throw new Error('a settled transcript needs no runtime') },
    holderOf: () => null,
    status: () => ({}),
  })
  const makeManager = () => {
    const manager = new ThreadManager({ paths, pool, catalog: { learn: () => false }, getAccounts: async () => ({}), getTurnUsage: async () => null })
    managers.push(manager)
    return manager
  }
  return { base, paths, turnFile, makeManager }
}

const runningTurn = (startedAt, items) => ({
  id: TURN_ID, startedAt, endedAt: null, status: 'running', stopReason: null, error: null,
  user: { text: 'do the thing', images: [] }, items,
  outputSpeed: { tokensPerSecond: 9, state: 'streaming', estimated: true },
})

test('an interrupted turn keeps its last recorded activity, and that settled state is saved', async (t) => {
  const startedAt = Date.now() - 6 * 60 * 60 * 1000
  const toolStartedAt = startedAt + 5_000
  const turn = runningTurn(startedAt, [
    { type: 'agent', id: 'a1', text: 'working on it' },
    { type: 'tool', id: 't1', name: 'write', kind: 'edit', status: 'in_progress', output: '', startedAt: toolStartedAt },
  ])
  const receipt = { messageId: MESSAGE_ID, payload: { text: 'do the thing', images: [] }, status: 'accepted', kind: 'send', turnId: TURN_ID }
  const f = await seeded(t, turn, [receipt])

  const manager = f.makeManager()
  await manager.load()
  const loaded = (await manager.get(THREAD_ID)).turns[0]
  assert.equal(loaded.status, 'error')
  assert.deepEqual(loaded.error, { message: 'アプリの終了により中断されました。' })
  // The last recorded activity, never the time this transcript happens to be opened.
  assert.equal(loaded.endedAt, toolStartedAt)
  assert.equal(loaded.items[1].status, 'failed')
  assert.equal(loaded.outputSpeed, undefined)

  await manager.turnWriters.get(THREAD_ID).flush()
  const saved = JSON.parse(await fs.readFile(f.turnFile, 'utf8'))
  // What the UI was shown is what the transcript says, including the tool state.
  assert.deepEqual(saved.turns, [loaded])
  assert.deepEqual(saved.receipts, [receipt])
  assert.deepEqual(await manager.messageStatus(THREAD_ID, MESSAGE_ID),
    { status: 'accepted', turnId: TURN_ID, kind: 'send' })

  const restarted = f.makeManager()
  await restarted.load()
  assert.equal((await restarted.get(THREAD_ID)).turns[0].endedAt, toolStartedAt)
})

test('an interrupted turn with no later activity ends at its start, not at the next load', async (t) => {
  const startedAt = Date.now() - 60_000
  const turn = runningTurn(startedAt, [{ type: 'agent', id: 'a1', text: 'thinking' }])
  const f = await seeded(t, turn)

  const manager = f.makeManager()
  await manager.load()
  const loaded = (await manager.get(THREAD_ID)).turns[0]
  assert.equal(loaded.status, 'error')
  assert.equal(loaded.endedAt, startedAt)
  assert.equal(loaded.outputSpeed, undefined)

  await manager.turnWriters.get(THREAD_ID).flush()
  const saved = JSON.parse(await fs.readFile(f.turnFile, 'utf8'))
  assert.equal(saved.turns[0].endedAt, startedAt)
  assert.equal(saved.turns[0].outputSpeed, undefined)
})
