import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { groupRows, visibleRows } from '../web/src/task-rows.ts'
import { TerminalManager } from '../server/terminals.js'
import { AbManager } from '../server/ab.js'
import { createThreadHandlers } from '../server/rpc-handlers-threads.js'
import { createTerminalHandlers } from '../server/rpc-handlers-terminals.js'
import { createAbHandlers } from '../server/rpc-handlers-ab.js'
import { fixture } from './helpers/thread-manager.js'

const ids = (rows) => rows.map((row) => row.id)
const task = (id, updatedAt, pinned) => ({ id, updatedAt, pinned })

test('mixed project rows put pins first, with recency within both groups, and unpin restores recency', () => {
  const group = {
    threads: [task('thread', 30), task('pinned-thread', 2, true)],
    terminals: [task('terminal', 20), task('pinned-team', 3, true)],
    ab: [task('ab', 10), task('pinned-ab', 1, true)],
  }
  assert.deepEqual(ids(groupRows(group)), ['pinned-team', 'pinned-thread', 'pinned-ab', 'thread', 'terminal', 'ab'])
  group.terminals[1].pinned = false
  assert.deepEqual(ids(groupRows(group)), ['pinned-thread', 'pinned-ab', 'thread', 'terminal', 'ab', 'pinned-team'])
  assert.deepEqual(ids(group.threads), ['thread', 'pinned-thread'], 'source state is not reordered')
})

test('pins survive collapsed and expanded row quotas without hiding recent or active tasks', () => {
  const rows = groupRows({ threads: [
    ...Array.from({ length: 12 }, (_, i) => task(`pin-${i}`, i, true)),
    ...Array.from({ length: 12 }, (_, i) => task(`recent-${i}`, 100 - i)),
  ], terminals: [], ab: [] })
  assert.equal(visibleRows(rows, false, false, null).length, 15)
  assert.equal(visibleRows(rows, true, false, null).length, 22)
  assert.deepEqual(ids(visibleRows(rows, false, false, 'recent-11')).slice(-4), ['recent-0', 'recent-1', 'recent-2', 'recent-11'])
  assert.equal(visibleRows(rows, false, true, null), rows, 'search retains every match')
  const ordinary = rows.filter((row) => !row.pinned)
  assert.equal(visibleRows(ordinary, false, false, null).length, 3)
  assert.equal(visibleRows(ordinary, true, false, null).length, 10)
})

test('thread RPC pins a running task, broadcasts and restores state, independently of archive', async (t) => {
  const f = await fixture(t)
  const rpc = createThreadHandlers({ threads: f.manager, mutateSettings: async () => {} })
  assert.equal(f.thread.pinned, false, 'old records default to unpinned')
  await f.manager.send(f.thread.id, { text: 'working' })
  await f.started.promise
  const events = []
  f.manager.on('thread', (value) => events.push(value))
  const { thread } = await rpc['thread.update']({ threadId: f.thread.id, pinned: true })
  assert.equal(thread.pinned, true)
  assert.equal(thread.status, 'running')
  assert.equal(events.at(-1).pinned, true)
  await f.manager.update(thread.id, { archived: true, title: 'renamed' })
  await f.manager.indexWriter.flush()
  const restored = f.makeManager()
  await restored.load()
  assert.equal(restored.list()[0].pinned, true)
  await rpc['thread.update']({ threadId: thread.id, pinned: false })
  await f.manager.indexWriter.flush()
  const unpinned = f.makeManager()
  await unpinned.load()
  assert.equal(unpinned.list()[0].pinned, false)
  assert.equal(unpinned.list()[0].archived, true)
  assert.equal(unpinned.list()[0].title, 'renamed')
})

test('terminal RPC keeps pin state through restart and preserves team and archive metadata', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-terminal-pins-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const options = { file: path.join(dir, 'terminals.json'), settingsFile: path.join(dir, 'hooks.json'), hookUrl: () => '', send: () => {} }
  const manager = await new TerminalManager(options).load()
  manager.records.set('team', { id: 'team', title: 'Team', workspace: dir, updatedAt: 1, archived: false, team: { id: 'eco', role: 'leader' } })
  assert.equal(manager.list()[0].pinned, false)
  const events = []
  manager.on('terminal', (value) => events.push(value))
  const rpc = createTerminalHandlers({ terminals: manager })
  const { terminal } = await rpc['terminal.update']({ terminalId: 'team', pinned: true })
  assert.equal(terminal.pinned, true)
  assert.equal(events.at(-1).pinned, true)
  const restored = await new TerminalManager(options).load()
  assert.equal(restored.list()[0].pinned, true)
  await restored.update('team', { archived: true, title: 'Renamed' })
  assert.equal(restored.list()[0].pinned, true)
  await createTerminalHandlers({ terminals: restored })['terminal.update']({ terminalId: 'team', pinned: false })
  const unpinned = await new TerminalManager(options).load()
  assert.equal(unpinned.list()[0].pinned, false)
  assert.equal(unpinned.list()[0].archived, true)
  assert.equal(unpinned.list()[0].title, 'Renamed')
  assert.deepEqual(unpinned.list()[0].team, { id: 'eco', role: 'leader' })
})

test('AB RPC persists pin and unpin without changing jobs or losing archive metadata', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-ab-pins-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const runner = Object.assign(new EventEmitter(), { start: async () => {}, stop: async () => {} })
  const manager = await new AbManager({ dir, runner, validateModel: () => {} }).load()
  const { run } = await manager.create({ workspace: dir, text: 'test', config: { a: 'A', b: 'B', leader: 'L', implementer: 'I' } })
  assert.equal(run.pinned, false)
  const rpc = createAbHandlers(manager)
  const pinned = await rpc['ab.update']({ runId: run.id, pinned: true })
  assert.equal(pinned.run.pinned, true)
  assert.deepEqual(pinned.run.jobs, run.jobs)
  const restored = await new AbManager({ dir, runner }).load()
  assert.equal(restored.list()[0].pinned, true)
  await restored.update({ id: run.id, archived: true })
  assert.equal(restored.list()[0].pinned, true)
  await assert.rejects(restored.update({ id: run.id, pinned: 'yes' }), /ピン留め設定が不正/)
  await createAbHandlers(restored)['ab.update']({ runId: run.id, pinned: false })
  const unpinned = await new AbManager({ dir, runner }).load()
  assert.equal(unpinned.list()[0].pinned, false)
  assert.equal(unpinned.list()[0].archived, true)
})
