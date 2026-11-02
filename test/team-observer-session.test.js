import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { TeamManager } from '../server/teams.js'
import { TEAM_DEFAULTS } from '../server/team-config.js'
import { restoreTeams } from '../server/teams-store.js'

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'observer-session-'))
  const workspace = path.join(dir, 'workspace'); await fs.mkdir(workspace)
  const calls = []
  const threads = Object.assign(new EventEmitter(), { threads: new Map([['leader', { id: 'leader', status: 'idle' }]]), turns: new Map(), removing: new Map(),
    async checkUsageFallbackModel(model) { calls.push(['check', model]) },
    async create(options) { calls.push(['thread-create', options]); const item = { ...options, id: 'observer-thread', status: 'idle' }; this.threads.set(item.id, item); this.turns.set(item.id, []); return item },
    async update(id, patch) { calls.push(['thread-update', id, patch]); Object.assign(this.threads.get(id), patch) },
    async send(id, input, options = {}) { options.guard?.(); calls.push(['thread-send', id, input, options.userInitiated]); this.turns.get(id).push({ id: 'turn', user: { text: input.text }, items: [] }); return { status: 'accepted', kind: 'send' } },
    async get(id) { return { turns: this.turns.get(id) } },
    async cancel(id) { calls.push(['cancel', id]) },
    async setGoalWaiting() {},
    async remove(id) { calls.push(['thread-remove', id]); this.threads.delete(id) },
  })
  const terminals = Object.assign(new EventEmitter(), { records: new Map(), status: () => null })
  const agents = Object.assign(new EventEmitter(), { records: new Map(),
    async create(options) { calls.push(['agent-create', options]); const item = { ...options, id: 'observer-agent', state: 'idle', turns: [] }; this.records.set(item.id, item); return item },
    get(id) { return this.records.get(id) }, turns(id) { return this.records.get(id)?.turns }, running(id) { return this.records.get(id)?.state === 'running' },
    stop(id) { calls.push(['agent-stop', id]); this.records.get(id).state = 'idle'; return true },
    async setArgs(id, args) { calls.push(['set-args', id, args]) },
    async configure(id, choice) { calls.push(['configure', id, choice]) },
    run(id, text, options) { calls.push(['agent-run', id, text, options]); this.records.get(id).turns.push({ id: 'claude-turn', user: { text }, items: [] }) },
    async remove(id) { calls.push(['agent-remove', id]); this.records.delete(id) },
  })
  const model = JSON.stringify(['openai-codex', 'gpt-6-luna'])
  const catalog = { data: { models: [{ value: model, provider: 'openai-codex', id: 'gpt-6-luna' }] } }
  const manager = new TeamManager({ file: path.join(dir, 'teams.json'), dir: path.join(dir, 'teams'), threads, terminals, agents, catalog, getSettings: () => TEAM_DEFAULTS, apiUrl: () => 'http://127.0.0.1:1000/api/team' })
  manager.claudeAuth = { context: () => ({}), guard: async () => null }
  const team = { id: 't', workspace, leaderId: 'leader', leaderKind: 'thread', secret: 'leader-secret', config: TEAM_DEFAULTS, children: [], queue: [], asks: [] }
  manager.teams.set('t', team)
  t.after(async () => { await manager.writes; await fs.rm(dir, { recursive: true, force: true }) })
  return { manager, team, calls, model, threads, agents }
}

test('opening observer creates nothing; a user prompt creates only its own thread', async (t) => {
  const { manager, team, calls, model, threads } = await fixture(t)
  assert.deepEqual(await manager.observerTurns('t'), { segments: [], running: false })
  assert.deepEqual(calls, [])
  await assert.rejects(manager.observerMessage('t', { text: 'hi' }), /モデル/)
  await manager.observerMessage('t', { model, effort: 'low', text: '状況は？' })
  assert.deepEqual(calls.map((entry) => entry[0]), ['check', 'thread-create', 'thread-send'])
  assert.equal(calls[1][1].team.role, 'observer')
  assert.equal(calls[1][1].toolMode, 'native')
  assert.equal(threads.teamModelGuard(threads.threads.get('observer-thread')), true)
  assert.equal(calls[2][3], true)
  assert.notEqual(team.observer.secret, team.secret)
  assert.equal(threads.threads.get('leader').status, 'idle')
  assert.equal((await manager.observerTurns('t')).segments[0].turns[0].user.text, '状況は？')
  assert.equal(manager.summary(team).observer.secret, undefined)
  const saved = JSON.parse(await fs.readFile(manager.file, 'utf8'))
  const [restored] = restoreTeams(saved, () => TEAM_DEFAULTS)
  assert.equal(restored.observer.id, 'observer-thread')
  assert.equal(restored.observer.secret, team.observer.secret)
})

test('changing model within dsh updates the same conversation without fallback', async (t) => {
  const { manager, team, calls, model, threads } = await fixture(t)
  const other = JSON.stringify(['openai-codex', 'gpt-6.1-sol'])
  manager.catalog.data.models.push({ value: other, provider: 'openai-codex', id: 'gpt-6.1-sol' })
  await manager.observerMessage('t', { model, effort: 'low', text: '最初' })
  const id = team.observer.id
  await manager.observerMessage('t', { model: other, effort: 'high', text: '続き' })
  assert.equal(team.observer.id, id)
  assert.equal(threads.threads.get(id).model, other)
  assert.equal(calls.filter((entry) => entry[0] === 'thread-create').length, 1)
  manager.catalog.data.models = []
  await assert.rejects(manager.observerMessage('t', { model: other, effort: 'high', text: '再度' }), /選び直し/)
  assert.equal(team.observer.model, other)
})

test('switching to Claude preserves earlier chat and checks billing before launch', async (t) => {
  const { manager, team, calls, model } = await fixture(t)
  await manager.observerMessage('t', { model, effort: 'low', text: '最初' })
  const previousSecret = team.observer.secret
  await manager.observerMessage('t', { model: 'claude:haiku', effort: 'low', text: '続き' })
  assert.notEqual(team.observer.secret, previousSecret)
  assert.equal(team.observer.kind, 'agent')
  assert.deepEqual(team.observer.history, [{ id: 'observer-thread', kind: 'thread' }])
  const args = calls.find((entry) => entry[0] === 'set-args')[2]
  assert.ok(args.includes('--strict-mcp-config'))
  assert.ok(args.includes('--tools'))
  assert.ok(args.includes('mcp__observer'))
  assert.equal(calls.at(-1)[0], 'agent-run')
  assert.match(calls.at(-1)[3].blocks[0].text, /最初/)
  assert.match(team.observer.carryover, /not a new authorization/)
  assert.equal((await manager.observerTurns('t')).segments.length, 2)
  manager.agents.emit('finished', { id: 'observer-agent', status: 'done' })
  assert.equal(team.observer.carryover, undefined)
  assert.equal(await manager.guardClaudeLaunch({ record: { id: 'observer-agent' }, cwd: team.workspace }), null)
})

test('a reopened child reports a direct user request as an additional report', async (t) => {
  const { manager, team, threads } = await fixture(t)
  const child = { id: 'child', name: '子1', title: '作業', kind: 'thread', taskId: 'child-task', closed: true, awaiting: false, reports: [], pending: [], followups: [], provider: 'gpt', model: 'gpt-6-luna', createdAt: 1, updatedAt: 1 }
  team.children.push(child)
  threads.threads.set('child-task', { id: 'child-task', status: 'idle' })
  threads.threads.get('leader').status = 'running'
  threads.turns.set('child-task', [])
  team.observer = { id: 'observer', kind: 'thread', model: 'model', secret: 'observer-secret' }
  const result = JSON.parse(await manager.observerCall('t', 'observer-secret', 'send', { target: 'child', message: '続きを確認' }))
  assert.equal(result.delivery, 'sent')
  assert.equal(child.closed, false)
  threads.turns.get('child-task')[0].items.push({ type: 'agent', text: '結果' })
  threads.emit('turn-finished', { threadId: 'child-task', status: 'done' })
  assert.equal(team.queue.length, 1)
  assert.equal(team.queue[0].unasked, true)
  assert.equal(team.queue[0].text, '結果')
})

test('busy dsh child receives queued user message after its current report', async (t) => {
  const { manager, team, threads } = await fixture(t)
  const child = { id: 'child', name: '子1', title: '作業', kind: 'thread', taskId: 'child-task', closed: false, awaiting: true, reports: [], pending: [], followups: [], provider: 'gpt', model: 'gpt-6-luna', createdAt: 1, updatedAt: 1 }
  team.children.push(child)
  threads.threads.get('leader').status = 'running'
  threads.threads.set('child-task', { id: 'child-task', status: 'running' })
  threads.turns.set('child-task', [{ id: 'old', user: { text: '元の作業' }, items: [{ type: 'agent', text: '元の結果' }] }])
  team.observer = { id: 'observer', kind: 'thread', model: 'model', secret: 'observer-secret' }
  let resolveSend
  const sent = new Promise((resolve) => { resolveSend = resolve })
  threads.send = async (id, input, options) => { options.guard(); assert.equal(options.userInitiated, true); threads.threads.get(id).status = 'running'; threads.turns.get(id).push({ id: 'new', user: { text: input.text }, items: [{ type: 'agent', text: '追加結果' }] }); resolveSend(input); return { status: 'accepted', kind: 'send' } }
  const queued = JSON.parse(await manager.observerCall('t', 'observer-secret', 'send', { target: 'child', message: '追加の依頼' }))
  assert.equal(queued.delivery, 'queued')
  assert.equal(team.observerOutbox[0].state, 'queued')
  threads.threads.get('child-task').status = 'idle'
  threads.emit('turn-finished', { threadId: 'child-task', status: 'done' })
  const input = await sent
  assert.match(input.text, /追加の依頼/)
  await new Promise((resolve) => setImmediate(resolve))
  await manager.writes
  assert.equal(team.observerOutbox.length, 0)
  threads.threads.get('child-task').status = 'idle'
  threads.emit('turn-finished', { threadId: 'child-task', status: 'done' })
  assert.equal(team.queue.length, 2)
  assert.equal(team.queue[1].unasked, true)
  assert.equal(team.queue[1].text, '追加結果')
})

test('busy dsh leader receives the queued user instruction after its turn', async (t) => {
  const { manager, team, threads } = await fixture(t)
  threads.threads.get('leader').status = 'running'
  threads.turns.set('leader', [{ id: 'leader-turn', items: [], status: 'done' }])
  team.observer = { id: 'observer', kind: 'thread', model: 'model', secret: 'observer-secret' }
  let resolveSend
  const sent = new Promise((resolve) => { resolveSend = resolve })
  threads.send = async (id, input, options) => { options.guard(); assert.equal(options.userInitiated, true); resolveSend({ id, input }); return { status: 'accepted', kind: 'send' } }
  const queued = JSON.parse(await manager.observerCall('t', 'observer-secret', 'send', { target: 'leader', message: '親への依頼' }))
  assert.equal(queued.delivery, 'queued')
  assert.equal(team.observerOutbox[0].childId, null)
  threads.threads.get('leader').status = 'idle'
  threads.emit('turn-finished', { threadId: 'leader', status: 'done' })
  const result = await sent
  assert.equal(result.id, 'leader')
  assert.match(result.input.text, /親への依頼/)
  await new Promise((resolve) => setImmediate(resolve))
  await manager.writes
  assert.equal(team.observerOutbox.length, 0)
})

test('stop all discards queued observer instructions without starting them', async (t) => {
  const { manager, team, threads, calls } = await fixture(t)
  const child = { id: 'child', name: '子1', title: '作業', kind: 'thread', taskId: 'child-task', closed: false, awaiting: true, reports: [], pending: [], followups: [], provider: 'gpt', model: 'gpt-6-luna', createdAt: 1, updatedAt: 1 }
  team.children.push(child)
  threads.threads.set('child-task', { id: 'child-task', status: 'running' })
  threads.turns.set('child-task', [{ id: 'old', user: { text: '作業' }, items: [] }])
  team.observer = { id: 'observer', kind: 'thread', model: 'model', secret: 'observer-secret' }
  await manager.observerCall('t', 'observer-secret', 'send', { target: 'child', message: '追加' })
  await manager.stopAll('t')
  assert.deepEqual(team.observerOutbox, [])
  threads.threads.get('child-task').status = 'idle'
  threads.emit('turn-finished', { threadId: 'child-task', status: 'cancelled' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.filter((entry) => entry[0] === 'thread-send' && entry[1] === 'child-task').length, 0)
})

test('stopping a Claude child cancels only its observer-origin followup', async (t) => {
  const { manager, team, agents } = await fixture(t)
  const child = { id: 'child', name: '子1', title: '作業', kind: 'agent', taskId: 'child-agent', closed: false, awaiting: true, reports: [], pending: [], followups: [{ id: 'direct', text: '直接入力' }], provider: 'claude', model: 'haiku', createdAt: 1, updatedAt: 1 }
  team.children.push(child)
  agents.records.set('child-agent', { id: 'child-agent', state: 'running', turns: [] })
  team.observer = { id: 'observer', kind: 'thread', model: 'model', secret: 'observer-secret' }
  const queued = JSON.parse(await manager.observerCall('t', 'observer-secret', 'send', { target: 'child', message: '追加' }))
  assert.equal(queued.delivery, 'queued')
  assert.equal(child.followups[1].source, 'observer')
  await manager.observerCall('t', 'observer-secret', 'stop', { target: 'child' })
  assert.deepEqual(child.followups, [{ id: 'direct', text: '直接入力' }])
  assert.equal(agents.running('child-agent'), false)
})

test('restart never replays an uncertain observer dispatch', async (t) => {
  const { manager, team, threads, calls } = await fixture(t)
  const child = { id: 'child', name: '子1', title: '作業', kind: 'thread', taskId: 'child-task', closed: false, awaiting: false, reports: [], pending: [], followups: [], provider: 'gpt', model: 'gpt-6-luna', createdAt: 1, updatedAt: 1 }
  team.children.push(child)
  threads.threads.set('child-task', { id: 'child-task', status: 'idle' })
  team.observerOutbox = [{ id: 'message', childId: 'child', taskId: 'child-task', text: '依頼', state: 'sending' }]
  manager.start()
  await manager.writes
  assert.equal(team.observerOutbox[0].state, 'uncertain')
  assert.equal(calls.filter((entry) => entry[0] === 'thread-send').length, 0)
})

test('a changed queued destination is marked unsent, never rerouted', async (t) => {
  const { manager, team, threads, calls } = await fixture(t)
  const child = { id: 'child', name: '子1', title: '作業', kind: 'thread', taskId: 'replacement', closed: false, awaiting: false, reports: [], pending: [], followups: [], provider: 'gpt', model: 'gpt-6-luna', createdAt: 1, updatedAt: 1 }
  team.children.push(child)
  threads.threads.set('replacement', { id: 'replacement', status: 'idle' })
  team.observerOutbox = [{ id: 'message', childId: 'child', taskId: 'old-task', text: '依頼', state: 'queued' }]
  manager.start()
  await new Promise((resolve) => setImmediate(resolve))
  await manager.writes
  assert.equal(team.observerOutbox[0].state, 'failed')
  assert.match(team.observerOutbox[0].error, /送信していません/)
  assert.equal(calls.filter((entry) => entry[0] === 'thread-send').length, 0)
})

test('invalid choices and denied Claude billing do not create sessions', async (t) => {
  const { manager, calls } = await fixture(t)
  await assert.rejects(manager.observerMessage('t', { model: 'not-present', text: 'hi' }), /選び直し/)
  manager.claudeAuth.guard = async () => '課金確認が必要です'
  await assert.rejects(manager.observerMessage('t', { model: 'claude:haiku', text: 'hi' }), /課金確認/)
  assert.equal(calls.some((entry) => entry[0].endsWith('create')), false)
})
