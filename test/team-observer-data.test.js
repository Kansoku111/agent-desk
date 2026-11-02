import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observerChildTurns, observerStatus } from '../server/team-observer-data.js'
import { TeamManager } from '../server/teams.js'

function fixture(kind = 'thread') {
  const calls = []
  const child = { id: 'child', name: '子1', kind, taskId: 'task' }
  const team = { id: 'team', leaderId: 'leader', leaderKind: 'thread', children: [child], queue: [{ id: 'q', text: '待機中' }] }
  const turns = Array.from({ length: 12 }, (_, i) => ({ id: String(i), status: 'done', user: { text: 'request ' + i }, items: [
    { type: 'thought', text: 'private thought' }, { type: 'tool', output: 'tool output' }, { type: 'agent', text: 'answer ' + i },
  ] }))
  const manager = {
    teams: new Map([['team', team]]),
    summary: () => ({ children: [{ ...child, title: '仕事', state: 'idle', updatedAt: 4, lastReport: { text: '報告' }, pending: 0 }], delivery: 'waiting', queue: [{ id: 'q' }], approvals: [], asks: [] }),
    threads: { threads: new Map([['leader', { status: 'idle', updatedAt: 3 }]]), async get(id) { calls.push(['get', id]); return { turns } } },
    agents: { turns(id) { calls.push(['turns', id]); return turns } },
  }
  return { manager, team, turns, calls }
}

test('status only reads saved state and does not consume queued reports', () => {
  const { manager, calls } = fixture()
  const snapshot = observerStatus(manager, 'team')
  assert.equal(snapshot.leader.state, 'idle')
  assert.equal(snapshot.children[0].lastReport.text, '報告')
  assert.deepEqual(snapshot.queue, [{ id: 'q', childId: undefined, kind: undefined, at: undefined, preview: '待機中' }])
  assert.equal(snapshot.queueCount, 1)
  assert.equal(snapshot.observerOutboxCount, 0)
  assert.deepEqual(calls, [])
})

for (const kind of ['thread', 'agent']) test(kind + ' child conversation is limited to recent user and agent messages', async () => {
  const { manager, calls } = fixture(kind)
  const result = await observerChildTurns(manager, 'team', 'child', 2)
  assert.deepEqual(result.turns.map((turn) => turn.id), ['10', '11'])
  assert.deepEqual(result.turns[1].messages, ['answer 11'])
  assert.equal(result.limited, true)
  assert.deepEqual(calls, [[kind === 'thread' ? 'get' : 'turns', 'task']])
  assert.doesNotMatch(JSON.stringify(result), /private thought|tool output/)
})

test('TeamManager exposes the readers without leader tools', async () => {
  const { manager } = fixture()
  Object.setPrototypeOf(manager, TeamManager.prototype)
  assert.equal(manager.observerStatus('team').children[0].name, '子1')
  assert.equal((await manager.observerChildTurns('team', 'child', 1)).turns.length, 1)
})

test('omitted assistant messages are disclosed even within the turn limit', async () => {
  const { manager, turns } = fixture()
  turns.splice(0, 11)
  turns[0].items = Array.from({ length: 11 }, (_, i) => ({ type: 'agent', text: String(i) }))
  const result = await observerChildTurns(manager, 'team', 'child', 1)
  assert.equal(result.limited, true)
  assert.equal(result.turns[0].messages.length, 10)
})

test('a child removed while the transcript loads is not returned', async () => {
  const { manager, team } = fixture()
  manager.threads.get = async () => { team.children = []; return { turns: [] } }
  await assert.rejects(observerChildTurns(manager, 'team', 'child'), /見つかりません/)
})

test('a replaced child conversation is not returned after loading', async () => {
  const { manager, team } = fixture()
  manager.threads.get = async () => { team.children[0].taskId = 'replacement'; return { turns: [] } }
  await assert.rejects(observerChildTurns(manager, 'team', 'child'), /見つかりません/)
})

test('observer capability cannot use the leader secret or eco teams', async () => {
  const { manager, team } = fixture()
  Object.setPrototypeOf(manager, TeamManager.prototype)
  team.secret = 'leader-secret'
  team.observer = { secret: 'observer-secret' }
  await assert.rejects(manager.observerCall('team', 'leader-secret', 'status', {}), { status: 403 })
  await assert.rejects(manager.observerCall('team', '', 'status', {}), { status: 403 })
  const result = JSON.parse(await manager.observerCall('team', 'observer-secret', 'status', {}))
  assert.equal(result.children[0].name, '子1')
  await assert.rejects(manager.observerCall('team', 'observer-secret', 'spawn', {}), /unknown observer tool/)
  team.observer.secret = team.secret
  await assert.rejects(manager.observerCall('team', 'leader-secret', 'status', {}), { status: 403 })
  team.observer.secret = 'observer-secret'
  team.execution = {}
  await assert.rejects(manager.observerCall('team', 'observer-secret', 'status', {}), { status: 403 })
})

test('status includes bounded previews of delivery in flight and queued reports without consuming them', () => {
  const { manager, team } = fixture()
  const items = [{ id: 'in-flight', text: 'report' }]
  manager.delivering = new Map([['team', { items }]])
  team.queue = Array.from({ length: 21 }, (_, i) => ({ id: String(i), text: 'x'.repeat(500) }))
  const snapshot = observerStatus(manager, 'team')
  assert.equal(snapshot.queueCount, 22)
  assert.equal(snapshot.queueOmitted, 2)
  assert.equal(snapshot.queue.length, 20)
  assert.equal(snapshot.queue[0].preview.length, 300)
  assert.equal(team.queue.length, 21)
  assert.equal(items.length, 1)
})

test('pending user questions are presented as bounded previews', () => {
  const { manager } = fixture()
  const original = manager.summary
  manager.summary = (team) => ({ ...original(team), asks: Array.from({ length: 12 }, (_, i) => ({ id: String(i), text: 'q'.repeat(1000) })) })
  const snapshot = observerStatus(manager, 'team')
  assert.equal(snapshot.asksCount, 12)
  assert.equal(snapshot.asksOmitted, 2)
  assert.equal(snapshot.asks[0].preview.length, 300)
})

test('status uses saved task updates without asking an agent', () => {
  const { manager, calls } = fixture()
  manager.threads.threads.set('task', { status: 'running', updatedAt: 20 })
  assert.equal(observerStatus(manager, 'team').children[0].updatedAt, 20)
  assert.deepEqual(calls, [])
})

test('terminal state and activity stay distinct', () => {
  const { manager, team } = fixture()
  team.leaderKind = 'terminal'
  manager.terminals = { status: () => ({ state: 'exited', activity: 'idle' }), records: new Map([['leader', { updatedAt: 50 }]]) }
  assert.equal(observerStatus(manager, 'team').leader.updatedAt, 50)
  assert.equal(observerStatus(manager, 'team').leader.state, 'exited')
  assert.equal(observerStatus(manager, 'team').leader.activity, 'idle')
})

test('conversation validates scope, count, and bounds output', async () => {
  const { manager, team, turns } = fixture()
  await assert.rejects(observerChildTurns(manager, 'team', 'child', 11), /1〜10/)
  await assert.rejects(observerChildTurns(manager, 'team', 'other'), /見つかりません/)
  turns[11].user.text = 'x'.repeat(50000)
  turns[11].items = Array.from({ length: 20 }, () => ({ type: 'agent', text: 'y'.repeat(50000) }))
  const result = await observerChildTurns(manager, 'team', 'child', 10)
  assert.ok(JSON.stringify(result).length < 14000)
  assert.equal(result.limited, true)
  team.execution = {}
  assert.throws(() => observerStatus(manager, 'team'), /TM/)
  await assert.rejects(observerChildTurns(manager, 'team', 'child'), /TM/)
})
