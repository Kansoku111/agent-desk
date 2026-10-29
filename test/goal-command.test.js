import assert from 'node:assert/strict'
import { test } from 'node:test'
import { goalCommandObjective, applyGoalCommand, GOAL_OBJECTIVE_META } from '../server/goal-command.js'
import { AcpRuntime } from '../server/runtime.js'
import { fixture } from './helpers/thread-manager.js'

test('/goal accepts case, whitespace and multiline objectives without matching ordinary text', () => {
  assert.equal(goalCommandObjective(' /GOAL\n画面を直す\nテストする '), '画面を直す\nテストする')
  for (const text of ['ordinary request', 'Explain /goal usage', '/goals fix', '/goal.txt', '```\n/goal example\n```']) assert.equal(goalCommandObjective(text), undefined)
  for (const text of ['/goal', '/GOAL \n']) assert.throws(() => goalCommandObjective(text), /使い方/)
})

test('command registers a domain goal and supplies its identity, without replacing unfinished goals', () => {
  let current, creates = 0
  const goals = { get: () => current, create: (_agent, spec) => {
    creates++
    return current = { ...spec, id: 'goal-fixture', revision: 1, maxGoalRounds: 256, phase: 'active' }
  } }
  const ctx = { get: () => goals }, agent = {}, content = []
  applyGoalCommand(ctx, agent, ' objective ', content)
  assert.equal(creates, 1)
  assert.equal(current.objective, 'objective')
  assert.match(content[0].text, /already created and armed/)
  assert.match(content[0].text, /goal-fixture/)
  for (const phase of ['active', 'paused', 'blocked']) {
    current.phase = phase
    assert.throws(() => applyGoalCommand(ctx, agent, 'replacement', []), /既存の目標/)
  }
  assert.equal(creates, 1)
  current.phase = 'complete'
  applyGoalCommand(ctx, agent, 'next goal', [])
  assert.equal(creates, 2)
  assert.throws(() => applyGoalCommand({ get: () => null }, agent, 'objective', []), /利用できません/)
  assert.throws(() => applyGoalCommand(ctx, agent, ' ', []), /non-empty/)
})

test('runtime fails closed without the command hook and sends metadata only for explicit commands', async () => {
  const runtime = new AcpRuntime({ mode: 'workspace-write', paths: {} })
  const sent = []
  runtime.state = 'ready'
  runtime.conn = { prompt: async (params) => { sent.push(params); return { stopReason: 'end_turn' } } }
  const blocks = [{ type: 'text', text: '/goal objective' }]
  assert.throws(() => runtime.prompt('session', blocks, 'objective'), /実行機能を確認できません/)
  assert.equal(sent.length, 0)
  await runtime.prompt('session', blocks)
  assert.equal(sent[0]._meta, undefined)
  runtime.goalCommandSupported = true
  await runtime.prompt('session', blocks, 'objective')
  assert.deepEqual(sent[1]._meta, { [GOAL_OBJECTIVE_META]: 'objective' })
})

for (const team of [undefined, { id: 'eco', role: 'leader' }, { id: 'tm', role: 'leader' }]) {
  test(`human commands reach prompt admission once (${team?.id ?? 'ordinary'})`, async (t) => {
    const f = await fixture(t)
    if (team) f.manager.threads.get(f.thread.id).team = team
    const prompt = t.mock.method(f.runtime, 'prompt', async () => { f.started.resolve(); await f.finish.promise; return { stopReason: 'end_turn' } })
    const input = { text: '/GOAL finish the objective', messageId: '00000000-0000-4000-8000-000000000001' }
    await f.manager.send(f.thread.id, input, { userInitiated: true })
    await f.started.promise
    assert.equal(prompt.mock.calls[0].arguments[2], 'finish the objective')
    const receipt = await f.manager.send(f.thread.id, input, { userInitiated: true })
    assert.equal(receipt.status, 'accepted')
    assert.equal(prompt.mock.calls.length, 1)
    assert.equal((await f.manager.get(f.thread.id)).turns[0].user.text, input.text)
  })
}

test('a new conversation recognizes /goal and its creation receipt prevents a second command', async (t) => {
  const f = await fixture(t)
  const prompt = t.mock.method(f.runtime, 'prompt', async () => { f.started.resolve(); await f.finish.promise; return { stopReason: 'end_turn' } })
  const request = {
    createId: '00000000-0000-4000-8000-000000000003', payloadHash: 'a'.repeat(64),
    options: { workspace: f.base, model: '["test","model"]', toolMode: 'native' }, message: { text: '/goal first objective' },
  }
  const created = await f.manager.createWithFirstMessage(request)
  await f.started.promise
  assert.equal(prompt.mock.calls[0].arguments[2], 'first objective')
  const duplicate = await f.manager.createWithFirstMessage(request)
  assert.equal(duplicate.thread.id, created.thread.id)
  assert.equal(prompt.mock.calls.length, 1)
})

test('internal reports cannot create a goal even when their text starts with /goal', async (t) => {
  const f = await fixture(t)
  const prompt = t.mock.method(f.runtime, 'prompt', async () => { f.started.resolve(); await f.finish.promise; return { stopReason: 'end_turn' } })
  await f.manager.send(f.thread.id, { text: '/goal child report' })
  await f.started.promise
  assert.equal(prompt.mock.calls[0].arguments.length, 2)
})

test('invalid and unsupported commands are rejected before a turn is persisted', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.manager.send(f.thread.id, { text: '/goal' }, { userInitiated: true }), /使い方/)
  await assert.rejects(f.manager.send(f.thread.id, { text: '/goal objective', plan: true }, { userInitiated: true }), /Plan/)
  const thread = f.manager.threads.get(f.thread.id)
  for (const patch of [{ ab: { writable: true } }, { team: { id: 'eco', childId: 'child' } }]) {
    Object.assign(thread, patch)
    await assert.rejects(f.manager.send(f.thread.id, { text: '/goal objective' }, { userInitiated: true }), /AB・子/)
    delete thread.ab
    delete thread.team
  }
  assert.equal((await f.manager.get(f.thread.id)).turns.length, 0)
  assert.equal(f.calls.prompts.length, 0)
})

test('commands cannot interrupt a live turn and remain available for normal queued delivery', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'ongoing work' })
  await f.started.promise
  const input = { text: '/goal next objective', messageId: '00000000-0000-4000-8000-000000000002' }
  assert.deepEqual(await f.manager.steer(f.thread.id, input, { userInitiated: true }), { steered: false })
  assert.equal(f.calls.steers.length, 0)
  assert.deepEqual(await f.manager.messageStatus(f.thread.id, input.messageId), { status: 'missing' })
  const active = f.manager.active.get(f.thread.id)
  f.finish.resolve()
  await active.done
  const prompt = t.mock.method(f.runtime, 'prompt', async () => ({ stopReason: 'end_turn' }))
  await f.manager.send(f.thread.id, input, { userInitiated: true })
  await f.manager.active.get(f.thread.id).done
  assert.equal(prompt.mock.calls[0].arguments[2], 'next objective')
})
