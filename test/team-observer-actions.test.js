import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observerSend, observerStop } from '../server/team-observer-actions.js'
import { TeamManager } from '../server/teams.js'

function fixture(kind = 'thread') {
  const calls = []
  const child = { id: 'child', name: '子1', kind, taskId: 'task', closed: false }
  const team = { id: 'team', leaderId: 'leader', leaderKind: 'thread', children: [child] }
  const manager = { teams: new Map([['team', team]]),
    threads: { threads: new Map([['leader', { status: 'idle' }], ['task', { status: 'idle' }]]),
      async send(id, input, options) { calls.push(['send', id, input, options]); return { status: 'accepted', kind: 'send' } },
      async steer(id, input, options) { calls.push(['steer', id, input, options]); return { status: 'accepted', kind: 'steer', steered: true } },
      async cancel(id) { calls.push(['cancel', id]) } },
    agents: { running: () => false },
    async observerQueueThread(id, childId, text) { calls.push(['queue', id, childId, text]) },
    async observerCancelPending() {},
    async observerUserChild(id, childId, action) { const entry = this.teams.get(id).children.find((c) => c.id === childId); if (entry.closed) entry.closed = false; return action() },
    messageChild(id, childId, text, options) { calls.push(['messageChild', id, childId, text, options]) },
    stopChild(id, childId) { calls.push(['stopChild', id, childId]) },
    terminals: { async sendMessage(id, text) { calls.push(['terminalSend', id, text]) }, interrupt(id, client) { calls.push(['interrupt', id, client]); return true } },
  }
  return { manager, team, child, calls }
}

test('messages address the requested leader or dsh child as user input', async () => {
  const { manager, calls } = fixture()
  const result = await observerSend(manager, 'team', 'child', '  指示  ')
  assert.equal(result.target, '子1')
  assert.equal(result.text, '[ユーザーからの指示（観測者経由）]\n指示')
  assert.equal(result.delivery, 'sent')
  assert.equal(calls[0][1], 'task')
  assert.equal(calls[0][3].userInitiated, true)
  manager.threads.threads.get('leader').status = 'running'
  const leader = await observerSend(manager, 'team', 'leader', '続行')
  assert.equal(leader.delivery, 'queued')
  assert.deepEqual(calls[1].slice(0, 3), ['queue', 'team', null])
})
test('a busy dsh child gets a queued user instruction, not a leader send', async () => {
  const { manager, calls } = fixture()
  manager.threads.threads.get('task').status = 'running'
  const result = await observerSend(manager, 'team', 'child', '待ってから')
  assert.equal(result.delivery, 'queued')
  assert.equal(calls[0][0], 'queue')
  assert.match(calls[0][3], /ユーザーからの指示/)
})

test('leader messages wait while fallback is in progress', async () => {
  const { manager, calls } = fixture()
  manager.fallingBack = new Set(['team'])
  const result = await observerSend(manager, 'team', 'leader', '続けて')
  assert.equal(result.delivery, 'queued')
  assert.equal(calls[0][0], 'queue')
})

test('an awaiting child is queued even before its runtime starts', async () => {
  for (const kind of ['thread', 'agent']) {
    const { manager, child, calls } = fixture(kind)
    child.awaiting = true
    const result = await observerSend(manager, 'team', 'child', '後から')
    assert.equal(result.delivery, 'queued')
    assert.equal(calls[0][0], kind === 'thread' ? 'queue' : 'messageChild')
  }
})

test('Claude child uses direct-message queue, terminal leader uses direct send', async () => {
  const { manager, team, calls } = fixture('agent')
  manager.agents.running = () => true
  assert.equal((await observerSend(manager, 'team', 'child', '確認')).delivery, 'queued')
  assert.equal(calls[0][0], 'messageChild')
  assert.deepEqual(calls[0][4], { source: 'observer' })
  team.leaderKind = 'terminal'
  await observerSend(manager, 'team', 'leader', '指示')
  assert.equal(calls[1][0], 'terminalSend')
})
test('uncertain and refused sends are never reported as successful', async () => {
  const { manager, child } = fixture()
  manager.threads.send = async () => ({ status: 'uncertain' })
  assert.equal((await observerSend(manager, 'team', 'child', 'x')).delivery, 'uncertain')
  manager.threads.threads.get('leader').status = 'idle'
  manager.threads.send = async () => ({ status: 'failed' })
  await assert.rejects(observerSend(manager, 'team', 'leader', 'x'), /受領結果を確認できません/)
  child.closed = true
  manager.threads.threads.get('task').status = 'idle'
  manager.threads.send = async () => ({ status: 'accepted', kind: 'send' })
  assert.equal((await observerSend(manager, 'team', 'child', 'x')).delivery, 'sent')
  assert.equal(child.closed, false)
  await assert.rejects(observerSend(manager, 'team', 'child', ''), /送る内容/)
})
test('authenticated observer dispatch rejects leader capability before any action', async () => {
  const { manager, team, calls } = fixture()
  Object.setPrototypeOf(manager, TeamManager.prototype)
  team.secret = 'leader-capability'
  team.observer = { secret: 'observer-capability' }
  await assert.rejects(manager.observerCall('team', 'leader-capability', 'send', { target: 'child', message: 'x' }), { status: 403 })
  assert.equal(calls.length, 0)
  const result = JSON.parse(await manager.observerCall('team', 'observer-capability', 'send', { target: 'child', message: 'x' }))
  assert.equal(result.delivery, 'sent')
  assert.equal(calls[0][1], 'task')
})

test('stop uses the recipient user-facing stop path and validates scope', async () => {
  const { manager, team, calls } = fixture('agent')
  await observerStop(manager, 'team', 'child')
  await observerStop(manager, 'team', 'leader')
  team.leaderKind = 'terminal'
  await observerStop(manager, 'team', 'leader')
  assert.deepEqual(calls, [['stopChild', 'team', 'child'], ['cancel', 'leader'], ['interrupt', 'leader', null]])
  await assert.rejects(observerStop(manager, 'team', 'missing'), /見つかりません/)
  team.execution = {}
  await assert.rejects(observerStop(manager, 'team', 'leader'), /TM/)
})
