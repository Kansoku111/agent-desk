import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { patchPtcSource } from '../server/ptc-patch.js'
import { assertPresentationReady, setToolMode, withToolMode } from '../server/ptc-bridge.js'
import { TOOL_MODE_CONFIG, ptcEventUpdate, toolModeOption } from '../server/ptc.js'
import { applyUpdate, newTurn, settleTurn } from '../server/transcript.js'
import { fileChanges } from '../web/src/util.ts'
import { fixture, deferred } from './helpers/thread-manager.js'

const option = (mode) => [{ id: TOOL_MODE_CONFIG, currentValue: mode }, { id: 'model', currentValue: '["test","model"]' }]

test('PTC patch requires both configuration and history anchors; drift and duplicate application fail closed', async () => {
  const source = await fs.readFile(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-acp'), 'utf8')
  const patched = patchPtcSource(source)
  assert.ok(patched)
  assert.equal(patchPtcSource(patched), null)
  for (const anchor of ['return this.modelControl.options(signal);', 'return this.modelControl.set(configId, value, signal);', '} else if (event.type === "tool/call") {']) {
    assert.equal(patchPtcSource(source.replace(anchor, 'drift')), null)
  }
})

test('bridge releases the exact declaration before switching, rejects busy/invalid requests and blocks prompts after failure', async () => {
  const calls = []
  const gate = deferred()
  let fail = false
  const record = { assertActive() {}, agent: { status: 'idle', ctx: { tools: { async presentAs(mode) {
    calls.push(mode)
    if (fail) { await gate.promise; throw new Error('declaration failed') }
    return () => { calls.push(`dispose:${mode}`) }
  } } } } }
  assert.equal(toolModeOption(withToolMode(record, [])).currentValue, 'native')
  await setToolMode(record, 'ptc')
  await setToolMode(record, 'ptc')
  await setToolMode(record, 'native')
  assert.deepEqual(calls, ['ptc', 'dispose:ptc', 'native'])
  record.inflight = {}
  await assert.rejects(setToolMode(record, 'ptc'), /busy/)
  delete record.inflight
  await assert.rejects(setToolMode(record, 'invalid'))
  fail = true
  const change = setToolMode(record, 'ptc')
  assert.throws(() => assertPresentationReady(record), /not ready/)
  await assert.rejects(setToolMode(record, 'ptc'), /busy/)
  gate.resolve()
  await assert.rejects(change, /declaration failed/)
  assert.throws(() => assertPresentationReady(record), /not ready/)
  fail = false
  await setToolMode(record, 'native')
  assertPresentationReady(record)
})

test('native → PTC → native stays in one session and only takes effect on next send', async (t) => {
  const f = await fixture(t)
  let mode = 'native'
  const modes = []
  f.runtime.newSession = async () => {
    f.runtime.liveSessions.add('same-session')
    return { sessionId: 'same-session', configOptions: option(mode) }
  }
  f.runtime.setOption = async (_session, id, value) => {
    assert.equal(id, TOOL_MODE_CONFIG)
    mode = value
    return option(mode)
  }
  f.runtime.prompt = async () => { modes.push(mode); return { stopReason: 'end_turn' } }
  const send = async () => {
    const done = new Promise((resolve) => f.manager.once('turn-finished', resolve))
    await f.manager.send(f.thread.id, { text: 'continue' })
    assert.equal((await done).status, 'done')
  }
  await send()
  await f.manager.update(f.thread.id, { toolMode: 'ptc' })
  assert.equal(mode, 'native')
  await send()
  await f.manager.update(f.thread.id, { toolMode: 'native' })
  await send()
  assert.deepEqual(modes, ['native', 'ptc', 'native'])
  assert.equal(f.manager.threads.get(f.thread.id).sessionId, 'same-session')
})

test('saved PTC is reapplied after restart/resume and native remains default for old tasks', async (t) => {
  const f = await fixture(t)
  f.manager.threads.get(f.thread.id).sessionId = 'persisted'
  await f.manager.update(f.thread.id, { toolMode: 'ptc' })
  await f.manager.shutdown()
  const restored = f.makeManager()
  await restored.load()
  assert.equal((await restored.get(f.thread.id)).thread.toolMode, 'ptc')
  const calls = []
  f.runtime.resumeSession = async (id) => { calls.push('resume'); f.runtime.liveSessions.add(id); return { configOptions: option('native') } }
  f.runtime.setOption = async (_id, config, value) => { calls.push([config, value]); return option(value) }
  f.runtime.prompt = async () => { calls.push('prompt'); return { stopReason: 'end_turn' } }
  const done = new Promise((resolve) => restored.once('turn-finished', resolve))
  await restored.send(f.thread.id, { text: 'resume' })
  assert.equal((await done).status, 'done')
  assert.deepEqual(calls, ['resume', [TOOL_MODE_CONFIG, 'ptc'], 'prompt'])
  const index = JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8'))
  delete index.threads[0].toolMode
  await restored.shutdown()
  await fs.writeFile(f.paths.threadsIndex, JSON.stringify(index))
  const legacy = f.makeManager()
  await legacy.load()
  assert.equal((await legacy.get(f.thread.id)).thread.toolMode, 'native')
})

test('PTC cannot be changed while running; workflow tasks accept creation but reject independent changes', async (t) => {
  const f = await fixture(t)
  assert.equal(f.thread.toolMode, 'native')
  await f.manager.send(f.thread.id, { text: 'run' })
  await f.started.promise
  await assert.rejects(f.manager.update(f.thread.id, { toolMode: 'ptc' }), /実行中/)
  await assert.rejects(f.manager.update(f.thread.id, { toolMode: 'bogus' }), /不明/)
  assert.equal(f.manager.threads.get(f.thread.id).toolMode, 'native')
  for (const metadata of [{ ab: {} }, { team: { role: 'leader' } }, { team: { childId: 'c' } }, { team: { execution: true } }]) {
    const thread = await f.manager.create({ workspace: f.base, toolMode: 'ptc', ...metadata })
    assert.equal(thread.toolMode, 'ptc')
    await assert.rejects(f.manager.update(thread.id, { toolMode: 'native' }), /設定から/)
    await assert.rejects(f.manager.create({ workspace: f.base, toolMode: 'bogus', ...metadata }), /不明/)
  }
})

test('team owner choice overrides stale task settings on sends and resumed sessions', async (t) => {
  const f = await fixture(t)
  let selected = 'ptc'
  let applied = 'native'
  const modes = []
  f.manager.teamToolMode = (thread) => thread.team ? selected : undefined
  const thread = await f.manager.create({ workspace: f.base, model: f.thread.model, team: { id: 'T', childId: 'C' } })
  f.runtime.newSession = async () => {
    f.runtime.liveSessions.add('team-session')
    return { sessionId: 'team-session', configOptions: option('native') }
  }
  f.runtime.resumeSession = async (id) => { f.runtime.liveSessions.add(id); return { configOptions: option('native') } }
  f.runtime.setOption = async (_id, config, value) => { assert.equal(config, TOOL_MODE_CONFIG); applied = value; return option(value) }
  f.runtime.prompt = async () => { modes.push(applied); return { stopReason: 'end_turn' } }
  const send = async () => {
    const done = new Promise((resolve) => f.manager.once('turn-finished', resolve))
    await f.manager.send(thread.id, { text: 'team followup' })
    assert.equal((await done).status, 'done')
  }
  assert.equal((await f.manager.get(thread.id)).thread.toolMode, 'ptc')
  await send()
  selected = 'native'
  await send()
  f.runtime.liveSessions.clear()
  f.manager.liveOptions.clear()
  applied = 'native'
  selected = 'ptc'
  await send()
  assert.deepEqual(modes, ['ptc', 'native', 'ptc'])
})

for (const behavior of ['missing', 'wrong', 'error']) {
  test(`PTC selection never sends a prompt when runtime acknowledgement is ${behavior}`, async (t) => {
    const f = await fixture(t)
    await f.manager.update(f.thread.id, { toolMode: 'ptc' })
    f.runtime.setOption = async () => {
      if (behavior === 'error') throw new Error('unknown session config option')
      return behavior === 'missing' ? [] : option('native')
    }
    const done = new Promise((resolve) => f.manager.once('turn-finished', resolve))
    await f.manager.send(f.thread.id, { text: 'must not run' })
    assert.equal((await done).status, 'error')
    assert.equal(f.calls.prompts.length, 0)
  })
}

test('parallel PTC history preserves IDs, ancestry, failures and cancellation; successful writes feed change list', () => {
  const turn = newTurn({ id: 'turn', text: 'test' })
  applyUpdate(turn, { sessionUpdate: 'tool_call', toolCallId: 'root', title: 'run_code' })
  const data = (n) => ({ subCallId: `root:ptc:${n}`, parentCallId: 'root', rootCallId: 'root', name: 'write', arguments: '{"file_path":"a.txt","content":"a"}' })
  for (const n of [1, 2, 3]) applyUpdate(turn, ptcEventUpdate({ type: 'tool/ptc-dispatch-start', data: data(n) }))
  for (const n of [2, 1]) {
    applyUpdate(turn, { ...ptcEventUpdate({ type: 'tool/ptc-dispatch', data: { ...data(n), isError: n === 2 } }), content: [{ type: 'content', content: { type: 'text', text: 'written' } }] })
  }
  assert.deepEqual(turn.items.map((item) => item.id), ['root', 'root:ptc:1', 'root:ptc:2', 'root:ptc:3'])
  assert.equal(turn.items[1].parentCallId, 'root')
  assert.equal(turn.items[1].rootCallId, 'root')
  assert.equal(turn.items[1].status, 'completed')
  assert.equal(turn.items[2].status, 'failed')
  assert.equal(fileChanges(turn).length, 1)
  settleTurn(turn, { status: 'cancelled' })
  assert.equal(turn.items[3].status, 'failed')
})
