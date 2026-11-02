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
    observerMessageAgent(id, childId, text) { calls.push(['observerMessageAgent', id, childId, text]); return { delivery: this.agents.running() ? 'uncertain' : child.awaiting ? 'queued' : 'sent' } },
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
  assert.equal(leader.delivery, 'sent')
  assert.equal(leader.method, 'steer')
  assert.deepEqual(calls[1].slice(0, 2), ['steer', 'leader'])
})
test('a busy dsh child receives a user instruction by steer', async () => {
  const { manager, calls } = fixture()
  manager.threads.threads.get('task').status = 'running'
  const result = await observerSend(manager, 'team', 'child', '作業を区切って')
  assert.equal(result.delivery, 'sent')
  assert.equal(result.method, 'steer')
  assert.equal(calls[0][0], 'steer')
  assert.match(calls[0][2].text, /ユーザーからの指示/)
  assert.ok(calls[0][2].messageId)
  assert.equal(calls[0][3].userInitiated, true)
})

test('unavailable steer queues the instruction and uncertain steer never retries', async () => {
  const { manager, calls } = fixture()
  manager.threads.threads.get('task').status = 'running'
  manager.threads.steer = async () => ({ steered: false })
  assert.equal((await observerSend(manager, 'team', 'child', '待機')).delivery, 'queued')
  assert.equal(calls[0][0], 'queue')
  calls.length = 0
  for (const result of [{ status: 'uncertain', steered: true }, { status: 'uncertain' }]) {
    manager.threads.steer = async () => result
    assert.equal((await observerSend(manager, 'team', 'child', '確認')).delivery, 'uncertain')
    assert.deepEqual(calls, [])
  }
  manager.threads.steer = async () => ({})
  await assert.rejects(observerSend(manager, 'team', 'child', '確認'), /受領結果を確認できません/)
  assert.deepEqual(calls, [])
})

test('steer fallback checks that the recipient did not change', async () => {
  const { manager, child, calls } = fixture()
  manager.threads.threads.get('task').status = 'running'
  manager.threads.steer = async () => { child.taskId = 'other'; return { steered: false } }
  await assert.rejects(observerSend(manager, 'team', 'child', '確認'), /宛先が変更/)
  assert.deepEqual(calls, [])
})

test('stopping during a rejected steer prevents a later queued send', async () => {
  for (const stopAll of [false, true]) {
    const { manager, team, calls } = fixture()
    manager.threads.threads.get('task').status = 'running'
    let release
    manager.threads.steer = () => new Promise((resolve) => { release = resolve })
    const sending = observerSend(manager, 'team', 'child', '区切って')
    if (stopAll) team.stopVersion = (team.stopVersion ?? 0) + 1
    else await observerStop(manager, 'team', 'child')
    release({ steered: false })
    await assert.rejects(sending, /停止されたため/)
    assert.equal(calls.some((call) => call[0] === 'queue'), false)
  }
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
    assert.equal(calls[0][0], kind === 'thread' ? 'queue' : 'observerMessageAgent')
  }
})

test('Claude child reports an attempted steer as uncertain, terminal leader uses direct send', async () => {
  const { manager, team, calls } = fixture('agent')
  manager.agents.running = () => true
  const result = await observerSend(manager, 'team', 'child', '確認')
  assert.equal(result.delivery, 'uncertain')
  assert.equal(result.method, 'steer')
  assert.equal(calls[0][0], 'observerMessageAgent')
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
