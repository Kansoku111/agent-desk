import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Checkpoints } from '../server/checkpoints.js'
import { isUndoable, restoreNoteText, ThreadManager } from '../server/threads.js'

/** A runtime whose agent runs `act(promptText)` instead of a model. */
function fakePool(act) {
  const prompts = []
  const runtime = {
    liveSessions: new Set(),
    async newSession() {
      const sessionId = `s-${this.liveSessions.size + 1}`
      this.liveSessions.add(sessionId)
      return { sessionId, configOptions: [] }
    },
    async resumeSession(sessionId) {
      this.liveSessions.add(sessionId)
      return { configOptions: [] }
    },
    async setOption() {
      return []
    },
    async prompt(_sessionId, blocks) {
      prompts.push(blocks.map((block) => block.text).join('\n'))
      await act(blocks.at(-1).text)
      return { stopReason: 'end_turn' }
    },
    async cancel() {},
    async closeSession() {},
  }
  const pool = Object.assign(new EventEmitter(), {
    get: async () => runtime,
    holderOf: (sessionId) => (runtime.liveSessions.has(sessionId) ? runtime : null),
    status: () => ({}),
  })
  return { pool, prompts }
}

async function settled(manager, threadId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { turns } = await manager.get(threadId)
    const last = turns.at(-1)
    if (last.status !== 'running' && last.checkpoint?.changed !== undefined) return turns
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('turn did not settle')
}

test('a turn can be undone, the agent is told, and the undo can be taken back', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-restore-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const workspace = path.join(base, 'work')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'notes.txt'), 'original')
  const file = (name) => fs.readFile(path.join(workspace, name), 'utf8').catch(() => null)

  const { pool, prompts } = fakePool(async (text) => {
    if (text === 'edit') {
      await fs.writeFile(path.join(workspace, 'notes.txt'), 'edited by the agent')
      await fs.writeFile(path.join(workspace, 'new.txt'), 'created')
    }
  })
  const manager = new ThreadManager({
    paths: {
      threadsIndex: path.join(base, 'threads.json'),
      threadsDir: path.join(base, 'threads'),
      attachmentsDir: path.join(base, 'attachments'),
      dshHome: path.join(base, 'dsh-home'),
      runtimeCwd: path.join(base, 'runtime'),
    },
    pool,
    catalog: { learn: () => false },
    getAccounts: async () => ({}),
    getTurnUsage: async () => null,
    checkpoints: new Checkpoints({ root: path.join(base, 'checkpoints') }),
  })
  t.after(() => manager.shutdown())

  const thread = await manager.create({ workspace, model: '["test","model"]' })
  await manager.send(thread.id, { text: 'edit' })
  let turns = await settled(manager, thread.id)
  assert.equal(turns[0].checkpoint.changed, 2)
  assert.equal(await file('notes.txt'), 'edited by the agent')

  const preview = await manager.checkpointPreview(thread.id, turns[0].id)
  assert.deepEqual(preview.files.map((entry) => entry.action).sort(), ['delete', 'restore'])

  const restored = await manager.restoreCheckpoint(thread.id, turns[0].id)
  assert.deepEqual(restored, { files: 2, error: null })
  assert.equal(await file('notes.txt'), 'original')
  assert.equal(await file('new.txt'), null)
  turns = (await manager.get(thread.id)).turns
  assert.equal(turns[0].revertedBy, turns[0].id)
  assert.ok(isUndoable(turns, turns[0]))

  // Undo the restore: the agent's work comes back, and nothing needs telling.
  await manager.undoRestore(thread.id, turns[0].id)
  assert.equal(await file('notes.txt'), 'edited by the agent')
  assert.equal(await file('new.txt'), 'created')
  assert.equal(turns[0].revertedBy, undefined)

  // Restore again and send: the agent hears about it once, and the restore is final.
  await manager.restoreCheckpoint(thread.id, turns[0].id)
  await manager.send(thread.id, { text: 'look' })
  turns = await settled(manager, thread.id)
  assert.match(prompts[1], /restored the workspace files to how they were before their first request/)
  assert.equal(isUndoable(turns, turns[0]), false)
  await assert.rejects(manager.undoRestore(thread.id, turns[0].id), /取り消せません/)
  await manager.send(thread.id, { text: 'again' })
  await settled(manager, thread.id)
  assert.doesNotMatch(prompts[2], /Agent Desk/)
})

test('undoing the latest of two restores still tells the agent about the one that stays, once', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-restore-twice-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const workspace = path.join(base, 'work')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'a.txt'), 'a0')
  await fs.writeFile(path.join(workspace, 'b.txt'), 'b0')
  const file = (name) => fs.readFile(path.join(workspace, name), 'utf8')
  const act = async (text) => {
    if (text === 'T1') await fs.writeFile(path.join(workspace, 'a.txt'), 'a1')
    if (text === 'T2') await fs.writeFile(path.join(workspace, 'b.txt'), 'b1')
  }
  const open = async (pool) => {
    const manager = new ThreadManager({
      paths: {
        threadsIndex: path.join(base, 'threads.json'),
        threadsDir: path.join(base, 'threads'),
        attachmentsDir: path.join(base, 'attachments'),
        dshHome: path.join(base, 'dsh-home'),
        runtimeCwd: path.join(base, 'runtime'),
      },
      pool,
      catalog: { learn: () => false },
      getAccounts: async () => ({}),
      getTurnUsage: async () => null,
      checkpoints: new Checkpoints({ root: path.join(base, 'checkpoints') }),
    })
    await manager.load()
    return manager
  }
  const notes = (prompt) => prompt.match(/\[Context from Agent Desk\] Since your last reply/g)?.length ?? 0

  const first = fakePool(act)
  const manager = await open(first.pool)
  let closed = false
  t.after(() => closed || manager.shutdown())
  const thread = await manager.create({ workspace, model: '["test","model"]' })
  await manager.send(thread.id, { text: 'T1' })
  await settled(manager, thread.id)
  await manager.send(thread.id, { text: 'T2' })
  const [t1, t2] = await settled(manager, thread.id)
  assert.equal(await file('a.txt'), 'a1')
  assert.equal(await file('b.txt'), 'b1')

  // Undoing both restores, newest first, leaves nothing to tell.
  await manager.restoreCheckpoint(thread.id, t2.id)
  await manager.restoreCheckpoint(thread.id, t1.id)
  await manager.undoRestore(thread.id, t1.id)
  await manager.undoRestore(thread.id, t2.id)
  assert.equal(await file('a.txt'), 'a1')
  assert.equal(await file('b.txt'), 'b1')
  assert.equal(manager.threads.get(thread.id).restoreNote, undefined)

  // Undoing only the latest one leaves T2 undone, and the note for it stays.
  await manager.restoreCheckpoint(thread.id, t2.id)
  await manager.restoreCheckpoint(thread.id, t1.id)
  assert.equal(await file('a.txt'), 'a0')
  await manager.undoRestore(thread.id, t1.id)
  assert.equal(await file('a.txt'), 'a1')
  assert.equal(await file('b.txt'), 'b0')
  await manager.shutdown()
  closed = true

  // The note survives a reload from disk, and goes out with the next message only.
  const second = fakePool(act)
  const reloaded = await open(second.pool)
  t.after(() => reloaded.shutdown())
  await reloaded.send(thread.id, { text: 'look' })
  await settled(reloaded, thread.id)
  assert.match(second.prompts[0], /before an earlier request of theirs \("T2"\)/)
  assert.equal(notes(second.prompts[0]), 1)
  await reloaded.send(thread.id, { text: 'again' })
  await settled(reloaded, thread.id)
  assert.equal(notes(second.prompts[1]), 0)
  assert.equal(await file('b.txt'), 'b0')
})

test('restoreNoteText names a later request by its first line', () => {
  const text = restoreNoteText({ request: 'fix the header\nand the footer', first: false })
  assert.match(text, /before an earlier request of theirs \("fix the header"\)/)
})

test('a partly failed undo keeps its record, so the undo can be tried again', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-undo-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const { pool } = fakePool(async () => {})
  const undos = []
  const checkpoints = {
    async snapshot() { return { commit: 'before-commit' } },
    async restore(_workspace, target, undoRef) {
      if (undoRef) return { undo: 'undo-commit', restored: ['notes.txt'], removed: [], error: null }
      undos.push(target)
      return undos.length === 1
        ? { undo: null, restored: [], removed: [], error: 'unable to unlink notes.txt: Permission denied' }
        : { undo: null, restored: ['notes.txt'], removed: [], error: null }
    },
    async changes() { return [] },
    async tidy() {},
    async forget() {},
  }
  const manager = new ThreadManager({
    paths: {
      threadsIndex: path.join(base, 'threads.json'),
      threadsDir: path.join(base, 'threads'),
      attachmentsDir: path.join(base, 'attachments'),
      dshHome: path.join(base, 'dsh-home'),
      runtimeCwd: path.join(base, 'runtime'),
    },
    pool,
    catalog: { learn: () => false },
    getAccounts: async () => ({}),
    getTurnUsage: async () => null,
    checkpoints,
  })
  t.after(() => manager.shutdown())

  const thread = await manager.create({ workspace: base, model: '["test","model"]' })
  await manager.send(thread.id, { text: 'edit' })
  const [turn] = await settled(manager, thread.id)
  await manager.restoreCheckpoint(thread.id, turn.id)
  assert.deepEqual(await manager.undoRestore(thread.id, turn.id), { files: 0, error: 'unable to unlink notes.txt: Permission denied' })
  assert.ok((await manager.get(thread.id)).turns[0].restore)
  assert.deepEqual(await manager.undoRestore(thread.id, turn.id), { files: 1, error: null })
  assert.equal((await manager.get(thread.id)).turns[0].restore, undefined)
})
