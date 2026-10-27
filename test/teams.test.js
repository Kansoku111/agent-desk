import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DELIVERY_CHECK_MS, DELIVERY_GIVE_UP_MS, LEADER_SETTLE_MS, MCP_SERVER, PREFIX, REPORT_PREVIEW, REPORT_GATHER_MS, RESUME_DELAY_MS, TeamManager, TYPING_QUIET_MS, describeTool, transientError } from '../server/teams.js'
import { assertChildrenOn, mergeTeamConfig, teamConfig, TEAM_DEFAULTS } from '../server/team-config.js'
import { AbRunner } from '../server/ab-runner.js'
import { createMcpServerList } from '../server/mcp-servers.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** dsh tasks as the team sees them: create, send, steer, and the events a turn makes. */
function fakeThreads() {
  const threads = Object.assign(new EventEmitter(), {
    threads: new Map(),
    turns: new Map(),
    calls: [],
    goalWaitCalls: [],
    permissions: [],
    removing: new Map(),
    async create(options) {
      const thread = { id: `thread-${threads.threads.size + 1}`, title: '新しいタスク', status: 'idle', pendingApproval: false, ...options }
      threads.threads.set(thread.id, thread)
      threads.turns.set(thread.id, [])
      threads.calls.push(['create', options])
      threads.emit('thread', { ...thread })
      return { ...thread }
    },
    async send(id, { text }, { guard } = {}) {
      guard?.()
      threads.calls.push(['send', id, text])
      const thread = threads.threads.get(id)
      thread.status = 'running'
      threads.turns.get(id).push({ id: `turn-${Date.now()}`, items: [], status: 'running' })
      return { status: 'accepted' }
    },
    async update(id, patch) {
      threads.calls.push(['update', id, patch])
      Object.assign(threads.threads.get(id), patch)
    },
    async setGoalWaiting(id, waiting) {
      threads.goalWaitCalls.push([id, waiting])
      threads.threads.get(id).goalWaiting = waiting
    },
    async implementResearch(id) {
      const thread = threads.threads.get(id)
      if (thread.status === 'running') throw new Error('調査中です')
      threads.calls.push(['implementResearch', id])
      thread.permissionMode = 'danger-full-access'
      thread.team.executionMode = 'write'
    },
    async steer(id, { text }) {
      threads.calls.push(['steer', id, text])
      return { steered: threads.steerable ?? false }
    },
    async cancel(id) {
      threads.calls.push(['cancel', id])
    },
    async remove(id) {
      threads.calls.push(['remove', id])
      threads.threads.delete(id)
      threads.emit('removed', { threadId: id })
    },
    pendingPermissions: (id) => threads.permissions.filter((entry) => entry.threadId === id),
    respondPermission(requestId, optionId) {
      threads.calls.push(['respond', requestId, optionId])
      threads.permissions = threads.permissions.filter((entry) => entry.requestId !== requestId)
    },
    /** The agent finished its turn with `text` as its last answer. */
    finish(id, text, status = 'done') {
      const thread = threads.threads.get(id)
      thread.status = status === 'error' ? 'error' : 'idle'
      const turn = threads.turns.get(id).at(-1)
      turn.items.push({ type: 'agent', id: 'a', text })
      turn.status = status
      if (status === 'error') turn.error = { message: '利用上限に達しました。' }
      threads.emit('thread', { ...thread })
      threads.emit('turn-finished', { threadId: id, title: thread.title, status })
    },
  })
  return threads
}

/** Claude Code tasks as the team sees them, with the leader's state set by the test. */
function fakeTerminals(team) {
  const terminals = Object.assign(new EventEmitter(), {
    records: new Map(),
    states: new Map(),
    calls: [],
    async create(options) {
      const id = `terminal-${terminals.records.size + 1}`
      const record = { id, workspace: options.workspace, ...options }
      terminals.records.set(id, record)
      terminals.states.set(id, { state: 'running', activity: options.prompt ? 'running' : 'idle', ready: !options.prompt, inputAt: 0 })
      // As TerminalManager does: the launch flags are asked for while starting.
      record.launch = team.manager?.launchFor({ ...record, team: options.team })
      terminals.calls.push(['create', options])
      return terminals.summary(record)
    },
    summary: (record) => ({ id: record.id, workspace: record.workspace, team: record.team, ...terminals.states.get(record.id) }),
    status: (id) => (terminals.records.has(id) ? { ...terminals.states.get(id) } : null),
    set(id, patch) {
      Object.assign(terminals.states.get(id), patch)
      terminals.emit('terminal', terminals.summary(terminals.records.get(id)))
    },
    sendMessage(id, text) {
      terminals.calls.push(['type', id, text])
    },
    pressEnter(id) {
      terminals.calls.push(['enter', id])
    },
    restart(id, _client, _size, { prompt } = {}) {
      terminals.calls.push(['restart', id, prompt])
      terminals.set(id, { state: 'running', activity: prompt ? 'running' : 'idle', ready: false })
    },
    stop(id) {
      terminals.calls.push(['stop', id])
      terminals.set(id, { state: 'exited', activity: 'idle' })
    },
    async remove(id) {
      terminals.calls.push(['remove', id])
      terminals.records.delete(id)
      terminals.emit('removed', { terminalId: id })
    },
    async settle(id) {
      terminals.calls.push(['settle', id])
      return terminals.settled ? (terminals.set(id, { activity: 'idle' }), true) : false
    },
    /** Claude Code took a prompt carrying these team messages (claude-hook.js team_marks), as TerminalManager.hook reports it. */
    took(id, marks) {
      terminals.set(id, { activity: 'running' })
      terminals.emit('hook', { terminalId: id, input: { hook_event_name: 'UserPromptSubmit', team_marks: marks } })
    },
  })
  return terminals
}

/** Headless Claude Code sessions (claude-runner.js) as the team sees them. */
function fakeAgents() {
  const agents = Object.assign(new EventEmitter(), {
    sessions: new Map(),
    calls: [],
    async create(options) {
      const id = `agent-${agents.sessions.size + 1}`
      agents.sessions.set(id, { id, running: false, lastStatus: null, ...options })
      agents.calls.push(['create', options])
      return agents.get(id)
    },
    get(id) {
      const session = agents.sessions.get(id)
      return session ? { id, state: session.running ? 'running' : 'idle', lastStatus: session.lastStatus } : null
    },
    running: (id) => Boolean(agents.sessions.get(id)?.running),
    run(id, text) {
      const session = agents.sessions.get(id)
      if (session.running) throw new Error('作業中です')
      agents.calls.push(['run', id, text])
      session.running = true
      agents.emit('session', agents.get(id))
    },
    async setArgs(id, args) {
      if (agents.running(id)) throw new Error('作業中です')
      agents.sessions.get(id).args = [...args]
      agents.calls.push(['setArgs', id, args])
    },
    /** A message added to the turn that is running (false when none runs, or `session.steerable` is off). */
    steer(id, text) {
      const session = agents.sessions.get(id)
      if (!session?.running || session.steerable === false) return false
      agents.calls.push(['steer', id, text])
      return true
    },
    stop(id) {
      const session = agents.sessions.get(id)
      if (!session?.running) return false
      agents.calls.push(['stop', id])
      agents.finish(id, '', 'cancelled')
      return true
    },
    async remove(id) {
      agents.calls.push(['remove', id])
      agents.sessions.delete(id)
      agents.emit('removed', { id })
    },
    /** The turn ended (Claude Code's `result` event). */
    finish(id, text, status = 'done', { error = null, denials = [] } = {}) {
      const session = agents.sessions.get(id)
      session.running = false
      session.lastStatus = status
      agents.emit('session', agents.get(id))
      agents.emit('finished', { id, status, text, error, denials })
    },
  })
  return agents
}

const CATALOG = {
  data: {
    models: [
      { value: '["openai-codex","gpt-6-luna"]', provider: 'openai-codex', id: 'gpt-6-luna', name: 'GPT-6 Luna' },
      { value: '["openai-codex","gpt-6.1-sol"]', provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
      { value: '["anthropic","claude-haiku-5-5"]', provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
      { value: '["deepseek-official","deepseek-v4-flash"]', provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { value: '["opencode-go","glm-5.3"]', provider: 'opencode-go', id: 'glm-5.3', name: 'GLM-5.3' },
    ],
  },
}

async function setup(t, settings = {}, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-teams-'))
  const workspace = path.join(dir, 'project')
  await fs.mkdir(workspace)
  const holder = {}
  const threads = fakeThreads()
  const terminals = fakeTerminals(holder)
  const agents = fakeAgents()
  let saved = {
    ...structuredClone(TEAM_DEFAULTS),
    claude: { ...structuredClone(TEAM_DEFAULTS.claude), enabled: true },
    gpt: { enabled: true, low: { model: 'gpt-6-luna', effort: 'medium' }, mid: { model: 'gpt-6.1-sol', effort: 'high' } },
    ...settings,
  }
  const manager = await new TeamManager({
    file: path.join(dir, 'teams.json'),
    dir: path.join(dir, 'teams'),
    threads,
    terminals,
    agents,
    catalog: CATALOG,
    getSettings: () => saved,
    apiUrl: () => 'http://127.0.0.1:47130/api/team',
    node: 'C:\\node.exe',
    script: 'C:\\agent-desk\\server\\team-mcp.js',
    // Reports go as soon as the leader can take them, unless a test is about gathering them.
    gatherMs: 0,
    ...options,
  }).load()
  holder.manager = manager
  t.after(() => manager.stop())
  const { team, terminal, thread } = await manager.create({ workspace })
  const leader = (terminal ?? thread).id
  if (terminal) terminals.set(leader, { ready: true })
  const raw = manager.teams.get(team.id)
  const tool = (name, args = {}) => manager.call(team.id, raw.secret, name, args)
  return {
    dir, workspace, threads, terminals, agents, manager, team: raw, leader, tool,
    setSettings: (next) => { saved = next },
    typed: () => terminals.calls.filter((call) => call[0] === 'type' && call[1] === leader).map((call) => call[2]),
    /** What a GPT leader was sent. */
    sent: () => threads.calls.filter((call) => call[0] === 'send' && call[1] === leader).map((call) => call[2]),
  }
}

async function setupExecution(t, options = {}, settings = {}) {
  const base = await setup(t, { leaderProvider: 'gpt', ...settings }, options)
  execFileSync('git', ['init', '-q', base.workspace])
  await fs.writeFile(path.join(base.workspace, 'source.txt'), 'original')
  const { team: view } = await base.manager.create({ workspace: base.workspace, execution: {} })
  const team = base.manager.teams.get(view.id)
  return { ...base, team, leader: team.leaderId, tool: (name, args = {}) => base.manager.call(team.id, team.secret, name, args) }
}

test('eco parks after delegation and keeps reports arriving before parent idle queued for delivery', async (t) => {
  const f = await setupExecution(t)
  const parent = f.threads.threads.get(f.leader)
  parent.status = 'running'
  assert.equal(f.threads.teamGoalWaiting(parent), false)
  await f.tool('spawn', { ...exTask, mode: 'research' })
  const child = f.team.children[0]
  assert.equal(parent.goalWaiting, true)
  assert.equal(f.threads.teamGoalWaiting(f.threads.threads.get(child.taskId)), undefined)
  f.threads.finish(child.taskId, 'evidence ready before parent ends')
  assert.equal(f.team.queue.length, 1)
  assert.equal(f.threads.teamGoalWaiting(parent), true, 'queued report must not open an autonomous goal round')
  parent.status = 'idle'
  f.threads.emit('turn-finished', { threadId: f.leader, status: 'done' })
  await tick()
  assert.equal(f.team.queue.length, 0)
  assert.equal(f.threads.teamGoalWaiting(parent), false)
  const reports = f.threads.calls.filter((call) => call[0] === 'send' && call[1] === f.leader)
  assert.equal(reports.length, 1)
  assert.match(reports[0][2], /evidence ready/)
  await f.tool('close', { child: child.id, reason: '報告の根拠を確認した' })
  assert.equal(parent.goalWaiting, false)
})

test('eco stays parked for a remaining child and wakes on an error report', async (t) => {
  const f = await setupExecution(t)
  const parent = f.threads.threads.get(f.leader)
  parent.status = 'running'
  await f.tool('spawn', { ...exTask, mode: 'research', name: 'first' })
  await f.tool('spawn', { ...exTask, mode: 'research', name: 'second' })
  const [first, second] = f.team.children
  parent.status = 'idle'
  f.threads.finish(first.taskId, 'first done')
  await tick()
  assert.equal(f.threads.teamGoalWaiting(parent), true)
  await f.tool('close', { child: first.id, reason: '根拠を確認した' })
  assert.equal(parent.goalWaiting, true)
  parent.status = 'idle'
  f.threads.finish(second.taskId, 'child failed', 'error')
  await tick()
  assert.equal(f.threads.calls.filter((call) => call[0] === 'send' && call[1] === f.leader).length, 2)
  assert.equal(f.threads.teamGoalWaiting(parent), false)
})


test('eco approval wakes the parked leader and answering it parks again for the child', async (t) => {
  const f = await setupExecution(t)
  const parent = f.threads.threads.get(f.leader)
  parent.status = 'running'
  await f.tool('spawn', exTask)
  const child = f.team.children[0]
  parent.status = 'idle'
  f.threads.permissions.push({ threadId: child.taskId, requestId: 'approval-wake', name: 'shell', input: { command: 'read only' }, options: [{ optionId: 'yes', kind: 'allow_once' }] })
  f.threads.emit('approval-needed', { threadId: child.taskId })
  await tick()
  assert.equal(parent.status, 'running')
  assert.equal(f.threads.calls.filter((call) => call[0] === 'send' && call[1] === f.leader).length, 1)
  await f.tool('approve', { child: child.id, allow: true })
  assert.ok(f.threads.calls.some((call) => call[0] === 'respond' && call[1] === 'approval-wake'))
  assert.equal(parent.goalWaiting, true)
})


test('stopAll keeps the leader parked even after a cancellation report and only new delegated work releases the stop latch', async (t) => {
  const f = await setupExecution(t)
  const parent = f.threads.threads.get(f.leader)
  parent.status = 'running'
  await f.tool('spawn', { ...exTask, mode: 'research' })
  const child = f.team.children[0]
  await f.manager.stopAll(f.team.id)
  assert.equal(parent.goalWaiting, true)
  f.threads.finish(child.taskId, 'stopped by user', 'cancelled')
  parent.status = 'idle'
  f.threads.emit('turn-finished', { threadId: f.leader, status: 'done' })
  await tick()
  assert.equal(f.team.queue.length, 0)
  assert.equal(f.threads.teamGoalWaiting(parent), true, 'the stop must not become an automatic retry loop')
  await f.tool('close', { child: child.id, accept: false, reason: 'ユーザーが停止した' })
  assert.equal(parent.goalWaiting, true)
  await f.tool('send', { child: child.id, message: 'ユーザーの依頼で調査を再開' })
  assert.equal(f.team.execution.stopped, false)
  f.threads.finish(child.taskId, 'new evidence')
  parent.status = 'idle'
  f.threads.emit('turn-finished', { threadId: f.leader, status: 'done' })
  await tick()
  assert.equal(f.threads.teamGoalWaiting(parent), false)
})


for (const eco of [false, true]) {
  const mode = eco ? 'eco' : 'TM'
  test(mode + ' user decisions stay parked across reports and cannot be overridden by independent work', async (t) => {
    const f = eco ? await setupExecution(t) : await setup(t, { leaderProvider: 'gpt' })
    const parent = f.threads.threads.get(f.leader)
    await f.tool('ask_user', { message: 'どちらの方式にしますか' })
    assert.equal(parent.goalWaiting, true)
    await f.tool('wait', { waiting: false })
    assert.equal(parent.goalWaiting, true)
    assert.equal(f.threads.teamGoalWaiting(parent, { userInput: true }), false)
    await f.tool('spawn', { ...exTask, mode: 'research' })
    assert.equal(f.threads.teamGoalWaiting(parent, { userInput: true }), true, 'an answer does not erase outstanding children')
    const child = f.team.children[0]
    f.threads.finish(child.taskId, 'research result')
    await f.tool('read_report', { child: child.id })
    assert.equal(f.team.asks[0].done, false, 'a child report is not a human answer')
    assert.equal(parent.goalWaiting, true)
    f.manager.userWrote(f.leader)
    await f.tool('wait', {})
    assert.equal(parent.goalWaiting, false)
  })

  test(mode + ' dismissing an unanswered question wakes the leader once, without granting approval', async (t) => {
    const f = eco ? await setupExecution(t) : await setup(t, { leaderProvider: 'gpt' })
    const parent = f.threads.threads.get(f.leader)
    await f.tool('ask_user', { message: '外部公開していいですか' })
    parent.status = 'idle'
    f.manager.dismissAsk(f.team.id, f.team.asks[0].id)
    await tick()
    const sent = f.threads.calls.filter((call) => call[0] === 'send' && call[1] === f.leader)
    assert.equal(sent.length, 1)
    assert.match(sent[0][2], /回答・承認ではありません/)
    assert.equal(f.threads.teamGoalWaiting(parent), false)
    f.manager.dismissAsk(f.team.id)
    assert.equal(f.threads.calls.filter((call) => call[0] === 'send' && call[1] === f.leader).length, 1)
  })

  test(mode + ' stop cannot be bypassed by work override or a failed delegation', async (t) => {
    const f = eco ? await setupExecution(t) : await setup(t, { leaderProvider: 'gpt' })
    const parent = f.threads.threads.get(f.leader)
    await f.manager.stopAll(f.team.id)
    await f.tool('wait', { waiting: false })
    assert.equal(parent.goalWaiting, true)
    await assert.rejects(f.tool('spawn', { ...exTask, title: '' }))
    assert.equal(f.team.stopped, true)
    await f.tool('spawn', { ...exTask, mode: 'research' })
    assert.equal(f.team.stopped, false)
    await f.tool('wait', { waiting: false })
    assert.equal(parent.goalWaiting, false)
  })
}

test('a concurrent stop is not cleared by an older asynchronous team command', async (t) => {
  const f = await setup(t, { leaderProvider: 'gpt' })
  const original = f.threads.send
  let entered, release
  const started = new Promise((resolve) => { entered = resolve })
  const ready = new Promise((resolve) => { release = resolve })
  f.threads.send = async (...args) => { entered(); await ready; return original(...args) }
  const pending = f.tool('spawn', { ...exTask })
  await started
  await f.manager.stopAll(f.team.id)
  release()
  await assert.rejects(pending, /停止/)
  assert.equal(f.team.stopped, true)
  assert.equal(f.threads.teamGoalWaiting(f.threads.threads.get(f.leader)), true)
})


test('dismissing one question preserves the others and identifies only the dismissed question', async (t) => {
  const f = await setup(t, { leaderProvider: 'gpt' })
  await f.tool('ask_user', { message: 'first specific question' })
  await f.tool('ask_user', { message: 'second specific question' })
  const parent = f.threads.threads.get(f.leader)
  parent.status = 'idle'
  f.manager.dismissAsk(f.team.id, f.team.asks[0].id)
  await tick()
  const sent = f.threads.calls.filter((call) => call[0] === 'send' && call[1] === f.leader).at(-1)[2]
  assert.match(sent, /first specific question/)
  assert.doesNotMatch(sent, /second specific question/)
  assert.equal(f.team.asks[1].done, false)
  assert.equal(f.threads.teamGoalWaiting(parent), true)
})

test('TM parks delegated waits but can keep independent work running until a report arrives', async (t) => {
  const f = await setup(t, { leaderProvider: 'gpt' })
  const parent = f.threads.threads.get(f.leader)
  await f.tool('spawn', { title: 'work', task: 'bounded work', tier: 'low', provider: 'gpt' })
  const child = f.team.children[0]
  assert.equal(parent.goalWaiting, true)
  assert.equal(f.threads.teamGoalWaiting(f.threads.threads.get(child.taskId)), undefined)
  await f.tool('wait', { waiting: false })
  assert.equal(parent.goalWaiting, false, 'parent can keep doing independent work')
  await f.tool('wait', {})
  assert.equal(parent.goalWaiting, true)
  await f.tool('wait', { waiting: false })
  f.threads.finish(child.taskId, 'ready for review')
  assert.equal(parent.goalWaiting, true, 'a report takes priority over independent automatic rounds')
  await f.tool('read_report', { child: child.id })
  assert.equal(f.threads.teamGoalWaiting(parent), false)
  assert.ok(f.threads.goalWaitCalls.length > 0)
})

test('team PTC validates selections and stays off for legacy teams even when new-team defaults are on', async (t) => {
  assert.equal(teamConfig({}).toolMode, 'native')
  assert.equal(mergeTeamConfig({}, { toolMode: 'ptc' }).toolMode, 'ptc')
  assert.throws(() => mergeTeamConfig({}, { toolMode: 'other' }), /不明/)
  const f = await setup(t, { toolMode: 'ptc' })
  await f.tool('spawn', { title: 'Claude stays native', task: 'bounded task', tier: 'low', provider: 'claude' })
  assert.equal('toolMode' in f.agents.calls.find((call) => call[0] === 'create')[1], false)
  f.terminals.set(f.leader, { activity: 'running' })
  assert.throws(() => f.manager.updateConfig(f.team.id, { toolMode: 'native' }), /実行中/)
  await f.manager.stop()
  const saved = JSON.parse(await fs.readFile(f.manager.file, 'utf8'))
  delete saved.teams[0].config
  await fs.writeFile(f.manager.file, JSON.stringify(saved))
  const restored = await new TeamManager({ file: f.manager.file, dir: path.join(f.dir, 'teams'), threads: f.threads,
    terminals: f.terminals, agents: f.agents, catalog: CATALOG, getSettings: () => ({ toolMode: 'ptc' }), apiUrl: () => '' }).load()
  t.after(() => restored.stop())
  assert.equal(restored.teams.get(f.team.id).config.toolMode, 'native')
})

const exTask = { title: 'implement', task: 'do the bounded work', criteria: 'the test passes without unrelated changes', checks: [], tier: 'low', provider: 'gpt' }

for (const mode of ['TM', 'eco']) {
  test(`${mode} propagates PTC to parent and children, rejects busy switches and persists idle changes`, async (t) => {
    const f = mode === 'eco' ? await setupExecution(t, {}, { toolMode: 'ptc' }) : await setup(t, { leaderProvider: 'gpt', toolMode: 'ptc' })
    const { manager, team, threads, tool, leader } = f
    assert.equal(threads.threads.get(leader).toolMode, 'ptc')
    assert.equal(manager.summary(team).toolModeBusy, false)
    const args = { ...exTask, ...(mode === 'eco' ? { mode: 'research' } : {}) }
    await tool('spawn', args)
    const child = team.children[0]
    assert.equal(threads.threads.get(child.taskId).toolMode, 'ptc')
    if (mode === 'eco') assert.equal(threads.threads.get(child.taskId).permissionMode, 'read-only')
    assert.equal(manager.summary(team).toolModeBusy, true)
    assert.throws(() => manager.updateConfig(team.id, { toolMode: 'native' }), /実行中/)
    threads.finish(child.taskId, 'registered tool report')
    await tick()
    assert.equal(threads.threads.get(leader).status, 'running', 'child report reaches parent')
    assert.throws(() => manager.updateConfig(team.id, { toolMode: 'native' }), /実行中/)
    threads.finish(leader, 'parent assessed report')
    await tick()
    manager.updateConfig(team.id, { toolMode: 'native' })
    assert.equal(threads.teamToolMode(threads.threads.get(child.taskId)), 'native', 'existing child follows owner choice')
    assert.equal(threads.teamToolMode(threads.threads.get(leader)), 'native')
    await tool('send', { child: child.id, message: 'next bounded task', fresh: true })
    assert.equal(threads.threads.get(child.taskId).toolMode, 'native', 'replacement child uses current mode')
    const stored = teamConfig(manager.summary(team).config)
    assert.equal(stored.toolMode, 'native')
    await manager.stop()
    const restored = await new TeamManager({ file: path.join(f.dir, 'teams.json'), dir: path.join(f.dir, 'teams'),
      threads, terminals: f.terminals, agents: f.agents, catalog: CATALOG, getSettings: () => ({ toolMode: 'ptc' }), apiUrl: () => '' }).load()
    t.after(() => restored.stop())
    assert.equal(restored.teams.get(team.id).config.toolMode, 'native', 'restart does not inherit new global defaults')
  })
}

for (const mode of ['TM', 'eco']) {
  test(`${mode} sums parent and children once and preserves scores across restart`, async (t) => {
    const f = mode === 'eco' ? await setupExecution(t) : await setup(t, { leaderProvider: 'gpt' })
    const parent = f.threads.threads.get(f.leader)
    parent.score = { points: 10, priced: 1, unpriced: 0 }
    f.threads.emit('thread', { ...parent })
    await f.tool('spawn', mode === 'eco' ? exTask : { title: 'implement', task: 'do it', tier: 'low', provider: 'gpt' })
    const child = f.team.children[0]
    const childRecord = f.threads.threads.get(child.taskId)
    childRecord.score = { points: 1, priced: 1, unpriced: 0 }
    f.threads.finish(child.taskId, 'done')
    f.threads.emit('thread', { ...childRecord })
    assert.equal(f.manager.summary(f.team).score.points, 11)
    if (mode === 'TM') {
      await f.tool('send', { child: child.name, message: 'start fresh', fresh: true })
      const next = f.threads.threads.get(child.taskId)
      next.score = { points: 2, priced: 1, unpriced: 0 }
      f.threads.finish(child.taskId, 'again')
      assert.equal(f.manager.summary(f.team).score.points, 13)
      await f.threads.remove(child.taskId)
      assert.equal(f.manager.summary(f.team).score.points, 13, 'removing a child cannot refund its consumption')
    }
    await f.manager.writes
    const restored = await new TeamManager({ file: path.join(f.dir, 'teams.json'), dir: path.join(f.dir, 'teams'),
      threads: f.threads, terminals: f.terminals, agents: f.agents, catalog: CATALOG,
      getSettings: () => TEAM_DEFAULTS, apiUrl: () => '', node: '', script: '' }).load()
    t.after(() => restored.stop())
    assert.equal(restored.summary(restored.teams.get(f.team.id)).score.points, mode === 'TM' ? 13 : 11)
  })
}

test('team usage recovery updates totals without starting another leader turn', async (t) => {
  const f = await setup(t, { leaderProvider: 'gpt' })
  const parent = f.threads.threads.get(f.leader)
  parent.score = { points: 0, priced: 0, unpriced: 1 }
  f.threads.emit('thread', { ...parent })
  const calls = f.threads.calls.length
  parent.score = { points: 2, priced: 1, unpriced: 0 }
  f.threads.emit('usage-priced', { ...parent })
  await f.manager.writes
  assert.equal(f.manager.summary(f.team).score.points, 2)
  assert.equal(f.threads.calls.length, calls)
})

const GUIDES = {
  policies: [{ id: 'p1', name: 'TMの方針', text: 'TM専用の方針本文' }],
  playbooks: [{ id: 'b1', name: 'TM専用の手順', description: 'TM専用の場面', body: 'TM専用の手順本文' }],
}

for (const parent of ['claude', 'gpt', 'claudeApi']) {
  test(`TM guides stay out of eco ${parent} parents, including restored teams and direct API calls`, async (t) => {
    const guides = structuredClone(GUIDES)
    const f = await setup(t, { policy: 'p1', leaderProvider: parent === 'claude' ? 'claude' : 'gpt' }, { guides: () => guides })
    const { manager } = f
    const { team: eco } = await manager.create({
      workspace: f.workspace, execution: parent === 'claudeApi' ? { leaderModel: '["anthropic","claude-haiku-5-5"]' } : {},
    })
    const promptFor = async (team) => {
      const record = { team: { id: team.id, role: 'leader' } }
      if (team.leaderKind === 'terminal') {
        const { args } = manager.launchFor(record)
        const mcp = JSON.parse(await fs.readFile(args[args.indexOf('--mcp-config') + 1], 'utf8'))
        return { env: mcp.mcpServers['agent-team'].env, prompt: await fs.readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8') }
      }
      const env = Object.fromEntries(manager.mcpServerFor(record).env.map(({ name, value }) => [name, value]))
      return { env, prompt: await fs.readFile(env.AGENT_DESK_TEAM_INSTRUCTIONS, 'utf8') }
    }
    for (const restored of [false, true]) {
      if (restored) await manager.load()
      const tmTeam = manager.teams.get(f.team.id)
      const ecoTeam = manager.teams.get(eco.id)
      // Even a saved eco with a selected TM policy must not read it.
      assert.equal(ecoTeam.config.policy, 'p1')
      const tm = await promptFor(tmTeam)
      assert.match(tm.prompt, /<team_policy>\nTM専用の方針本文\n<\/team_policy>/)
      assert.match(tm.prompt, /"TM専用の手順": TM専用の場面/)
      assert.equal(tm.env.AGENT_DESK_TEAM_PLAYBOOKS, '1')
      const ex = await promptFor(ecoTeam)
      assert.doesNotMatch(ex.prompt, /team_policy|Playbooks|TM専用/)
      assert.equal(ex.env.AGENT_DESK_TEAM_PLAYBOOKS, undefined)
      assert.equal(ex.env.AGENT_DESK_EXECUTION, '1')
      guides.playbooks[0].body = restored ? '更新済みの手順本文' : 'TM専用の手順本文'
      assert.match(await f.tool('playbook', { name: 'TM専用の手順' }), new RegExp(guides.playbooks[0].body))
      for (const name of ['TM専用の手順', 'unknown']) {
        await assert.rejects(manager.call(eco.id, ecoTeam.secret, 'playbook', { name }), /unknown tool: playbook/)
      }
    }
  })
}

test('AB Claude and dsh jobs never receive TM guides or its MCP server', async (t) => {
  const f = await setup(t, { policy: 'p1', leaderProvider: 'gpt' }, { guides: () => structuredClone(GUIDES) })
  f.agents.live = new Map()
  f.threads.active = new Map()
  const runner = new AbRunner({ threads: f.threads, agents: f.agents, instructions: () => '通常のカスタム指示' })
  const getServers = createMcpServerList({ paths: {}, getSettings: () => ({}), getTeams: () => f.manager })
  for (const model of ['claude:sonnet', '["openai-codex","gpt-6.1-sol"]']) for (const writable of [false, true]) {
    const handle = await runner.start({ runId: 'R', jobId: 'J', model, workspace: f.workspace,
      writable, lean: true, instructions: 'AB専用の指示', text: 'ABの依頼' })
    if (handle.kind === 'claude') {
      const { args } = f.agents.sessions.get(handle.id)
      assert.match(args[args.indexOf('--append-system-prompt') + 1], /AB専用の指示\n\n通常のカスタム指示/)
      assert.doesNotMatch(args.join('\n'), /TM専用|team_policy|Playbooks|agent-team/)
      assert.ok(!args.includes('--mcp-config'))
    } else {
      const thread = f.threads.threads.get(handle.id)
      assert.equal(thread.team, undefined)
      assert.equal(f.manager.mcpServerFor(thread), null)
      assert.deepEqual(getServers(thread), [])
      const message = f.threads.calls.findLast(([op, id]) => op === 'send' && id === handle.id)[2]
      assert.doesNotMatch(message, /TM専用|team_policy|Playbooks/)
    }
    await runner.remove(handle)
  }
})

for (const parent of ['claude', 'gpt']) for (const provider of ['claude', 'gpt']) for (const defaults of [false, true]) {
  test(`eco forwards independent efforts into ${parent} parent and ${provider} child launches (defaults=${defaults})`, async (t) => {
    const f = await setup(t)
    const choices = structuredClone(f.team.config)
    choices.leaderProvider = parent
    choices.leader = { model: 'sonnet', effort: defaults ? null : 'high' }
    choices.gptLeader = { model: 'gpt-6.1-sol', effort: defaults ? null : 'high' }
    choices.claude = { enabled: provider === 'claude', low: { enabled: true, model: 'haiku', effort: defaults ? null : 'low' }, mid: { enabled: false, model: null, effort: null } }
    choices.gpt = { enabled: provider === 'gpt', low: { enabled: true, model: 'gpt-6-luna', effort: defaults ? null : 'low' }, mid: { enabled: false, model: null, effort: null } }
    const { team: view, terminal, thread } = await f.manager.create({ workspace: f.workspace, choices, execution: {} })
    if (parent === 'claude') assert.equal(f.terminals.records.get(terminal.id).effort, defaults ? 'medium' : 'high')
    else assert.equal(f.threads.threads.get(thread.id).effort, defaults ? 'medium' : 'high')
    const team = f.manager.teams.get(view.id)
    await f.manager.call(team.id, team.secret, 'spawn', { ...exTask, provider })
    const child = team.children.at(-1)
    assert.ok(child?.taskId)
    if (provider === 'claude') assert.equal(f.agents.sessions.get(child.taskId).effort, defaults ? 'medium' : 'low')
    else assert.equal(f.threads.threads.get(child.taskId).effort, defaults ? 'medium' : 'low')
    assert.equal(team.config[parent === 'claude' ? 'leader' : 'gptLeader'].effort, defaults ? 'medium' : 'high')
  })
}

for (const provider of ['claude', 'gpt']) for (const mode of ['write', 'research']) {
  test(`eco ${provider} ${mode} children get extra tools even with saved lean settings`, async (t) => {
    const f = await setupExecution(t)
    // Also covers existing eco teams created before extra tools became unconditional.
    f.team.config.leanChildren = true
    await f.tool('spawn', { ...exTask, provider, mode })
    const child = f.team.children.at(-1)
    assert.equal(child.tools, undefined, 'the parent need not request tools explicitly')
    assert.equal(f.manager.toolsFor({ team: { id: f.team.id, childId: child.id } }), true)
    if (provider === 'claude') {
      const args = f.agents.calls.find((call) => call[0] === 'create')[1].args
      assert.equal(args.includes('--chrome'), true)
      assert.equal(args.includes('--no-chrome'), false)
      assert.equal(args.includes('--strict-mcp-config'), false)
      assert.equal(args.includes('--tools'), mode === 'research')
      if (mode === 'research') assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep')
    } else {
      assert.equal(f.threads.threads.get(child.taskId).permissionMode, mode === 'research' ? 'read-only' : 'danger-full-access')
    }
  })
}

function conflictDetails(error, { workspace, blockerWorkspace, relation }) {
  assert.ok(error instanceof Error)
  assert.ok(error.message.includes(`対象フォルダ: ${JSON.stringify(workspace)}`), error.message)
  assert.ok(error.message.includes(`競合フォルダ: ${JSON.stringify(blockerWorkspace)}`), error.message)
  assert.ok(error.message.includes(`フォルダ関係: ${relation}`), error.message)
  const field = (label) => JSON.parse(error.message.split('\n').find((line) => line.startsWith(`${label}: `)).slice(label.length + 2))
  return { task: field('競合タスク'), state: field('判定状態') }
}

for (const kind of ['thread', 'restore', 'terminal']) for (const relation of ['同一', '上位', '配下']) {
  test(`eco identifies ${kind} conflicts in ${relation} folders before creating a child`, async (t) => {
    const { tool, team, threads, terminals, agents, workspace } = await setupExecution(t)
    const blockerWorkspace = relation === '同一' ? workspace : relation === '上位' ? path.dirname(workspace) : path.join(workspace, 'nested')
    const blocker = { id: 'conflicting-task', title: '別の作業', workspace: blockerWorkspace, status: 'running', permissionMode: 'workspace-write' }
    if (kind === 'thread') threads.threads.set(blocker.id, blocker)
    if (kind === 'restore') threads.restoring = new Set([blocker])
    if (kind === 'terminal') {
      terminals.records.set(blocker.id, blocker)
      terminals.states.set(blocker.id, { state: 'running', activity: 'running' })
    }
    const calls = [threads.calls.length, terminals.calls.length, agents.calls.length]
    await assert.rejects(tool('spawn', exTask), (error) => {
      const details = conflictDetails(error, { workspace, blockerWorkspace, relation })
      assert.equal(details.task.id, blocker.id)
      assert.equal(details.task.title, blocker.title)
      assert.equal(details.task.kind, kind === 'terminal' ? 'Claude Code端末' : 'thread')
      if (kind === 'terminal') assert.deepEqual(details.state, { state: 'running', activity: 'running' })
      else {
        assert.equal(details.state.status, 'running')
        assert.equal(details.state.permissionMode, 'workspace-write')
        assert.equal(details.state.restoring, kind === 'restore' ? true : undefined)
      }
      assert.match(error.message.split('\n')[0], kind === 'restore' ? /復元中/ : kind === 'terminal' ? /Claude Code/ : /別のタスク/)
      return true
    })
    assert.equal(team.children.length, 0)
    assert.deepEqual([threads.calls.length, terminals.calls.length, agents.calls.length], calls, 'refusal must not create, send, or stop tasks')
  })
}

test('eco preserves exemptions for read-only, idle, disjoint and own-leader tasks', async (t) => {
  const { tool, team, threads, terminals, workspace } = await setupExecution(t)
  threads.threads.get(team.leaderId).status = 'running'
  for (const record of [
    { id: 'readonly', workspace, status: 'running', permissionMode: 'read-only' },
    { id: 'idle', workspace, status: 'idle', permissionMode: 'danger-full-access' },
    { id: 'sibling', workspace: workspace + '-other', status: 'running', permissionMode: 'workspace-write' },
  ]) threads.threads.set(record.id, record)
  terminals.records.set('idle-terminal', { id: 'idle-terminal', workspace })
  terminals.states.set('idle-terminal', { state: 'running', activity: 'idle' })
  threads.restoring = new Set([{ id: 'restore-sibling', workspace: workspace + '-other' }])
  await tool('spawn', exTask)
  assert.ok(team.children[0].taskId)
})

test('eco still excludes its own Claude Code leader from terminal conflicts', async (t) => {
  const { manager, workspace, terminals } = await setup(t)
  const result = await manager.create({ workspace, execution: {}, choices: { leaderProvider: 'claude' } })
  const team = manager.teams.get(result.team.id)
  terminals.states.get(team.leaderId).activity = 'running'
  await manager.call(team.id, team.secret, 'spawn', exTask)
  assert.ok(team.children[0].taskId)
})

test('eco research still bypasses write-start conflicts, while a writer reports the first blocker', async (t) => {
  const { tool, team, threads, workspace } = await setupExecution(t)
  const first = { id: 'restore-first', title: '復元作業', workspace, status: 'idle', permissionMode: 'read-only' }
  threads.restoring = new Set([first, { ...first, id: 'restore-second' }])
  threads.threads.set('writer', { id: 'writer', title: '書き込み', workspace, status: 'running' })
  await tool('spawn', { ...exTask, mode: 'research' })
  assert.equal(team.children[0].execution.mode, 'research')
  await assert.rejects(tool('spawn', exTask), (error) => {
    const details = conflictDetails(error, { workspace, blockerWorkspace: workspace, relation: '同一' })
    assert.equal(details.task.id, first.id)
    assert.equal(details.state.restoring, true)
    assert.equal(details.state.status, 'idle', 'restoring, not running, is the blocking state')
    return true
  })
  assert.equal(team.children.length, 1)
})

for (const phase of ['working', 'verifying', 'review']) {
  test(`eco reports child/team identity and ${phase} phase for overlapping team conflicts`, async (t) => {
    const { tool, manager, threads, workspace } = await setupExecution(t)
    // The target is above this eco team: guardExecution permits it, so #exRoom handles the overlap.
    const blockerWorkspace = path.join(workspace, 'nested-eco')
    await fs.mkdir(blockerWorkspace)
    const result = await manager.create({ workspace: blockerWorkspace, execution: {} })
    const other = manager.teams.get(result.team.id)
    const child = { id: 'other-child', taskId: 'other-task', name: '担当A', title: '別の実装', kind: 'thread', closed: false, execution: { mode: 'write', phase } }
    other.children.push(child)
    threads.threads.set(child.taskId, { id: child.taskId, workspace: blockerWorkspace, status: 'idle' })
    await assert.rejects(tool('spawn', exTask), (error) => {
      const details = conflictDetails(error, { workspace, blockerWorkspace, relation: '配下' })
      assert.deepEqual(details.task, { kind: 'ecoの子', title: '担当A: 別の実装', id: child.id, teamId: other.id, taskId: child.taskId })
      assert.deepEqual(details.state, { status: 'idle', closed: false, mode: 'write', phase })
      assert.match(error.message.split('\n')[0], /作業・検証・判定/)
      return true
    })
  })
}

test('eco ignores closed, accepted and research units plus idle non-eco children at write start', async (t) => {
  const { tool, manager, workspace } = await setupExecution(t)
  const blockerWorkspace = path.join(workspace, 'nested-eco')
  await fs.mkdir(blockerWorkspace)
  const result = await manager.create({ workspace: blockerWorkspace, execution: {} })
  const other = manager.teams.get(result.team.id)
  other.children.push(
    { id: 'closed', name: 'closed', kind: 'thread', closed: true, execution: { mode: 'write', phase: 'review' } },
    { id: 'accepted', name: 'accepted', kind: 'thread', closed: false, execution: { mode: 'write', phase: 'accepted' } },
    { id: 'research', name: 'research', kind: 'thread', closed: false, execution: { mode: 'research', phase: 'working' } },
  )
  const ordinary = await manager.create({ workspace })
  manager.teams.get(ordinary.team.id).children.push({ id: 'idle-child', name: 'idle-child', kind: 'agent', taskId: 'absent-task', closed: false })
  await tool('spawn', exTask)
})

test('eco diagnostics preserve folder spellings and expose normalized alias overlap', async (t) => {
  const { tool, threads, workspace, dir } = await setupExecution(t)
  const alias = path.join(dir, 'project-alias')
  await fs.symlink(workspace, alias, 'junction')
  const resolved = await fs.realpath(workspace)
  const canonical = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const title = '別の作業\n偽の状態: stopped'
  threads.threads.set('alias-task', { id: 'alias-task', title, workspace: alias, status: 'running' })
  await assert.rejects(tool('spawn', exTask), (error) => {
    const details = conflictDetails(error, { workspace, blockerWorkspace: alias, relation: '同一' })
    assert.equal(details.task.title, title)
    assert.equal(details.state.permissionMode, '不明', 'missing permission remains blocking, not silently read-only')
    assert.ok(error.message.includes(`競合フォルダ: ${JSON.stringify(alias)}（判定: ${JSON.stringify(canonical)}）`))
    assert.equal(error.message.split('\n').length, 6, 'task text cannot inject diagnostic lines')
    return true
  })
})

test('eco identifies busy non-eco Claude children without weakening team conflicts', async (t) => {
  const { tool, manager, agents, workspace } = await setupExecution(t)
  const blockerWorkspace = path.dirname(workspace)
  const result = await manager.create({ workspace: blockerWorkspace })
  const other = manager.teams.get(result.team.id)
  const session = await agents.create({ workspace: blockerWorkspace })
  agents.sessions.get(session.id).running = true
  other.children.push({ id: 'claude-child', name: '担当B', title: '実装中', kind: 'agent', taskId: session.id, closed: false })
  await assert.rejects(tool('spawn', exTask), (error) => {
    const details = conflictDetails(error, { workspace, blockerWorkspace, relation: '上位' })
    assert.equal(details.task.kind, 'チームの子')
    assert.equal(details.task.teamId, other.id)
    assert.equal(details.task.taskId, session.id)
    assert.deepEqual(details.state, { running: true, closed: false, mode: null, phase: null })
    return true
  })
})

test('eco entry guards report blockers but keep ancestor entry behavior unchanged', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await tool('spawn', exTask)
  const child = team.children[0]
  for (const target of [workspace, path.join(workspace, 'nested')]) {
    assert.throws(() => manager.guardExecution({ id: 'ordinary', workspace: target }), (error) => {
      const details = conflictDetails(error, { workspace: target, blockerWorkspace: workspace, relation: target === workspace ? '同一' : '上位' })
      assert.equal(details.task.id, child.id)
      assert.equal(details.task.teamId, team.id)
      assert.equal(details.state.phase, 'working')
      assert.equal(details.state.status, 'running')
      return true
    })
  }
  assert.doesNotThrow(() => manager.guardExecution({ id: 'ancestor-task', workspace: path.dirname(workspace) }))
  assert.doesNotThrow(() => manager.guardExecution({ id: team.leaderId, workspace }))
  assert.doesNotThrow(() => manager.guardExecution({ id: child.taskId, workspace }))
  threads.finish(child.taskId, 'done')
  await Promise.all([...manager.exPending])
  assert.throws(() => manager.guardExecution({ id: child.taskId, workspace }), (error) => {
    const details = conflictDetails(error, { workspace, blockerWorkspace: workspace, relation: '同一' })
    assert.equal(details.state.phase, 'review')
    assert.equal(details.task.taskId, child.taskId)
    assert.match(error.message.split('\n')[0], /親から send/)
    return true
  })
})

test('eco send reports a new conflict without changing reviewed evidence or resuming the child', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await tool('spawn', exTask)
  const child = team.children[0]
  threads.finish(child.taskId, 'done')
  await Promise.all([...manager.exPending])
  const before = structuredClone(child.execution)
  const calls = threads.calls.length
  threads.threads.set('new-writer', { id: 'new-writer', title: '後発タスク', workspace, status: 'running', permissionMode: 'danger-full-access' })
  await assert.rejects(tool('send', { child: child.id, message: 'fix' }), (error) => {
    const details = conflictDetails(error, { workspace, blockerWorkspace: workspace, relation: '同一' })
    assert.equal(details.task.id, 'new-writer')
    assert.equal(details.state.permissionMode, 'danger-full-access')
    return true
  })
  assert.deepEqual(child.execution, before)
  assert.equal(threads.calls.length, calls)
})

test('eco holds one writer through verification and parent judgment, then checks freshness', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await manager.configureExecution(workspace, [{ id: 'test', command: 'node -e "console.log(123)"' }])
  await tool('spawn', { ...exTask, checks: ['test'] })
  const child = team.children[0]
  await assert.rejects(tool('spawn', exTask), /作業|判定/)
  threads.finish(child.taskId, 'done')
  assert.equal(child.execution.phase, 'verifying')
  await assert.rejects(tool('close', { child: child.id }), /終わって/)
  await Promise.all([...manager.exPending])
  assert.equal(child.execution.verification.status, 'passed')
  assert.equal(child.execution.phase, 'review')
  assert.match(child.reports.at(-1).text, /eco 検証: passed/)
  await fs.writeFile(path.join(workspace, 'source.txt'), 'external edit')
  await assert.rejects(tool('close', { child: child.id }), /変更/)
  assert.equal(child.execution.verification.status, 'stale')
  await tool('close', { child: child.id, accept: false, reason: 'external edit needs a new plan' })
  assert.equal(child.execution.outcome, 'abandoned')
})

test('eco delivers actual review evidence beyond the ordinary preview and persists acceptance reasons', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await manager.configureExecution(workspace, [{ id: 'test', command: 'node -e "console.log(1)"' }])
  await tool('spawn', { ...exTask, task: '依頼の範囲を確認して直す。'.repeat(120), checks: ['test'] })
  const child = team.children[0]
  await fs.writeFile(path.join(workspace, 'source.txt'), 'actual change not in child report')
  threads.finish(child.taskId, '子は差分の詳細を省略した')
  await Promise.all([...manager.exPending])
  const delivered = threads.calls.filter((call) => call[0] === 'send' && call[1] === team.leaderId).at(-1)[2]
  assert.ok(delivered.length > REPORT_PREVIEW)
  assert.match(delivered, /\+actual change not in child report/)
  assert.match(delivered, /M "source.txt"/)
  assert.match(delivered, /eco 検証: passed/)
  assert.match(delivered, /子は差分の詳細を省略した/)
  assert.match(delivered, /完了条件:/)
  await assert.rejects(tool('close', { child: child.id, reason: '  ' }), /根拠/)
  await tool('close', { child: child.id, reason: ' source.txtの実際の変更を依頼と照合して確認した ' })
  assert.equal(child.execution.reason, 'source.txtの実際の変更を依頼と照合して確認した')
  const saved = JSON.parse(await fs.readFile(manager.file, 'utf8'))
  assert.match(JSON.stringify(saved), /source.txtの実際の変更を依頼と照合して確認した/)
})


for (const provider of ['gpt', 'claude']) {
  test('eco ' + provider + ' delivers captured checks on new contexts and work units, not every follow-up', async (t) => {
    const f = await setupExecution(t, {}, {
      gpt: { enabled: provider === 'gpt', low: { model: 'gpt-6-luna' } },
      claude: { enabled: provider === 'claude', low: { model: 'haiku' } },
    })
    const registered = { id: 'test', command: 'node -e "console.log(1)"' }
    const extra = { id: 'task-only', cwd: 'checks', command: 'node -e "console.log(2)"' }
    await fs.mkdir(path.join(f.workspace, 'checks'))
    await f.manager.configureExecution(f.workspace, [registered, { id: 'unused', command: 'echo not-selected' }])
    await f.tool('spawn', { ...exTask, provider, checks: ['test'], extraChecks: [extra] })
    const child = f.team.children[0]
    const captured = structuredClone(child.execution.checks)
    const message = () => provider === 'gpt'
      ? f.threads.calls.findLast((call) => call[0] === 'send' && call[1] === child.taskId)[2]
      : f.agents.calls.findLast((call) => call[0] === 'run' && call[1] === child.taskId)[2]
    const assertChecks = () => {
      const payload = message()
      const commands = payload.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
      assert.deepEqual(commands, [{ cwd: '.', ...registered }, extra])
      assert.equal(payload.split('[eco アプリの最終検証').length, 2, 'guidance is attached once')
      assert.ok(payload.includes(exTask.criteria))
      assert.doesNotMatch(payload, /not-selected|process.exit/)
      assert.deepEqual(child.execution.checks, captured)
    }
    const finish = async () => {
      if (provider === 'gpt') f.threads.finish(child.taskId, 'done')
      else f.agents.finish(child.taskId, 'done')
      await Promise.all([...f.manager.exPending])
      assert.equal(child.execution.verification.status, 'passed')
      assert.equal(child.execution.verification.checks[0].command, registered.command)
    }
    assertChecks()
    await f.manager.configureExecution(f.workspace, [{ ...registered, command: 'node -e "process.exit(99)"' }])
    await finish()
    await f.tool('send', { child: child.id, message: '同じ範囲の手直し' })
    assert.doesNotMatch(message(), /eco アプリの最終検証/)
    assert.equal(child.execution.instructions.at(-1), '同じ範囲の手直し')
    await finish()
    const taskId = child.taskId
    await f.tool('send', { child: child.id, message: '同じ範囲で会話をやり直す', fresh: true })
    assert.notEqual(child.taskId, taskId)
    assertChecks()
    await finish()
    await f.tool('close', { child: child.id, reason: '依頼と差分・検証結果を照合した' })
    await f.tool('send', { child: child.id, message: '次の作業' })
    assert.equal(child.execution.task, '次の作業', 'guidance stays out of the recorded user task')
    assertChecks()
  })
}

test('eco keeps the work-unit baseline through send/fresh and resets it for work after close', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await tool('spawn', exTask)
  const child = team.children[0]
  const baseline = structuredClone(child.execution.baseline)
  await fs.writeFile(path.join(workspace, 'source.txt'), 'first change')
  threads.finish(child.taskId, 'first report')
  await Promise.all([...manager.exPending])
  await tool('send', { child: child.id, message: '二回目の修正。元の範囲を保つ', fresh: true })
  assert.deepEqual(child.execution.baseline, baseline)
  await fs.writeFile(path.join(workspace, 'source.txt'), 'second change')
  threads.finish(child.taskId, 'second report')
  await Promise.all([...manager.exPending])
  let patch = await fs.readFile(child.execution.review.patch, 'utf8')
  assert.match(patch, /-original/)
  assert.match(patch, /\+second change/)
  assert.match(child.reports.at(-1).text, /二回目の修正。元の範囲を保つ/)
  await tool('close', { child: child.id, reason: '累積差分を依頼と照合した' })
  await tool('send', { child: child.id, message: '新しい依頼' })
  assert.notEqual(child.execution.baseline.commit, baseline.commit)
  assert.equal(child.execution.task, '新しい依頼')
  assert.deepEqual(child.execution.instructions, [])
  await fs.writeFile(path.join(workspace, 'source.txt'), 'third change')
  threads.finish(child.taskId, 'third report')
  await Promise.all([...manager.exPending])
  patch = await fs.readFile(child.execution.review.patch, 'utf8')
  assert.match(patch, /-second change/)
  assert.doesNotMatch(patch, /-original/)
})

test('eco does not launch a child if stopped while capturing its initial review baseline', async (t) => {
  const { tool, team, manager, threads } = await setupExecution(t)
  let release
  manager.executionReview.start = () => new Promise((resolve) => { release = resolve })
  const before = threads.calls.filter((call) => call[0] !== 'goal-wait').length
  const pending = tool('spawn', exTask)
  assert.equal(typeof release, 'function')
  await manager.stopAll(team.id)
  release({ error: 'test baseline' })
  await assert.rejects(pending, /開始前に停止/)
  assert.equal(team.children.length, 0)
  assert.equal(threads.calls.filter((call) => call[0] !== 'goal-wait').length, before)
})

test('eco reserves a resumed writer during baseline capture and restores evidence if stopped', async (t) => {
  const { tool, team, manager, threads } = await setupExecution(t)
  await tool('spawn', exTask)
  const child = team.children[0]
  threads.finish(child.taskId, 'done')
  await Promise.all([...manager.exPending])
  await tool('close', { child: child.id, reason: '変更内容を確認' })
  const previous = structuredClone(child.execution)
  let release
  manager.executionReview.start = () => new Promise((resolve) => { release = resolve })
  const pending = tool('send', { child: child.id, message: 'next work' })
  assert.equal(typeof release, 'function')
  await assert.rejects(tool('spawn', exTask), /作業|判定/)
  assert.throws(() => manager.updateConfig(team.id, { toolMode: 'ptc' }), /実行中/)
  await assert.rejects(tool('send', { child: child.id, message: 'duplicate' }), /作業中/)
  await manager.stopAll(team.id)
  release({ error: 'test baseline' })
  await assert.rejects(pending, /開始前に停止/)
  assert.equal(child.closed, true)
  assert.deepEqual(child.execution, previous)
})

test('eco retries explicitly repairable failures once, then escalates repeated evidence', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  manager.updateConfig(team.id, { toolMode: 'ptc' })
  await manager.configureExecution(workspace, [{ id: 'test', command: 'node -e "console.log(123);process.exit(2)"', autoRepair: true }])
  await tool('spawn', { ...exTask, checks: ['test'] })
  const child = team.children[0]
  threads.finish(child.taskId, 'done')
  await Promise.all([...manager.exPending])
  assert.equal(child.execution.repairs, 1)
  assert.equal(threads.teamToolMode(threads.threads.get(child.taskId)), 'ptc')
  assert.equal(child.execution.phase, 'working')
  assert.equal(child.reports.length, 0)
  assert.deepEqual(child.execution.instructions ?? [], [])
  await fs.writeFile(path.join(workspace, 'source.txt'), 'repair attempt')
  threads.finish(child.taskId, 'done again')
  await Promise.all([...manager.exPending])
  assert.equal(child.execution.repairs, 1)
  assert.equal(child.execution.phase, 'review')
  assert.equal(child.execution.verification.status, 'failed')
  const patch = await fs.readFile(child.execution.review.patch, 'utf8')
  assert.match(patch, /-original/)
  assert.match(patch, /\+repair attempt/)
  await assert.rejects(tool('close', { child: child.id }), /成功していません/)
})

test('eco requires acceptance criteria and checks, isolates research and preserves TM defaults', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await assert.rejects(tool('spawn', { ...exTask, criteria: '' }), /criteria/)
  await assert.rejects(tool('spawn', { ...exTask, checks: ['missing'] }), /登録/)
  await assert.rejects(tool('spawn', { ...exTask, tier: 'mid' }), /低枠/)
  await tool('spawn', { ...exTask, mode: 'research' })
  const research = team.children[0]
  assert.equal(threads.threads.get(research.taskId).permissionMode, 'read-only')
  await tool('spawn', exTask)
  const writer = team.children[1]
  assert.throws(() => manager.guardExecution({ id: 'ordinary', workspace }), /eco/)
  manager.guardExecution({ id: team.leaderId, workspace })
  threads.finish(writer.taskId, 'done')
  await Promise.all([...manager.exPending])
  assert.equal(writer.execution.verification.status, 'unverified')
  await assert.rejects(tool('close', { child: writer.id }), /根拠/)
  await tool('close', { child: writer.id, reason: 'manually reviewed source' })
  assert.equal(writer.execution.outcome, 'accepted')
})

test('eco reports research permissions and preserves them through send and fresh', async (t) => {
  const { tool, team, manager, threads } = await setupExecution(t)
  const spawned = await tool('spawn', { ...exTask, mode: 'research', name: 'R' })
  const child = team.children[0]
  assert.match(spawned, /mode: research（読み取り専用・昇格不可）/)
  assert.match(spawned, /implement で同じ子/)
  assert.match(await tool('status'), /R .*mode: research・読み取り専用・昇格不可/)
  const firstTask = child.taskId
  threads.finish(firstTask, 'investigated')
  await tool('send', { child: child.id, message: 'investigate more' })
  assert.equal(child.taskId, firstTask)
  assert.equal(threads.threads.get(child.taskId).permissionMode, 'read-only')
  threads.finish(child.taskId, 'more evidence')
  await tool('send', { child: child.id, message: 'investigate afresh', fresh: true })
  assert.notEqual(child.taskId, firstTask)
  assert.equal(threads.threads.get(child.taskId).permissionMode, 'read-only')
  threads.permissions.push({
    threadId: child.taskId, requestId: 'research-escalation', name: 'run_code',
    input: { sandbox_permissions: 'workspace-write' },
    options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
  })
  threads.emit('approval-needed', { threadId: child.taskId })
  assert.deepEqual(threads.calls.at(-1), ['respond', 'research-escalation', 'no'])
  assert.equal(manager.summary(team).approvals.length, 0)
})

test('eco research reports skip verification but still require the parent review reason', async (t) => {
  const { tool, team, manager, threads } = await setupExecution(t)
  manager.execution.verify = async () => { throw new Error('research must not be verified') }
  await tool('spawn', { ...exTask, mode: 'research' })
  const research = team.children[0]
  threads.finish(research.taskId, 'found it')
  assert.equal(manager.exPending.size, 0)
  assert.equal(research.execution.phase, 'review')
  assert.match(research.reports.at(-1).text, /found it/)
  await assert.rejects(tool('close', { child: research.id }), /根拠/)
  await tool('close', { child: research.id, reason: '調査報告の参照先を依頼と照合した' })
  assert.equal(research.execution.outcome, 'accepted')
})


for (const provider of ['gpt', 'claude']) {
  test(`eco implements accepted research in the same ${provider} child and verifies it`, async (t) => {
    const { tool, team, manager, threads, agents, workspace } = await setupExecution(t, {}, {
      gpt: { enabled: provider === 'gpt', low: { model: 'gpt-6-luna' } },
      claude: { enabled: provider === 'claude', low: { model: 'haiku' } },
    })
    await tool('spawn', { ...exTask, provider, mode: 'research' })
    const child = team.children[0]
    const taskId = child.taskId
    const researchPayload = provider === 'gpt'
      ? threads.calls.findLast((call) => call[0] === 'send' && call[1] === taskId)[2]
      : agents.calls.findLast((call) => call[0] === 'run' && call[1] === taskId)[2]
    assert.match(researchPayload, /根拠が十分なら実装方針・検証案も添え/)
    assert.match(researchPayload, /読み取り専用の調査/)
    assert.doesNotMatch(researchPayload, /eco アプリの最終検証/)
    if (provider === 'gpt') threads.finish(taskId, 'investigation evidence')
    else agents.finish(taskId, 'investigation evidence')
    await tool('close', { child: child.id, reason: '原因と参照コードを照合した' })
    const research = structuredClone(child.execution)
    await manager.configureExecution(workspace, [{ id: 'test', command: 'node -e "console.log(1)"' }])
    await tool('implement', { child: child.id, title: '関連箇所の修正', task: 'fix source.txt only', criteria: '修正と回帰確認', checks: ['test'], maxRepairs: 0 })
    assert.equal(team.children.length, 1)
    assert.equal(child.taskId, taskId)
    assert.equal(child.execution.mode, 'write')
    assert.equal(child.execution.phase, 'working')
    assert.equal(child.title, '関連箇所の修正')
    assert.equal(child.execution.criteria, '修正と回帰確認')
    assert.deepEqual(child.execution.research, research, 'retain the original research judgment')
    assert.ok(child.execution.baseline.commit)
    assert.equal(child.execution.checks[0].id, 'test')
    const payload = provider === 'gpt'
      ? threads.calls.findLast((call) => call[0] === 'send' && call[1] === taskId)[2]
      : agents.calls.findLast((call) => call[0] === 'run' && call[1] === taskId)[2]
    assert.match(payload, /eco アプリの最終検証/)
    assert.ok(payload.includes(JSON.stringify({ id: 'test', cwd: '.', command: child.execution.checks[0].command })))
    assert.equal(payload.split('[eco 完了条件]').length, 2)
    await assert.rejects(tool('spawn', { ...exTask, provider }), /作業中|終わっていません/)
    if (provider === 'gpt') {
      assert.equal(threads.threads.get(taskId).permissionMode, 'danger-full-access')
      assert.equal(threads.threads.get(taskId).team.executionMode, 'write')
      assert.match(threads.calls.findLast((call) => call[0] === 'send' && call[1] === taskId)[2], /修正と回帰確認/)
    } else {
      const args = agents.sessions.get(taskId).args
      assert.equal(args.includes('--tools'), false, 'remove the research-only tool allowlist')
      assert.ok(args.includes('--disallowedTools'), 'delegation remains unavailable')
      assert.match(agents.calls.findLast((call) => call[0] === 'run')[2], /修正と回帰確認/)
    }
    await fs.writeFile(path.join(workspace, 'source.txt'), 'implemented')
    if (provider === 'gpt') threads.finish(taskId, 'implemented')
    else agents.finish(taskId, 'implemented')
    await Promise.all([...manager.exPending])
    assert.equal(child.execution.verification.status, 'passed')
    assert.match(await fs.readFile(child.execution.review.patch, 'utf8'), /\+implemented/)
    await assert.rejects(tool('close', { child: child.id }), /根拠/)
    await tool('close', { child: child.id, reason: '元の原因と修正差分・回帰検証を確認した' })
    assert.equal(child.execution.outcome, 'accepted')
  })
}

test('eco implement rejects unreviewed/abandoned research, invalid checks and writer conflicts without changing permissions', async (t) => {
  const { tool, team, threads } = await setupExecution(t)
  await tool('spawn', { ...exTask, mode: 'research' })
  const child = team.children[0]
  const args = { ...exTask, child: child.id }
  await assert.rejects(tool('implement', args), /close/)
  threads.finish(child.taskId, 'evidence')
  await assert.rejects(tool('implement', args), /close/)
  await tool('close', { child: child.id, accept: false, reason: '調査が不十分' })
  await assert.rejects(tool('implement', args), /close/)
  await tool('send', { child: child.id, message: 'investigate further' })
  threads.finish(child.taskId, 'more evidence')
  await tool('close', { child: child.id, reason: '調査を確認した' })
  await assert.rejects(tool('implement', { ...args, criteria: '' }), /criteria/)
  await assert.rejects(tool('implement', { ...args, checks: ['missing'] }), /登録/)
  await tool('spawn', exTask)
  await assert.rejects(tool('implement', args), /作業中|終わっていません/)
  assert.equal(child.closed, true)
  assert.equal(child.execution.mode, 'research')
  assert.equal(threads.threads.get(child.taskId).permissionMode, 'read-only')
  assert.equal(threads.calls.some((call) => call[0] === 'implementResearch'), false)
})

test('eco reserves the writer during implementation setup and stop prevents permission switching', async (t) => {
  const { tool, team, manager, threads } = await setupExecution(t)
  await tool('spawn', { ...exTask, mode: 'research' })
  const child = team.children[0]
  threads.finish(child.taskId, 'evidence')
  await tool('close', { child: child.id, reason: '調査を確認した' })
  let release
  manager.executionReview.start = () => new Promise((resolve) => { release = resolve })
  const starting = tool('implement', { ...exTask, child: child.id })
  await assert.rejects(tool('implement', { ...exTask, child: child.id }), /close/)
  await assert.rejects(tool('spawn', exTask), /終わっていません/)
  await manager.stopAll(team.id)
  release({ commit: 'baseline' })
  await assert.rejects(starting, /停止/)
  assert.equal(child.closed, true)
  assert.equal(child.execution.mode, 'research')
  assert.equal(threads.threads.get(child.taskId).permissionMode, 'read-only')
})

test('eco preserves accepted research when its runtime cannot switch, and does not start a fresh child', async (t) => {
  const { tool, team, threads } = await setupExecution(t)
  await tool('spawn', { ...exTask, mode: 'research' })
  const child = team.children[0]
  threads.finish(child.taskId, 'evidence')
  await tool('close', { child: child.id, reason: '調査を確認した' })
  const before = structuredClone(child)
  threads.implementResearch = async () => { throw new Error('session unavailable') }
  await assert.rejects(tool('implement', { ...exTask, child: child.id }), /session unavailable/)
  assert.deepEqual(child, before)
  assert.equal(team.children.length, 1)
})


test('eco saves implementation scope before moving runtimes and can recover an interrupted move with send', async (t) => {
  const { tool, team, manager, threads } = await setupExecution(t)
  await tool('spawn', { ...exTask, mode: 'research' })
  const child = team.children[0]
  const taskId = child.taskId
  threads.finish(taskId, 'evidence')
  await tool('close', { child: child.id, reason: '調査を確認した' })
  const move = threads.implementResearch
  let interrupted
  threads.implementResearch = async () => {
    const saved = JSON.parse(await fs.readFile(manager.file, 'utf8'))
    interrupted = saved.teams.find((entry) => entry.id === team.id).children.find((entry) => entry.id === child.id)
    assert.equal(interrupted.execution.mode, 'write')
    assert.equal(interrupted.execution.research.outcome, 'accepted')
    assert.ok(interrupted.execution.baseline.commit)
    throw new Error('interrupted before runtime move')
  }
  await assert.rejects(tool('implement', { ...exTask, child: child.id }), /interrupted/)
  // Replay the last durable work unit, as after a process interruption.
  Object.assign(child, interrupted)
  threads.implementResearch = move
  manager.start()
  assert.equal(child.execution.phase, 'review')
  assert.equal(threads.threads.get(taskId).permissionMode, 'read-only')
  await tool('send', { child: child.id, message: 'continue the recorded implementation scope' })
  assert.equal(child.taskId, taskId)
  assert.equal(child.execution.mode, 'write')
  assert.equal(threads.threads.get(taskId).permissionMode, 'danger-full-access')
  assert.equal(threads.threads.get(taskId).status, 'running')
})

test('stopping during a runtime switch leaves a reviewable writer without starting an implementation turn', async (t) => {
  const { tool, team, manager, threads } = await setupExecution(t)
  await tool('spawn', { ...exTask, mode: 'research' })
  const child = team.children[0]
  threads.finish(child.taskId, 'evidence')
  await tool('close', { child: child.id, reason: '調査を確認した' })
  const move = threads.implementResearch
  threads.implementResearch = async (id) => { await move(id); await manager.stopAll(team.id) }
  const sends = threads.calls.filter((call) => call[0] === 'send' && call[1] === child.taskId).length
  await assert.rejects(tool('implement', { ...exTask, child: child.id }), /停止/)
  assert.equal(child.execution.mode, 'write')
  assert.equal(child.execution.phase, 'review')
  assert.equal(child.execution.verification, undefined)
  assert.equal(threads.threads.get(child.taskId).permissionMode, 'danger-full-access')
  assert.equal(threads.calls.filter((call) => call[0] === 'send' && call[1] === child.taskId).length, sends)
  await assert.rejects(tool('close', { child: child.id, reason: 'cannot accept without verification' }), /成功していません/)
})

test('eco verify tool re-verifies the current files without a child turn', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await manager.configureExecution(workspace, [{ id: 'test', command: 'node -e "console.log(1)"' }])
  await tool('spawn', { ...exTask, checks: ['test'] })
  const child = team.children[0]
  threads.finish(child.taskId, 'done')
  await Promise.all([...manager.exPending])
  await fs.writeFile(path.join(workspace, 'source.txt'), 'parent edit')
  await assert.rejects(tool('close', { child: child.id }), /変更/)
  const turns = manager.summary(team).execution.metrics.childTurns
  await tool('verify', { child: child.id })
  await Promise.all([...manager.exPending])
  assert.equal(child.execution.verification.status, 'passed')
  assert.equal(manager.summary(team).execution.metrics.childTurns, turns)
  await assert.rejects(tool('close', { child: child.id }), /根拠/)
  assert.match(await fs.readFile(child.execution.review.patch, 'utf8'), /\+parent edit/)
  assert.match(await fs.readFile(child.execution.review.record, 'utf8'), /子の報告:\ndone/)
  const reason = 'source.txtの修正と元の原因を照合し、依頼範囲内であることを確認'
  await tool('close', { child: child.id, reason })
  assert.equal(child.execution.outcome, 'accepted')
  assert.equal(child.execution.reason, reason)
  await assert.rejects(tool('verify', { child: child.id }), /判定待ち/)
})

for (const failure of ['verify error', 'review error', 'record error', 'stop before verify', 'stop during review']) {
  test('eco revalidation invalidates earlier success on ' + failure, async (t) => {
    const { tool, team, manager, threads, workspace } = await setupExecution(t)
    await manager.configureExecution(workspace, [{ id: 'test', command: 'node -e "console.log(1)"' }])
    await tool('spawn', { ...exTask, checks: ['test'] })
    const child = team.children[0]
    threads.finish(child.taskId, 'done')
    await Promise.all([...manager.exPending])
    assert.equal(child.execution.verification.status, 'passed')
    assert.ok(child.execution.review)

    let reviewStarted, releaseReview
    const started = new Promise((resolve) => { reviewStarted = resolve })
    const release = new Promise((resolve) => { releaseReview = resolve })
    if (failure === 'verify error') manager.execution.verify = async () => { throw new Error('simulated verify I/O failure') }
    if (failure === 'review error') manager.executionReview.report = async () => { throw new Error('simulated review I/O failure') }
    if (failure === 'record error') {
      const verify = manager.execution.verify.bind(manager.execution)
      manager.execution.verify = async (args) => {
        const run = await verify(args)
        run.record = path.join(workspace, 'source.txt', 'result.json')
        return run
      }
      manager.executionReview.report = async () => ({ record: 'review.md', patch: null, warning: null })
    }
    if (failure === 'stop during review') {
      manager.executionReview.report = async () => {
        reviewStarted()
        await release
        return { record: 'review.md', patch: null, warning: null }
      }
    }
    const verifying = tool('verify', { child: child.id })
    if (failure === 'stop before verify') {
      const stopping = manager.stopAll(team.id)
      await Promise.all([verifying, stopping])
    } else {
      await verifying
      if (failure === 'stop during review') {
        await started
        await manager.stopAll(team.id)
        releaseReview()
      }
    }
    await Promise.all([...manager.exPending])
    assert.equal(child.reports.at(-1).kind, failure.startsWith('stop') ? 'cancelled' : 'error')
    await assert.rejects(tool('close', { child: child.id, reason: 'must not accept incomplete evidence' }), /成功していません/)
    assert.equal(child.execution.verification, undefined)
    assert.equal(child.execution.review, undefined)
  })
}

test('eco re-verifies once when a check rewrites the sources itself', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await manager.configureExecution(workspace, [{ id: 'fmt', allowSourceChanges: true, command: 'node -e "const fs=require(\'fs\');if(fs.readFileSync(\'source.txt\',\'utf8\')!==\'formatted\')fs.writeFileSync(\'source.txt\',\'formatted\')"' }])
  await tool('spawn', { ...exTask, checks: ['fmt'] })
  const child = team.children[0]
  threads.finish(child.taskId, 'done')
  await Promise.all([...manager.exPending])
  assert.equal(child.execution.verification.status, 'passed')
  assert.equal(child.execution.verification.rerun, true)
  const saved = JSON.parse(await fs.readFile(child.execution.verification.record, 'utf8'))
  assert.equal(saved.rerun, true)
  assert.equal(saved.previousRun.status, 'stale')
  assert.equal(JSON.parse(await fs.readFile(saved.previousRun.record, 'utf8')).status, 'stale')
  assert.match(child.reports.at(-1).text, /初回: stale/)
})

test('eco does not automatically reverify an ordinary check after source changes', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await manager.configureExecution(workspace, [{ id: 'test', command: `node -e "require('fs').writeFileSync('source.txt','unexpected')"` }])
  await tool('spawn', { ...exTask, checks: ['test'] })
  const child = team.children[0]
  threads.finish(child.taskId, 'done')
  await Promise.all([...manager.exPending])
  assert.equal(child.execution.verification.status, 'stale')
  assert.equal(team.execution.metrics.verifications, 1)
  assert.equal(child.execution.verification.rerun, undefined)
})

test('eco reports do not wait indefinitely for children still working', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 1_000_000
  const { tool, team, manager, threads } = await setupExecution(t, { gatherMs: REPORT_GATHER_MS, now: () => clock })
  const sent = () => threads.calls.filter((call) => call[0] === 'send' && call[1] === team.leaderId)
  await tool('spawn', { ...exTask, mode: 'research', name: 'R' })
  await tool('spawn', { ...exTask, name: 'W' })
  const writer = team.children[1]
  threads.finish(writer.taskId, 'done')
  await Promise.all([...manager.exPending])
  const before = sent().length
  clock += REPORT_GATHER_MS
  t.mock.timers.tick(REPORT_GATHER_MS)
  assert.equal(sent().length, before + 1)
})

test('eco stopAll before verification starts does not launch a command or auto-repair', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await manager.configureExecution(workspace, [{ id: 'test', command: 'node -e "process.exit(2)"', autoRepair: true }])
  await tool('spawn', { ...exTask, checks: ['test'] })
  const child = team.children[0]
  let calls = 0
  manager.execution.verify = async () => { calls++; throw new Error('must not execute') }
  threads.finish(child.taskId, 'done')
  await manager.stopAll(team.id)
  await Promise.all([...manager.exPending])
  assert.equal(calls, 0)
  assert.equal(child.execution.repairs, 0)
  assert.equal(child.execution.phase, 'review')
  assert.equal(child.reports.at(-1).kind, 'cancelled')
})

test('eco failed send preserves the reviewed evidence and restart interrupts verification', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await tool('spawn', exTask)
  const child = team.children[0]
  threads.finish(child.taskId, 'done')
  await Promise.all([...manager.exPending])
  const verification = structuredClone(child.execution.verification)
  const send = threads.send
  threads.send = async () => { throw new Error('send failed') }
  await assert.rejects(tool('send', { child: child.id, message: 'fix' }), /send failed/)
  assert.equal(child.execution.phase, 'review')
  assert.deepEqual(child.execution.verification, verification)
  threads.send = send
  child.execution.phase = 'verifying'
  manager.start()
  assert.equal(child.execution.phase, 'review')
  assert.equal(child.execution.verification, undefined)
  assert.equal(child.reports.at(-1).kind, 'error')
  assert.throws(() => manager.guardExecution({ id: 'other', workspace: path.join(workspace, 'nested') }), /eco/)
})

test('eco accepts an explicitly chosen API parent and records mode in launch tools', async (t) => {
  const { manager, workspace } = await setupExecution(t)
  const result = await manager.create({ workspace, execution: { leaderModel: '["anthropic","claude-haiku-5-5"]' } })
  assert.equal(result.thread.model, '["anthropic","claude-haiku-5-5"]')
  assert.equal(result.thread.title, 'エコモード')
  assert.equal(result.team.execution.metrics.childTurns, 0)
  const mcp = manager.mcpServerFor({ team: { id: result.team.id, role: 'leader' } })
  assert.ok(mcp.env.some((entry) => entry.name === 'AGENT_DESK_EXECUTION'))
})

test('team auth consent persists sanitized mode without changing providers and guards existing disabled children', async (t) => {
  const { manager, team, tool, terminals, leader, workspace } = await setup(t)
  manager.claudeAuth.find = () => 'fake'
  manager.claudeAuth.detect = async () => ({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', email: 'private@example.test', token: 'SECRET' })
  const before = structuredClone(team.config)
  const context = { record: terminals.records.get(leader), cwd: workspace, env: {}, claude: 'fake' }
  assert.ok(await manager.guardClaudeLaunch(context))
  const view = await manager.inspectClaudeAuth({ teamId: team.id })
  await manager.updateConfig(team.id, {}, { challenge: view.challenge })
  assert.equal(await manager.guardClaudeLaunch(context), null)
  assert.ok(await manager.guardClaudeLaunch({ ...context, cwd: path.join(workspace, 'other') }))
  assert.deepEqual(team.config, before)
  await tool('spawn', { provider: 'claude', tier: 'low', title: 'child', task: 'work' })
  const child = team.children[0]
  manager.updateConfig(team.id, { claude: { enabled: false } })
  assert.equal(await manager.guardClaudeLaunch({ ...context, record: { id: child.taskId } }), null)
  manager.claudeAuth.detect = async () => null
  assert.ok(await manager.guardClaudeLaunch({ ...context, record: { id: child.taskId } }))
  await manager.writes
  const saved = JSON.parse(await fs.readFile(manager.file, 'utf8'))
  assert.deepEqual(saved.teams[0].claudeAuthConsent, team.claudeAuthConsent)
  assert.doesNotMatch(JSON.stringify(saved), /private@example|SECRET/)
  assert.ok(await manager.guardClaudeLaunch({ ...context, record: { id: 'orphan' } }))
})

test('the billing confirmation is written at once, to its own file, and still holds after a restart with no team left', async (t) => {
  const { manager, team, dir, threads, terminals, agents, workspace } = await setup(t)
  const status = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }
  manager.claudeAuth.find = () => 'fake'
  manager.claudeAuth.detect = async () => status
  const view = await manager.inspectClaudeAuth({ teamId: team.id })
  await manager.updateConfig(team.id, {}, { challenge: view.challenge })
  // On disk before anything else is saved, and not inside teams.json.
  const file = path.join(dir, 'claude-auth-consent.json')
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).accepted.length, 1)
  await manager.stop()
  await fs.rm(path.join(dir, 'teams.json'))
  const again = await new TeamManager({
    file: path.join(dir, 'teams.json'), dir: path.join(dir, 'teams'), threads, terminals, agents, catalog: CATALOG,
    getSettings: () => ({}), apiUrl: () => '',
  }).load()
  t.after(() => again.stop())
  again.claudeAuth.find = () => 'fake'
  again.claudeAuth.detect = async () => status
  assert.equal(again.list().length, 0)
  assert.equal((await again.inspectClaudeAuth({ workspace })).confirmed, true)
  // A different auth mode is still asked.
  again.claudeAuth.detect = async () => ({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })
  assert.equal((await again.inspectClaudeAuth({ workspace })).confirmed, false)
})

test('a team confirmed before the confirmation was shared is remembered for new teams', async (t) => {
  const { manager, team, dir, threads, terminals, agents, workspace } = await setup(t)
  team.claudeAuthConsent = { teamId: team.id, workspace, descriptor: { version: 1, mode: 'api', authMethod: 'api_key', apiProvider: 'firstParty' }, acknowledgeUnknown: false, confirmedAt: 1 }
  await manager.updateConfig(team.id, {})
  await manager.writes
  await manager.stop()
  const again = await new TeamManager({
    file: path.join(dir, 'teams.json'), dir: path.join(dir, 'teams'), threads, terminals, agents, catalog: CATALOG,
    getSettings: () => ({}), apiUrl: () => '',
  }).load()
  t.after(() => again.stop())
  again.claudeAuth.find = () => 'fake'
  again.claudeAuth.detect = async () => ({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' })
  assert.equal((await again.inspectClaudeAuth({ workspace })).confirmed, true)
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'claude-auth-consent.json'), 'utf8')).accepted.length, 1)
})

test('the leader starts with the team tools and instructions; other options come from the settings', async (t) => {
  const { terminals, leader, team, workspace } = await setup(t)
  const create = terminals.calls.find((call) => call[0] === 'create')[1]
  assert.deepEqual(create.team, { id: team.id, role: 'leader' })
  assert.equal(create.model, 'opus')
  const args = terminals.records.get(leader).launch.args
  assert.deepEqual(args.slice(0, 2), ['--permission-mode', 'bypassPermissions'])
  assert.equal(args[args.indexOf('--allowedTools') + 1], `mcp__${MCP_SERVER}`)
  const mcp = JSON.parse(await fs.readFile(args[args.indexOf('--mcp-config') + 1], 'utf8'))
  assert.deepEqual(mcp.mcpServers[MCP_SERVER].env, {
    AGENT_DESK_TEAM_URL: 'http://127.0.0.1:47130/api/team', AGENT_DESK_TEAM_ID: team.id, AGENT_DESK_TEAM_SECRET: team.secret,
  })
  assert.equal(mcp.mcpServers[MCP_SERVER].command, 'C:\\node.exe')
  const prompt = await fs.readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')
  assert.match(prompt, /you are the leader/)
  assert.ok(prompt.includes(workspace))
  assert.match(prompt, /provider "gpt".*low = GPT-6 Luna.*mid = GPT-6\.1 Sol/)
  assert.match(prompt, /provider "claude".*low = Claude Haiku（最新）/)
})

test('a tool call needs the team\'s secret', async (t) => {
  const { manager, team } = await setup(t)
  await assert.rejects(manager.call(team.id, 'wrong', 'status', {}), (error) => error.status === 403)
  await assert.rejects(manager.call('nope', team.secret, 'status', {}), (error) => error.status === 403)
})

test('a GPT child is a full-access dsh task whose first message names it and gives its task', async (t) => {
  const { threads, tool, team, workspace } = await setup(t)
  const text = await tool('spawn', { title: '生き物 1〜50', task: 'models/1-50 を改善する', tier: 'low', provider: 'gpt', name: 'A' })
  assert.match(text, /子「A」を起動しました（GPT-6 Luna・低）/)
  const [, options] = threads.calls.find((call) => call[0] === 'create')
  assert.deepEqual(options, {
    workspace, model: '["openai-codex","gpt-6-luna"]', effort: 'medium', permissionMode: 'danger-full-access', toolMode: 'native',
    team: { id: team.id, childId: team.children[0].id },
  })
  const [, , message] = threads.calls.find((call) => call[0] === 'send')
  assert.ok(message.startsWith(PREFIX))
  assert.match(message, /You are the child agent "A" of this Agent Desk team/)
  // Its standing instructions are in its system prompt (team-child-plugin.js), not here.
  assert.doesNotMatch(message, /Never stop to ask/)
  assert.match(message, /# Task: 生き物 1〜50\n\nmodels\/1-50 を改善する/)
  assert.deepEqual(threads.calls.find((call) => call[0] === 'update')[2], { title: 'A: 生き物 1〜50' })
})

test('spawn explains what the leader got wrong', async (t) => {
  const { tool, manager, team } = await setup(t)
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'high', provider: 'gpt' }), /tier は "low" か "mid"/)
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', provider: 'unknown' }), /provider は/)
  await assert.rejects(tool('spawn', { title: '', task: 'y', tier: 'low', provider: 'gpt' }), /title/)
  // Changed in the team's panel while it runs.
  manager.updateConfig(team.id, { gpt: { enabled: false } })
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'low', provider: 'gpt' }), /設定でオフ/)
  // With one provider left the leader may leave it out.
  assert.match(await tool('spawn', { title: 'x', task: 'y', tier: 'low' }), /Claude Haiku（最新）・低/)
  manager.updateConfig(team.id, { gpt: { enabled: true, low: { model: null } } })
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'low', provider: 'gpt' }), /モデルが設定されていません/)
  manager.updateConfig(team.id, { maxChildren: 1 })
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'mid', provider: 'claude' }), /上限（1 人）/)
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'mid', provider: 'claude', name: '子1' }), /上限/)
})

test('a team runs with what was chosen when it started; the saved settings only start the next one', async (t) => {
  const { manager, workspace, team, setSettings, tool, terminals, leader, typed } = await setup(t)
  const started = await manager.create({ workspace, choices: { maxChildren: 2, claude: { low: { model: 'claude-haiku-5-5' } } } })
  assert.equal(started.team.config.maxChildren, 2)
  assert.equal(started.team.config.claude.low.model, 'claude-haiku-5-5')
  // The first team keeps its own, whatever the settings say now.
  setSettings(mergeTeamConfig(TEAM_DEFAULTS, { gpt: { enabled: false } }))
  assert.match(await tool('spawn', { title: 'x', task: 'y', tier: 'low', provider: 'gpt' }), /GPT-6 Luna/)
  await assert.rejects(manager.create({ workspace, choices: { maxChildren: 99 } }), /1〜12/)
  // Who leads cannot change; the leader hears of new tiers.
  terminals.set(leader, { activity: 'idle' })
  manager.updateConfig(team.id, { leaderProvider: 'gpt', claude: { mid: { model: 'opus' } } })
  assert.equal(manager.summary(team).leaderKind, 'terminal')
  assert.equal(manager.summary(team).config.leaderProvider, 'claude')
  assert.match(typed().at(-1), /設定を変えました[\s\S]*mid = Claude Opus（最新）/)
})

test('with batchReports off, reports reach the idle leader one at a time, in the order the children finished', async (t) => {
  const { threads, terminals, tool, leader, typed } = await setup(t, { batchReports: false })
  await tool('spawn', { title: 'first', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  await tool('spawn', { title: 'second', task: 'b', tier: 'mid', provider: 'gpt', name: 'B' })
  // Both finish while the leader is still on its turn.
  terminals.set(leader, { activity: 'running' })
  threads.finish('thread-2', 'B の報告')
  threads.finish('thread-1', 'A の報告')
  assert.equal(typed().length, 0)
  terminals.set(leader, { activity: 'idle' })
  assert.equal(typed().length, 1)
  assert.match(typed()[0], /子「B」（GPT-6\.1 Sol・中）から報告が届きました（このあとに 1 件が待っています）/)
  assert.match(typed()[0], /業務: second\n---\nB の報告\n---/)
  // It works on the first one; the second waits for its turn to end.
  terminals.set(leader, { activity: 'running' })
  assert.equal(typed().length, 1)
  terminals.set(leader, { activity: 'idle' })
  assert.equal(typed().length, 2)
  assert.match(typed()[1], /子「A」.*から報告が届きました\n/)
})

test('reports that waited while the leader worked reach it together, with the next steps once', async (t) => {
  const { threads, terminals, tool, leader, typed, manager, team } = await setup(t)
  await tool('spawn', { title: 'first', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  await tool('spawn', { title: 'second', task: 'b', tier: 'mid', provider: 'gpt', name: 'B' })
  terminals.set(leader, { activity: 'running' })
  threads.finish('thread-2', 'B の報告')
  threads.finish('thread-1', 'A の報告')
  terminals.set(leader, { activity: 'idle' })
  assert.equal(typed().length, 1)
  const [message] = typed()
  assert.match(message, /^\[Agent Desk チーム\] 2 件がまとめて届きました。/)
  assert.match(message, /#[0-9a-f]{8} 子「B」.*から報告が届きました\n業務: second\n---\nB の報告\n---\n\n\[Agent Desk チーム\] #[0-9a-f]{8} 子「A」/)
  assert.equal(message.match(/合格なら close/g).length, 1)
  assert.equal(team.queue.length, 0)
  // Either mark tells the leader took it.
  const marks = [...message.matchAll(/#([0-9a-f]{8})/g)].map((match) => match[1])
  terminals.emit('hook', { terminalId: leader, input: { hook_event_name: 'UserPromptSubmit', team_marks: marks.slice(1) } })
  assert.equal(manager.summary(team).delivery, 'idle')
})

test('a batch the leader could not be given goes back to the queue whole', async (t) => {
  const { threads, terminals, tool, leader, typed, team } = await setup(t)
  await tool('spawn', { title: 'first', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  await tool('spawn', { title: 'second', task: 'b', tier: 'low', provider: 'gpt', name: 'B' })
  terminals.set(leader, { activity: 'running' })
  threads.finish('thread-1', 'A の報告')
  threads.finish('thread-2', 'B の報告')
  terminals.sendMessage = () => { throw new Error('closed') }
  terminals.set(leader, { activity: 'idle' })
  assert.equal(typed().length, 0)
  assert.deepEqual(team.queue.map((item) => item.text), ['A の報告', 'B の報告'])
})

test('a batch stops before it gets too long to paste', async (t) => {
  const { threads, terminals, tool, leader, typed, team } = await setup(t)
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) await tool('spawn', { title: name, task: 'x', tier: 'low', provider: 'gpt', name })
  terminals.set(leader, { activity: 'running' })
  for (let index = 1; index <= 6; index += 1) threads.finish(`thread-${index}`, 'x'.repeat(2000))
  terminals.set(leader, { activity: 'idle' })
  // Each is shortened to REPORT_PREVIEW: five fit in one message, the sixth waits.
  assert.match(typed()[0], /5 件がまとめて届きました（このあとに 1 件が待っています）/)
  assert.equal(team.queue.length, 1)
})

test('while other children still work, a report waits a little for theirs and they go together', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 1_000_000
  const wait = (ms) => { clock += ms; t.mock.timers.tick(ms) }
  const { threads, tool, typed, team } = await setup(t, {}, { gatherMs: REPORT_GATHER_MS, now: () => clock })
  for (const name of ['A', 'B', 'C']) await tool('spawn', { title: name, task: 'x', tier: 'low', provider: 'gpt', name })
  threads.finish('thread-1', 'A の報告')
  wait(10_000)
  threads.finish('thread-2', 'B の報告')
  assert.equal(typed().length, 0)
  // Counted from the oldest: C is still working, but A has waited long enough.
  wait(REPORT_GATHER_MS - 10_000)
  assert.equal(typed().length, 1)
  assert.match(typed()[0], /^\[Agent Desk チーム\] 2 件がまとめて届きました。[\s\S]*A の報告[\s\S]*B の報告/)
  assert.equal(team.queue.length, 0)
})

test('the last child working does not wait, and neither does an approval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clock = 1_000_000
  const { threads, tool, typed, leader, terminals } = await setup(t, {}, { gatherMs: REPORT_GATHER_MS, now: () => clock })
  for (const name of ['A', 'B']) await tool('spawn', { title: name, task: 'x', tier: 'low', provider: 'gpt', name })
  threads.finish('thread-1', 'A の報告')
  assert.equal(typed().length, 0)
  threads.finish('thread-2', 'B の報告')
  assert.equal(typed().length, 1)
  assert.match(typed()[0], /2 件がまとめて届きました/)
  terminals.set(leader, { activity: 'running' })
  terminals.set(leader, { activity: 'idle' })
  // C works, but a child held up on an approval does not wait for it.
  await tool('send', { child: 'A', message: 'もう一度' })
  await tool('spawn', { title: 'C', task: 'x', tier: 'low', provider: 'gpt', name: 'C' })
  threads.permissions.push({ threadId: 'thread-1', requestId: 'req-1', name: 'shell', input: { command: 'ls' }, options: [] })
  threads.emit('approval-needed', { threadId: 'thread-1' })
  assert.equal(typed().length, 2)
  assert.match(typed()[1], /承認待ち/)
})

test('a GPT child that starts a subagent anyway is stopped, and the leader hears why', async (t) => {
  const { threads, manager, tool, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  await manager.stopApiUse('thread-1')
  // The subagent's next update does not cancel again.
  await manager.stopApiUse('thread-1')
  assert.deepEqual(threads.calls.filter((call) => call[0] === 'cancel'), [['cancel', 'thread-1']])
  threads.finish('thread-1', '途中まで', 'cancelled')
  assert.equal(typed().length, 1)
  assert.match(typed()[0], /子「A」.*がエラーで止まりました/)
  assert.match(typed()[0], /子はサブエージェントを使えません/)
  assert.match(typed()[0], /途中まで/)
})

test('a report waits while the leader works or someone types into it', async (t) => {
  const { threads, terminals, tool, leader, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt' })
  terminals.set(leader, { activity: 'running' })
  threads.finish('thread-1', 'done')
  assert.equal(typed().length, 0)
  terminals.set(leader, { activity: 'idle', inputAt: Date.now() })
  assert.equal(typed().length, 0)
  await wait(TYPING_QUIET_MS + 150)
  assert.equal(typed().length, 1)
})

test('a long report is shortened for the message and kept whole for read_report', async (t) => {
  const { threads, terminals, tool, leader, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  terminals.set(leader, { activity: 'idle' })
  const long = `${'x'.repeat(REPORT_PREVIEW)}END`
  threads.finish('thread-1', long)
  assert.ok(!typed()[0].includes('END'))
  assert.match(typed()[0], /read_report/)
  assert.ok((await tool('read_report', { child: 'a' })).endsWith('END'))
})

test('a leader that is not running is started on the report', async (t) => {
  const { threads, terminals, tool, leader } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  terminals.states.set(leader, { state: 'stopped', activity: 'idle', ready: false, inputAt: 0 })
  threads.finish('thread-1', 'できました')
  const [, id, prompt] = terminals.calls.find((call) => call[0] === 'restart')
  assert.equal(id, leader)
  const file = prompt.slice(prompt.lastIndexOf(': ') + 2)
  assert.match(await fs.readFile(file, 'utf8'), /子「A」.*から報告が届きました[\s\S]*できました/)
})

test('a pasted report the leader does not start on gets Enter once more, then waits for a retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { threads, terminals, tool, leader, manager, team, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt' })
  terminals.set(leader, { activity: 'idle' })
  threads.finish('thread-1', 'done')
  assert.equal(typed().length, 1)
  t.mock.timers.tick(DELIVERY_CHECK_MS)
  assert.deepEqual(terminals.calls.at(-1), ['enter', leader])
  // Claude Code can be slow to take in a paste: it is still being handed over.
  t.mock.timers.tick(DELIVERY_GIVE_UP_MS - 1)
  assert.equal(manager.summary(team).delivery, 'delivering')
  t.mock.timers.tick(1)
  assert.equal(manager.summary(team).delivery, 'failed')
  assert.equal(team.queue.length, 1)
  manager.retryDelivery(team.id)
  assert.equal(typed().length, 2)
  terminals.set(leader, { activity: 'running' })
  assert.equal(manager.summary(team).delivery, 'idle')
})

/** The marks the messages typed into the leader carry (claude-hook.js reports them back). */
const marksOf = (texts) => texts.map((text) => text.startsWith(PREFIX) ? text.slice(PREFIX.length).match(/^ #([0-9a-f]{8}) /)?.[1] : undefined)

test('each message to the leader is marked, so the leader taking it is known', async (t) => {
  const { threads, terminals, tool, leader, manager, team, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  terminals.set(leader, { activity: 'idle' })
  threads.finish('thread-1', 'done')
  const [mark] = marksOf(typed())
  assert.ok(mark)
  terminals.took(leader, [mark])
  assert.equal(manager.summary(team).delivery, 'idle')
  assert.equal(team.queue.length, 0)
})

test('a report the leader takes after it was given up is not sent again, and the rest go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { threads, terminals, tool, leader, manager, team, typed } = await setup(t)
  await tool('spawn', { title: 'first', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  await tool('spawn', { title: 'second', task: 'b', tier: 'low', provider: 'gpt', name: 'B' })
  terminals.set(leader, { activity: 'idle' })
  threads.finish('thread-1', 'A の報告')
  threads.finish('thread-2', 'B の報告')
  t.mock.timers.tick(DELIVERY_CHECK_MS)
  t.mock.timers.tick(DELIVERY_GIVE_UP_MS)
  assert.equal(manager.summary(team).delivery, 'failed')
  assert.equal(team.queue.length, 2)
  // Claude Code took in the paste at last.
  terminals.took(leader, marksOf(typed()))
  assert.equal(team.queue.length, 1)
  terminals.set(leader, { activity: 'idle' })
  assert.equal(typed().length, 2)
  assert.match(typed()[1], /子「B」/)
})

test('after a report was given up, the leader taking something else lets the reports go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { threads, terminals, tool, leader, manager, team, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  terminals.set(leader, { activity: 'idle' })
  threads.finish('thread-1', 'done')
  t.mock.timers.tick(DELIVERY_CHECK_MS)
  t.mock.timers.tick(DELIVERY_GIVE_UP_MS)
  assert.equal(manager.summary(team).delivery, 'failed')
  // The user wrote to the leader: nothing of the report is left in its input box.
  terminals.took(leader, [])
  assert.equal(manager.summary(team).delivery, 'waiting')
  terminals.set(leader, { activity: 'idle' })
  assert.equal(typed().length, 2)
  assert.deepEqual(marksOf(typed().slice(1)), marksOf(typed().slice(0, 1)))
})

test('read_report gives the reports that had not reached the leader, and they are not sent again', async (t) => {
  const { agents, terminals, tool, leader, team, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'mid', provider: 'claude', name: 'S' })
  const child = team.children[0]
  terminals.set(leader, { activity: 'running' })
  agents.finish(child.taskId, '一回目')
  agents.run(child.taskId, '続けて')
  agents.finish(child.taskId, '二回目')
  assert.equal(team.queue.length, 2)
  const text = await tool('read_report', { child: 'S' })
  assert.match(text, /まだ届いていなかった報告 2 件/)
  assert.ok(text.indexOf('一回目') < text.indexOf('二回目'))
  assert.equal(team.queue.length, 0)
  terminals.set(leader, { activity: 'idle' })
  assert.equal(typed().length, 0)
  // Nothing waiting: just the latest one.
  assert.match(await tool('read_report', { child: 'S' }), /の最新の報告（[\s\S]*二回目$/)
})

test('a Claude child is headless Claude Code in bypass mode that starts on its task and reports when its turn ends', async (t) => {
  const { agents, terminals, tool, leader, team, manager, workspace, typed } = await setup(t)
  await tool('spawn', { title: '効果音', task: 'sfx を作る', tier: 'mid', provider: 'claude', name: 'S' })
  const [, options] = agents.calls.find((call) => call[0] === 'create')
  const child = team.children[0]
  assert.equal(child.kind, 'agent')
  assert.equal(options.workspace, workspace)
  assert.equal(options.model, 'sonnet')
  assert.deepEqual(options.args.slice(0, 4), ['--permission-mode', 'bypassPermissions', '--disallowedTools', 'AskUserQuestion,EnterPlanMode,ExitPlanMode,Task,Agent,Workflow,SendMessage,ListAgents,RemoteTrigger,CronCreate,ScheduleWakeup'])
  assert.match(await fs.readFile(options.args[options.args.indexOf('--append-system-prompt-file') + 1], 'utf8'), /You have no subagent tools/)
  assert.match(await fs.readFile(options.args[options.args.indexOf('--append-system-prompt-file') + 1], 'utf8'), /you are the child agent "S"/)
  assert.deepEqual(agents.calls.find((call) => call[0] === 'run'), ['run', child.taskId, '# Task from the team leader: 効果音\n\nsfx を作る'])
  // No terminal of its own: the leader is the team's only one.
  assert.equal(terminals.calls.filter((call) => call[0] === 'create').length, 1)
  assert.equal(manager.summary(team).children[0].state, 'running')
  terminals.set(leader, { activity: 'idle' })
  agents.finish(child.taskId, '効果音を 12 個作りました', 'done', { denials: [{ tool_name: 'Bash', tool_input: { command: 'git push' } }] })
  assert.match(typed()[0], /子「S」（Claude Sonnet（最新）・中）から報告[\s\S]*効果音を 12 個作りました/)
  assert.match(typed()[0], /承認が必要なため実行されなかった操作）\n- Bash: git push/)
  assert.equal(manager.summary(team).children[0].state, 'idle')
  // The user wrote to the child in its view: that reply reaches the leader too, marked as such.
  terminals.set(leader, { activity: 'running' })
  manager.messageChild(team.id, child.id, 'ついでに音量もそろえて')
  assert.deepEqual(agents.calls.at(-1), ['run', child.taskId, 'ついでに音量もそろえて'])
  // While it works, another message waits for the turn to end.
  assert.deepEqual(manager.messageChild(team.id, child.id, 'もう一つ').team.children[0].followups.map((entry) => entry.text), ['もう一つ'])
  terminals.set(leader, { activity: 'idle' })
  agents.finish(child.taskId, '音量もそろえました')
  assert.equal(typed().length, 2)
  assert.match(typed()[1], /子「S」.*から追加の報告が届きました（あなたが送った指示とは別に/)
})

test('what the user writes to a working Claude child waits, then goes as one turn; it can be given at once or taken back', async (t) => {
  const { agents, terminals, tool, leader, team, manager, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'mid', provider: 'claude', name: 'S' })
  const child = team.children[0]
  const followups = () => manager.summary(team).children[0].followups
  terminals.set(leader, { activity: 'idle' })

  // It works: messages wait, in order, and are kept with the team.
  manager.messageChild(team.id, child.id, 'one')
  manager.messageChild(team.id, child.id, 'two')
  manager.messageChild(team.id, child.id, 'three')
  assert.deepEqual(followups().map((entry) => entry.text), ['one', 'two', 'three'])
  assert.equal(agents.calls.filter((call) => call[0] === 'run').length, 1)
  assert.equal(JSON.parse(JSON.stringify(team)).children[0].followups.length, 3)

  // "Interrupt": one is given to the running turn now, and leaves the wait.
  const [, second] = followups()
  assert.equal(manager.steerFollowup(team.id, child.id, second.id).steered, true)
  assert.deepEqual(agents.calls.at(-1), ['steer', child.taskId, 'two'])
  assert.deepEqual(followups().map((entry) => entry.text), ['one', 'three'])
  // Taken back: gone without being sent.
  manager.dropFollowup(team.id, child.id, followups()[0].id)
  assert.deepEqual(followups().map((entry) => entry.text), ['three'])
  // One that is not there any more does nothing.
  assert.equal(manager.steerFollowup(team.id, child.id, second.id).steered, false)

  // The turn ends: what waits goes as the next turn, and the reply is the user's own, not the leader's.
  agents.finish(child.taskId, '最初の作業')
  assert.deepEqual(agents.calls.at(-1), ['run', child.taskId, 'three'])
  assert.equal(followups().length, 0)
  assert.equal(child.awaiting, false)
  assert.equal(typed().length, 1)
  // The leader takes the first report and finishes with it.
  terminals.set(leader, { activity: 'running' })
  terminals.set(leader, { activity: 'idle' })
  agents.finish(child.taskId, '返事')
  assert.match(typed()[1], /から追加の報告が届きました/)

  // A turn that cannot take it leaves it waiting.
  agents.run(child.taskId, 'x')
  agents.sessions.get(child.taskId).steerable = false
  manager.messageChild(team.id, child.id, 'late')
  assert.equal(manager.steerFollowup(team.id, child.id, followups()[0].id).steered, false)
  assert.deepEqual(followups().map((entry) => entry.text), ['late'])
  assert.throws(() => manager.messageChild(team.id, 'no-such-child', 'x'), /見つかりません/)
})

test('the leader\'s message reaches a working Claude child at its next step, or waits for the turn to end when it cannot', async (t) => {
  const { agents, tool, team, manager } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'mid', provider: 'claude', name: 'S' })
  const child = team.children[0]
  assert.match(await tool('send', { child: 'S', message: '方針を変えて' }), /割り込みで渡しました/)
  assert.deepEqual(agents.calls.at(-1), ['steer', child.taskId, '[リーダーから]\n方針を変えて'])
  assert.equal(child.pending.length, 0)
  assert.equal(child.awaiting, true)

  agents.sessions.get(child.taskId).steerable = false
  assert.match(await tool('send', { child: 'S', message: '続きはこれ' }), /終わりしだい渡します/)
  assert.equal(child.pending.length, 1)
  // The user's own message and the leader's go together once the child is free; the leader's makes it theirs to answer.
  manager.messageChild(team.id, child.id, 'ついでに')
  agents.finish(child.taskId, '終わり')
  assert.deepEqual(agents.calls.at(-1), ['run', child.taskId, '[リーダーから]\n続きはこれ\n\nついでに'])
  assert.equal(child.awaiting, true)
  assert.equal(manager.summary(team).children[0].followups.length, 0)
})

test('a closed child\'s own turns stay its own', async (t) => {
  const { agents, terminals, tool, leader, team, manager, typed } = await setup(t)
  await tool('spawn', { title: '効果音', task: 'sfx を作る', tier: 'mid', provider: 'claude', name: 'S' })
  const child = team.children[0]
  terminals.set(leader, { activity: 'idle' })
  agents.finish(child.taskId, '完了')
  assert.equal(typed().length, 1)
  terminals.set(leader, { activity: 'running' })
  await tool('close', { child: 'S' })
  assert.equal(manager.summary(team).children[0].state, 'closed')
  manager.messageChild(team.id, child.id, '雑談')
  terminals.set(leader, { activity: 'idle' })
  agents.finish(child.taskId, 'ユーザーとの雑談')
  assert.equal(typed().length, 1)
})

test('a Claude child that fails or is stopped tells the leader', async (t) => {
  const { agents, terminals, tool, leader, team, manager, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  terminals.set(leader, { activity: 'idle' })
  agents.finish(team.children[0].taskId, '', 'error', { error: 'rate_limit' })
  assert.match(typed()[0], /エラーで止まりました[\s\S]*rate_limit/)
  assert.equal(manager.summary(team).children[0].state, 'error')
  terminals.set(leader, { activity: 'running' })
  await tool('send', { child: 'C', message: '続けて' })
  manager.stopChild(team.id, team.children[0].id)
  terminals.set(leader, { activity: 'idle' })
  assert.match(typed()[1], /子「C」.*の作業が途中で止められました/)
})

test('stopAll ends the turn of every working child, Claude or GPT, and leaves the idle ones and every conversation alone', async (t) => {
  const { agents, threads, tool, team, manager } = await setup(t)
  await tool('spawn', { title: 'claude job', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  await tool('spawn', { title: 'gpt job', task: 'b', tier: 'low', provider: 'gpt', name: 'G' })
  await tool('spawn', { title: 'idle job', task: 'c', tier: 'low', provider: 'claude', name: 'I' })
  const [claude, gpt, idle] = team.children
  agents.finish(idle.taskId, 'done')
  assert.equal(agents.running(claude.taskId), true)
  assert.equal(threads.threads.get(gpt.taskId).status, 'running')

  const { stopped } = await manager.stopAll(team.id)
  assert.equal(stopped, 2)
  assert.equal(agents.running(claude.taskId), false)
  assert.deepEqual(threads.calls.filter((call) => call[0] === 'cancel'), [['cancel', gpt.taskId]])
  assert.deepEqual(agents.calls.filter((call) => call[0] === 'stop'), [['stop', claude.taskId]])
  assert.equal(team.children.some((child) => child.closed), false)
  assert.equal(agents.calls.some((call) => call[0] === 'remove'), false)

  // Nothing is working any more: a second press stops nothing.
  agents.finish(idle.taskId, 'done')
  threads.threads.get(gpt.taskId).status = 'idle'
  assert.equal((await manager.stopAll(team.id)).stopped, 0)
  await assert.rejects(() => manager.stopAll('no-such-team'), /チームが見つかりません/)
})

test('after stopAll the leader is told the user stopped the child and is not invited to go on; one child stopped alone keeps the old wording', async (t) => {
  const { agents, threads, terminals, leader, tool, team, manager, typed } = await setup(t)
  await tool('spawn', { title: 'claude job', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  await tool('spawn', { title: 'gpt job', task: 'b', tier: 'low', provider: 'gpt', name: 'G' })
  terminals.set(leader, { activity: 'running' })
  await manager.stopAll(team.id)
  // The GPT child's turn ends as the thread manager reports a cancelled one.
  const gpt = team.children[1]
  threads.threads.get(gpt.taskId).status = 'idle'
  threads.emit('turn-finished', { threadId: gpt.taskId, status: 'cancelled' })
  assert.deepEqual(team.queue.map((item) => [item.kind, item.byUser]), [['cancelled', true], ['cancelled', true]])
  terminals.set(leader, { activity: 'idle' })
  const first = typed()[0]
  assert.match(first, /ユーザーが全停止で止めました/)
  assert.match(first, /ユーザーから指示があるまで続きの指示を送らないでください/)
  assert.doesNotMatch(first, /続けるなら send/)

  // The flag is spent with the turn: a later stop by itself reads as before.
  await tool('send', { child: 'C', message: '続けて' })
  manager.stopChild(team.id, team.children[0].id)
  const later = team.queue.at(-1)
  assert.deepEqual([later.childId, later.kind, later.byUser], [team.children[0].id, 'cancelled', undefined])
})

test('send reaches a child however it is: idle, busy, or closed', async (t) => {
  const { agents, threads, tool, team } = await setup(t)
  await tool('spawn', { title: 'claude job', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  await tool('spawn', { title: 'gpt job', task: 'b', tier: 'low', provider: 'gpt', name: 'G' })
  const [claude, gpt] = team.children
  // Busy: Claude reads it at its next step; when that cannot be, it gets it when its turn ends, as GPT does whose steer failed.
  assert.match(await tool('send', { child: 'C', message: '手順を変えて' }), /割り込みで渡しました/)
  assert.deepEqual(agents.calls.at(-1), ['steer', claude.taskId, '[リーダーから]\n手順を変えて'])
  agents.sessions.get(claude.taskId).steerable = false
  assert.match(await tool('send', { child: 'C', message: '色を直して' }), /終わりしだい/)
  assert.match(await tool('send', { child: 'G', message: '名前を直して' }), /終わりしだい/)
  agents.finish(claude.taskId, '一回目')
  await tick()
  assert.deepEqual(agents.calls.at(-1), ['run', claude.taskId, '[リーダーから]\n色を直して'])
  threads.finish(gpt.taskId, '一回目')
  await tick()
  assert.equal(threads.calls.filter((call) => call[0] === 'send').at(-1)[2], '[リーダーから]\n名前を直して')
  // Closed: its turn stops, and a later send resumes its conversation on the message.
  await tool('close', { child: 'C' })
  assert.deepEqual(agents.calls.at(-1), ['stop', claude.taskId])
  assert.equal(claude.closed, true)
  assert.match(await tool('send', { child: 'C', message: 'ボーンも直して' }), /送りました/)
  assert.deepEqual(agents.calls.at(-1), ['run', claude.taskId, '[リーダーから]\nボーンも直して'])
  assert.equal(claude.closed, false)
})

test('a leader that looks busy with reports waiting gets its conversation file checked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { threads, terminals, tool, leader, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt' })
  terminals.set(leader, { activity: 'running' })
  threads.finish('thread-1', 'done')
  assert.equal(typed().length, 0)
  t.mock.timers.tick(LEADER_SETTLE_MS)
  await tick()
  assert.deepEqual(terminals.calls.at(-1), ['settle', leader])
  // Still working: checked again later; then its turn turns out to have ended.
  terminals.settled = true
  t.mock.timers.tick(LEADER_SETTLE_MS)
  await tick()
  assert.equal(typed().length, 1)
})

test('the user can decide a GPT child\'s approval in the panel; the leader is then not asked', async (t) => {
  const { threads, terminals, tool, leader, team, manager, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt' })
  const taskId = team.children[0].taskId
  terminals.set(leader, { activity: 'running' })
  threads.permissions.push({ threadId: taskId, requestId: 'req-1', name: 'shell', input: { command: 'ls' }, options: [{ optionId: 'yes', kind: 'allow_once' }] })
  threads.emit('approval-needed', { threadId: taskId })
  const [approval] = manager.summary(team).approvals
  assert.equal(manager.summary(team).children[0].state, 'approval')
  manager.approveById(team.id, approval.id, true)
  assert.deepEqual(threads.calls.at(-1), ['respond', 'req-1', 'yes'])
  terminals.set(leader, { activity: 'idle' })
  assert.equal(typed().length, 0)
})

test('Claude children saved as terminal tasks by an older version are left out', async (t) => {
  const { manager, team, dir, threads, terminals, agents } = await setup(t)
  team.children.push({ id: 'old', name: '旧', kind: 'terminal', taskId: 'terminal-9', pending: [], reports: [] })
  await manager.stop()
  const again = await new TeamManager({
    file: path.join(dir, 'teams.json'), dir: path.join(dir, 'teams'), threads, terminals, agents, catalog: CATALOG,
    getSettings: () => ({}), apiUrl: () => '',
  }).load()
  t.after(() => again.stop())
  assert.equal(again.list()[0].children.length, 0)
})

test('a GPT child\'s approval is answered with the matching dsh option', async (t) => {
  const { threads, tool, team, manager } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'G' })
  const taskId = team.children[0].taskId
  threads.permissions.push({
    threadId: taskId, requestId: 'req-1', name: 'shell', input: { command: 'npm publish' },
    options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }],
  })
  threads.emit('approval-needed', { threadId: taskId })
  assert.equal(manager.summary(team).approvals[0].tool, 'shell: npm publish')
  await tool('approve', { child: 'G', allow: true })
  assert.deepEqual(threads.calls.at(-1), ['respond', 'req-1', 'yes'])
})

test('a denial\'s reason reaches the child as its next message, a GPT child and a Claude child alike', async (t) => {
  const { agents, threads, tool, team } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'G' })
  const taskId = team.children[0].taskId
  threads.permissions.push({ threadId: taskId, requestId: 'req-1', name: 'shell', input: { command: 'npm publish' }, options: [{ optionId: 'no', kind: 'reject_once' }] })
  threads.emit('approval-needed', { threadId: taskId })
  threads.steerable = true
  assert.match(await tool('approve', { child: 'G', allow: false, message: '公開はせず、ビルドまでにしてください' }), /理由は子に送りました/)
  assert.deepEqual(threads.calls.filter((call) => call[0] === 'respond').at(-1), ['respond', 'req-1', 'no'])
  assert.deepEqual(threads.calls.at(-1), ['steer', taskId, '[リーダーから]\n「shell: npm publish」の承認を拒否しました。理由: 公開はせず、ビルドまでにしてください'])
  // A Claude child is never asked: its reason goes out as the next turn.
  await tool('spawn', { title: 'job', task: 'b', tier: 'low', provider: 'claude', name: 'C' })
  const claude = team.children[1]
  agents.finish(claude.taskId, '削除が要りました')
  assert.match(await tool('approve', { child: 'C', allow: false, message: '削除はしないでください' }), /理由は子に送りました/)
  assert.deepEqual(agents.calls.at(-1), ['run', claude.taskId, '[リーダーから]\n承認が要る操作は許可しません。理由: 削除はしないでください'])
  // Without a reason, or allowed, nothing is sent.
  assert.match(await tool('approve', { child: 'C', allow: false }), /待っている承認はありません/)
  assert.equal(agents.calls.at(-1)[0], 'run')
})

test('a closed child takes a place again only where one is free', async (t) => {
  const { tool, manager, team, threads } = await setup(t)
  manager.updateConfig(team.id, { maxChildren: 1 })
  await tool('spawn', { title: 'first', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  await tool('close', { child: 'A' })
  await tool('spawn', { title: 'second', task: 'b', tier: 'low', provider: 'gpt', name: 'B' })
  await assert.rejects(tool('send', { child: 'A', message: '続けて' }), /上限（1 人）/)
  assert.equal(team.children[0].closed, true)
  threads.finish('thread-2', 'done')
  await tool('close', { child: 'B' })
  await tool('send', { child: 'A', message: '続けて' })
  assert.equal(team.children[0].closed, false)
})

test('a failed send to a closed child leaves its slot free', async (t) => {
  const { tool, manager, team, threads } = await setup(t)
  manager.updateConfig(team.id, { maxChildren: 1 })
  await tool('spawn', { title: 'first', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  await tool('close', { child: 'A' })
  const child = team.children[0]
  threads.threads.get(child.taskId).status = 'idle'
  const send = threads.send.bind(threads)
  threads.send = async (id, args) => {
    if (id === child.taskId) throw new Error('task has ended')
    return send(id, args)
  }
  await assert.rejects(tool('send', { child: 'A', message: '続けて' }), /task has ended/)
  assert.equal(child.closed, true)
  assert.match(await tool('spawn', { title: 'second', task: 'b', tier: 'low', provider: 'gpt', name: 'B' }), /起動しました/)
})

test('ask_user notifies the user until they answer the leader', async (t) => {
  const { terminals, tool, leader, team, manager } = await setup(t)
  const asked = []
  manager.on('ask', (info) => asked.push(info))
  assert.match(await tool('ask_user', { message: 'API キーが要ります' }), /ユーザーに知らせました/)
  assert.deepEqual(asked, [{ teamId: team.id, leaderId: leader, leaderKind: 'terminal', text: 'API キーが要ります' }])
  assert.equal(manager.summary(team).asks.length, 1)
  // The leader working on its own does not answer it; the user's own prompt does.
  terminals.set(leader, { activity: 'running' })
  assert.equal(manager.summary(team).asks.length, 1)
  terminals.took(leader, [])
  assert.equal(manager.summary(team).asks.length, 0)
})

test('status lists the children and the tiers', async (t) => {
  const { tool } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  const text = await tool('status')
  assert.match(text, /開いている子: 1 \/ 6 人/)
  assert.match(text, /- A \[作業中\] GPT-6 Luna・低 — job/)
})

test('work cut off by an app restart is reported once the app is back', async (t) => {
  const { threads, terminals, tool, leader, manager, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  // As after a restart: the task is no longer running and never finished.
  threads.threads.get('thread-1').status = 'idle'
  terminals.set(leader, { activity: 'idle' })
  manager.start()
  assert.match(typed()[0], /子「A」.*がエラーで止まりました[\s\S]*再起動/)
})

test('teams and their reports survive a restart of the app', async (t) => {
  const { threads, terminals, agents, tool, leader, manager, dir } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  terminals.set(leader, { activity: 'running' })
  threads.finish('thread-1', '報告です')
  await manager.stop()
  const again = await new TeamManager({
    file: path.join(dir, 'teams.json'), dir: path.join(dir, 'teams'), threads, terminals, agents, catalog: CATALOG,
    getSettings: () => ({}), apiUrl: () => '',
  }).load()
  t.after(() => again.stop())
  const [team] = again.list()
  assert.equal(team.children[0].name, 'A')
  assert.equal(team.queue.length, 1)
})

test('a report being handed to the leader when the app stops goes out again, marked', async (t) => {
  const { threads, terminals, agents, tool, leader, manager, dir, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  terminals.set(leader, { activity: 'idle' })
  threads.finish('thread-1', '報告です')
  assert.equal(typed().length, 1)
  await manager.stop()
  const again = await new TeamManager({
    file: path.join(dir, 'teams.json'), dir: path.join(dir, 'teams'), threads, terminals, agents, catalog: CATALOG,
    getSettings: () => ({}), apiUrl: () => '',
  }).load()
  t.after(() => again.stop())
  const [team] = again.list()
  assert.equal(team.queue.length, 1)
  again.start()
  assert.match(typed().at(-1), /再起動の前に渡しかけた報告[\s\S]*報告です/)
})

test('a report the leader took is not handed over again after a restart', async (t) => {
  const { threads, terminals, agents, tool, leader, manager, dir, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  terminals.set(leader, { activity: 'idle' })
  threads.finish('thread-1', '報告です')
  terminals.took(leader, marksOf(typed()))
  await manager.stop()
  const again = await new TeamManager({
    file: path.join(dir, 'teams.json'), dir: path.join(dir, 'teams'), threads, terminals, agents, catalog: CATALOG,
    getSettings: () => ({}), apiUrl: () => '',
  }).load()
  t.after(() => again.stop())
  assert.equal(again.list()[0].queue.length, 0)
})

test('a pasted report does not get Enter over what the user typed after the paste', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { threads, terminals, tool, leader, manager, team, typed } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt' })
  terminals.set(leader, { activity: 'idle' })
  threads.finish('thread-1', 'done')
  assert.equal(typed().length, 1)
  terminals.set(leader, { inputAt: Date.now() + 1000 })
  t.mock.timers.tick(DELIVERY_CHECK_MS)
  assert.equal(terminals.calls.filter((call) => call[0] === 'enter').length, 0)
  // The user may still send it themselves; if not, it is given up as usual.
  t.mock.timers.tick(DELIVERY_GIVE_UP_MS)
  assert.equal(manager.summary(team).delivery, 'failed')
  assert.equal(team.queue.length, 1)
})

test('a team deleted while its GPT child is being created does not start the child', async (t) => {
  const { threads, team, manager, tool } = await setup(t)
  const create = threads.create.bind(threads)
  let signalStarted
  const started = new Promise((resolve) => { signalStarted = resolve })
  let releaseCreate
  const createGate = new Promise((resolve) => { releaseCreate = resolve })
  threads.create = async (options) => {
    const thread = await create(options)
    signalStarted(thread.id)
    await createGate
    return thread
  }

  const spawning = tool('spawn', { title: 'g', task: 'a', tier: 'low', provider: 'gpt' })
  const taskId = await started
  await manager.removeTeam(team.id)
  releaseCreate()
  await assert.rejects(spawning, /team was removed/)
  assert.equal(threads.calls.some((call) => call[0] === 'send' && call[1] === taskId), false)
  assert.equal(threads.threads.has(taskId), false)
  assert.ok(threads.calls.some((call) => call[0] === 'remove' && call[1] === taskId))
})

test('deleting the leader deletes the team with its children', async (t) => {
  const { threads, terminals, agents, tool, leader, team, manager } = await setup(t)
  const removed = []
  manager.on('removed', (info) => removed.push(info.teamId))
  await tool('spawn', { title: 'g', task: 'a', tier: 'low', provider: 'gpt' })
  await tool('spawn', { title: 'c', task: 'b', tier: 'low', provider: 'claude' })
  assert.equal(manager.teamLedBy(leader), team.id)
  assert.equal(manager.isChild(team.children[0].taskId), true)
  await manager.removeTeam(team.id)
  assert.deepEqual(removed, [team.id])
  assert.ok(threads.calls.some((call) => call[0] === 'remove'))
  assert.deepEqual(agents.calls.filter((call) => call[0] === 'remove').map((call) => call[1]), ['agent-1'])
  assert.deepEqual(terminals.calls.filter((call) => call[0] === 'remove').map((call) => call[1]), [leader])
  assert.equal(manager.list().length, 0)
})

test('a child deleted on its own leaves the team', async (t) => {
  const { threads, tool, team, manager } = await setup(t)
  await tool('spawn', { title: 'g', task: 'a', tier: 'low', provider: 'gpt' })
  await threads.remove(team.children[0].taskId)
  assert.equal(manager.summary(team).children.length, 0)
})

test('describeTool shows the part of a call that matters', () => {
  assert.equal(describeTool('Bash', { command: 'git push\n--force' }), 'Bash: git push --force')
  assert.equal(describeTool('Write', { file_path: 'C:\\a.txt', content: 'x' }), 'Write: C:\\a.txt')
  assert.equal(describeTool(null, null), 'tool')
})

test('team settings: defaults fill in, patches are checked', () => {
  assert.deepEqual(teamConfig(undefined), TEAM_DEFAULTS)
  assert.equal(teamConfig({ claude: { low: { model: 'claude-haiku-5-5' } } }).claude.low.effort, null)
  const next = mergeTeamConfig(undefined, { gpt: { mid: { model: 'gpt-6.1-sol', effort: 'xhigh' } }, maxChildren: 8, leaderBypass: false })
  assert.deepEqual(next.gpt.mid, { enabled: true, model: 'gpt-6.1-sol', effort: 'xhigh' })
  assert.equal(next.maxChildren, 8)
  assert.equal(next.leaderBypass, false)
  assert.throws(() => mergeTeamConfig(undefined, { maxChildren: 0 }), /1〜12/)
  assert.throws(() => mergeTeamConfig(undefined, { gpt: { low: { model: 'bad model' } } }), /GPT の低枠のモデル/)
  // Nothing is on until the user turns it on; a team asks for at least one.
  for (const provider of ['gpt', 'claude', 'claudeApi', 'deepseek', 'opencodeGo']) assert.equal(teamConfig({})[provider].enabled, false)
  assert.equal(mergeTeamConfig(undefined, { gpt: { enabled: false } }).gpt.enabled, false)
  assert.throws(() => assertChildrenOn(teamConfig({})), /少なくとも一つ/)
  assert.doesNotThrow(() => assertChildrenOn(mergeTeamConfig(undefined, { claude: { enabled: true } })))
  // What an older version saved as on stays on.
  assert.equal(teamConfig({ gpt: { enabled: true } }).gpt.enabled, true)
  assert.throws(() => mergeTeamConfig(undefined, { leader: 'opus' }), /leader/)
  // A tier can be left out, but not both of a provider in use.
  assert.equal(mergeTeamConfig(undefined, { claude: { mid: { enabled: false } } }).claude.mid.enabled, false)
  assert.throws(() => mergeTeamConfig(undefined, { claude: { enabled: true, low: { enabled: false }, mid: { enabled: false } } }), /Claude の低枠と中枠の少なくとも一方/)
  assert.equal(mergeTeamConfig(undefined, { deepseek: { low: { enabled: false }, mid: { enabled: false } } }).deepseek.enabled, false)
  // DeepSeek is off until turned on; a leader also needs an explicit matching model.
  assert.equal(teamConfig({}).deepseek.enabled, false)
  assert.equal(mergeTeamConfig(undefined, { deepseek: { enabled: true, low: { model: 'deepseek-v4-flash' } } }).deepseek.low.model, 'deepseek-v4-flash')
  assert.throws(() => mergeTeamConfig(undefined, { leaderProvider: 'deepseek' }), /リーダー/)
  assert.equal(teamConfig({ leaderProvider: 'deepseek' }).leaderProvider, 'deepseek')
  // OpenCode Go likewise needs its leader model.
  assert.equal(mergeTeamConfig(undefined, { opencodeGo: { enabled: true, mid: { model: 'kimi-k3' } } }).opencodeGo.mid.model, 'kimi-k3')
  assert.throws(() => mergeTeamConfig(undefined, { opencodeGo: { enabled: true, low: { enabled: false }, mid: { enabled: false } } }), /OpenCode Go の低枠と中枠/)
  assert.throws(() => mergeTeamConfig(undefined, { leaderProvider: 'opencodeGo' }), /リーダー/)
})

test('free model settings validate the limit, uniqueness and provider-specific IDs', () => {
  assert.equal(teamConfig({}).defaultModelMode, 'tiers')
  assert.equal(teamConfig({}).modelMode, 'tiers')
  assert.deepEqual(teamConfig({}).freeModels, [])
  const twelve = Array.from({ length: 12 }, (_, i) => ({ provider: 'gpt', model: `model-${i}`, effort: null }))
  const config = mergeTeamConfig({}, { defaultModelMode: 'free', modelMode: 'free', freeModels: twelve })
  assert.doesNotThrow(() => assertChildrenOn(config))
  assert.equal(config.freeModels.length, 12)
  assert.throws(() => mergeTeamConfig({}, { freeModels: [...twelve, { provider: 'gpt', model: 'extra' }] }), /12 個/)
  assert.throws(() => mergeTeamConfig({}, { freeModels: [twelve[0], twelve[0]] }), /同じモデル/)
  assert.throws(() => mergeTeamConfig({}, { freeModels: [{ provider: 'gpt', model: 'bad model' }] }), /モデル/)
  assert.throws(() => mergeTeamConfig({}, { freeModels: [{ provider: 'unknown', model: 'x' }] }), /プロバイダー/)
  assert.throws(() => mergeTeamConfig({}, { freeModels: [{ provider: 'gpt', model: 'x', effort: '???' }] }), /推論/)
  assert.throws(() => mergeTeamConfig({}, { defaultModelMode: 'other' }), /選び方/)
  assert.throws(() => assertChildrenOn(mergeTeamConfig({}, { modelMode: 'free' })), /少なくとも一つ/)
  assert.equal(mergeTeamConfig({}, { freeModels: [{ provider: 'local', model: 'org/model:8b' }] }).freeModels[0].model, 'org/model:8b')
})

test('free mode balances concurrent spawns and honors explicit model choices', async (t) => {
  const freeModels = [
    { provider: 'gpt', model: 'gpt-6-luna', effort: 'medium' },
    { provider: 'claudeApi', model: 'claude-haiku-5-5', effort: null },
    { provider: 'claude', model: 'sonnet', effort: 'high' },
  ]
  const { team, tool, threads, agents, manager } = await setup(t, { defaultModelMode: 'free', freeModels, maxChildren: 12 })
  assert.equal(team.config.modelMode, 'free')
  const status = await tool('status')
  assert.match(status, /provider "claudeApi", model "claude-haiku-5-5"/)
  await Promise.all(Array.from({ length: 6 }, (_, i) => tool('spawn', { title: `work ${i}`, task: 'work' })))
  assert.deepEqual(team.children.map((child) => child.model), ['gpt-6-luna', 'claude-haiku-5-5', 'sonnet', 'gpt-6-luna', 'claude-haiku-5-5', 'sonnet'])
  assert.ok(team.children.every((child) => child.tier === null))
  assert.equal(manager.summary(team).children[0].modelName, 'GPT-6 Luna')
  assert.equal(threads.calls.filter((call) => call[0] === 'create').length, 4)
  assert.equal(agents.calls.filter((call) => call[0] === 'create').length, 2)
  await tool('spawn', { title: 'explicit', task: 'work', provider: 'claudeApi', model: 'claude-haiku-5-5' })
  assert.equal(team.children.at(-1).provider, 'claudeApi')
  await assert.rejects(tool('spawn', { title: 'bad', task: 'work', model: 'not-selected' }), /使えません/)
  await assert.rejects(tool('spawn', { title: 'bad', task: 'work', tier: 'low' }), /自由モード/)
  assert.equal(team.children.length, 7)
})

test('both modes balance available models and a running team switches without changing existing children', async (t) => {
  const { team, tool, manager, terminals, leader, typed } = await setup(t, { maxChildren: 12 })
  await Promise.all(Array.from({ length: 4 }, (_, i) => tool('spawn', { title: String(i), task: 'work' })))
  assert.deepEqual(team.children.map((child) => child.model), ['gpt-6-luna', 'gpt-6.1-sol', 'haiku', 'sonnet'])
  terminals.set(leader, { activity: 'idle' })
  const before = team.children.map(({ model, tier }) => ({ model, tier }))
  assert.throws(() => manager.updateConfig(team.id, { modelMode: 'free', freeModels: [] }), /少なくとも一つ/)
  manager.updateConfig(team.id, { modelMode: 'free', freeModels: [{ provider: 'gpt', model: 'gpt-6.1-sol', effort: 'high' }] })
  assert.match(typed().at(-1), /model "gpt-6.1-sol"/)
  assert.deepEqual(team.children.map(({ model, tier }) => ({ model, tier })), before)
  await tool('spawn', { title: 'new', task: 'work' })
  assert.equal(team.children.at(-1).model, 'gpt-6.1-sol')
  assert.equal(team.children.at(-1).tier, null)
  await manager.writes
  const stored = JSON.parse(await fs.readFile(path.join(manager.file), 'utf8'))
  assert.equal(stored.teams.find((entry) => entry.id === team.id).config.modelMode, 'free')
})

test('tier slots using the same model still share the work and keep their effort', async (t) => {
  const f = await setup(t, { claude: { enabled: false }, gpt: { enabled: true, low: { model: 'gpt-6-luna', effort: 'low' }, mid: { model: 'gpt-6-luna', effort: 'high' } } })
  await Promise.all(Array.from({ length: 4 }, (_, i) => f.tool('spawn', { title: String(i), task: 'work' })))
  assert.deepEqual(f.team.children.map(({ tier, effort }) => [tier, effort]), [['low', 'low'], ['mid', 'high'], ['low', 'low'], ['mid', 'high']])
})

test('a new team uses the configured default instead of the previous team mode', async (t) => {
  const f = await setup(t)
  f.setSettings(mergeTeamConfig(f.team.config, { defaultModelMode: 'free', modelMode: 'tiers', freeModels: [{ provider: 'gpt', model: 'gpt-6-luna', effort: 'low' }] }))
  const defaultTeam = await f.manager.create({ workspace: f.workspace })
  assert.equal(defaultTeam.team.config.modelMode, 'free')
  const temporaryTierTeam = await f.manager.create({ workspace: f.workspace, choices: { modelMode: 'tiers' } })
  assert.equal(temporaryTierTeam.team.config.modelMode, 'tiers')
  assert.equal((await f.manager.create({ workspace: f.workspace })).team.config.modelMode, 'free')
})

test('free mode and usage balance survive a restart', async (t) => {
  const freeModels = [
    { provider: 'gpt', model: 'gpt-6-luna', effort: 'low' },
    { provider: 'claudeApi', model: 'claude-haiku-5-5', effort: null },
  ]
  const { team, tool, threads, terminals, agents, manager, dir } = await setup(t, { defaultModelMode: 'free', freeModels })
  await tool('spawn', { title: 'first', task: 'work' })
  assert.equal(team.children[0].model, 'gpt-6-luna')
  await manager.stop()
  const again = await new TeamManager({
    file: path.join(dir, 'teams.json'), dir: path.join(dir, 'teams'), threads, terminals, agents, catalog: CATALOG,
    getSettings: () => ({}), apiUrl: () => '',
  }).load()
  t.after(() => again.stop())
  const restored = again.teams.get(team.id)
  assert.equal(restored.config.modelMode, 'free')
  assert.deepEqual(restored.config.freeModels, freeModels)
  await again.call(restored.id, restored.secret, 'spawn', { title: 'next', task: 'work' })
  assert.equal(restored.children.at(-1).model, 'claude-haiku-5-5')
})

test('a free-mode default leaves eco on low tiers', async (t) => {
  const f = await setup(t, { leaderProvider: 'gpt', defaultModelMode: 'free', freeModels: [{ provider: 'gpt', model: 'gpt-6.1-sol', effort: null }] })
  const { team } = await f.manager.create({ workspace: f.workspace, execution: {} })
  assert.equal(team.config.modelMode, 'tiers')
  const raw = f.manager.teams.get(team.id)
  await f.manager.call(team.id, raw.secret, 'spawn', { ...exTask, mode: 'research' })
  assert.equal(raw.children[0].tier, 'low')
  assert.equal(raw.children[0].model, 'gpt-6-luna')
  assert.throws(() => f.manager.updateConfig(team.id, { modelMode: 'free' }), /低枠/)
})

test('a team starts only with a provider turned on, and cannot be left without one', async (t) => {
  const { manager, workspace, team, setSettings } = await setup(t)
  // Nothing is saved as on in a new install: the start dialog has to turn something on.
  setSettings(teamConfig({}))
  await assert.rejects(manager.create({ workspace }), /少なくとも一つ/)
  assert.equal(manager.list().length, 1)
  const started = await manager.create({ workspace, choices: { claude: { enabled: true } } })
  assert.equal(started.team.config.claude.enabled, true)
  assert.equal(started.team.config.gpt.enabled, false)
  assert.equal(manager.list().length, 2)
  // A running team keeps one on, whatever the panel sends.
  assert.throws(() => manager.updateConfig(team.id, { gpt: { enabled: false }, claude: { enabled: false } }), /少なくとも一つ/)
  assert.equal(manager.summary(team).config.gpt.enabled, true)
})

test('a tier the user turned off is not offered to the leader', async (t) => {
  const { tool, manager, team, terminals, leader, typed } = await setup(t)
  terminals.set(leader, { activity: 'idle' })
  manager.updateConfig(team.id, { gpt: { low: { enabled: false } } })
  assert.match(typed().at(-1), /provider "gpt".*low = turned off by the user \(do not use\), mid = GPT-6\.1 Sol/)
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'low', provider: 'gpt' }), /GPTの低枠はユーザーがオフ/)
  assert.match(await tool('spawn', { title: 'x', task: 'y', tier: 'mid', provider: 'gpt' }), /GPT-6\.1 Sol・中/)
  assert.match(await tool('status'), /low = turned off by the user/)
})

test('a DeepSeek child is a full-access dsh task on a DeepSeek model', async (t) => {
  const { threads, tool, team, workspace, manager, terminals, leader } = await setup(t, {
    deepseek: { enabled: true, low: { enabled: true, model: 'deepseek-v4-flash', effort: null }, mid: { enabled: false, model: null, effort: null } },
  })
  const args = terminals.records.get(leader).launch.args
  const prompt = await fs.readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')
  assert.match(prompt,/provider "deepseek" \(DeepSeek, billed per token.*low = DeepSeek V4 Flash.*mid = turned off/)
  assert.match(await tool('spawn', { title: '翻訳', task: 'docs を訳す', tier: 'low', provider: 'deepseek', name: 'D' }), /子「D」を起動しました（DeepSeek V4 Flash・低）/)
  const [, options] = threads.calls.find((call) => call[0] === 'create')
  assert.deepEqual(options, {
    workspace, model: '["deepseek-official","deepseek-v4-flash"]', effort: '', permissionMode: 'danger-full-access', toolMode: 'native',
    team: { id: team.id, childId: team.children[0].id },
  })
  assert.equal(manager.summary(team).children[0].kind, 'thread')
  assert.equal(manager.summary(team).children[0].provider, 'deepseek')
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'mid', provider: 'deepseek' }), /DeepSeekの中枠はユーザーがオフ/)
  assert.match(await tool('spawn', { title: 'x', task: 'y', tier: 'low' }), /GPT-6 Luna・低/)
})

test('an OpenCode Go child is a full-access dsh task on an OpenCode Go model', async (t) => {
  const { threads, tool, team, workspace, manager, terminals, leader } = await setup(t, {
    opencodeGo: { enabled: true, low: { enabled: false, model: null, effort: null }, mid: { enabled: true, model: 'glm-5.3', effort: 'high' } },
  })
  const args = terminals.records.get(leader).launch.args
  const prompt = await fs.readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')
  assert.match(prompt, /provider "opencodeGo" \(open models .*OpenCode Go subscription.*usage limits\): low = turned off by the user \(do not use\), mid = GLM-5\.3/)
  assert.match(await tool('spawn', { title: '調査', task: 'ログを読む', tier: 'mid', provider: 'opencodeGo', name: 'O' }), /子「O」を起動しました（GLM-5\.3・中）/)
  const [, options] = threads.calls.find((call) => call[0] === 'create')
  assert.deepEqual(options, {
    workspace, model: '["opencode-go","glm-5.3"]', effort: 'high', permissionMode: 'danger-full-access', toolMode: 'native',
    team: { id: team.id, childId: team.children[0].id },
  })
  assert.equal(manager.summary(team).children[0].kind, 'thread')
  assert.equal(manager.summary(team).children[0].provider, 'opencodeGo')
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'low', provider: 'opencodeGo' }), /OpenCode Goの低枠はユーザーがオフ/)
})

test('a Claude (API) child is a full-access dsh task on an Anthropic model, not a Claude Code run; it is off until turned on', async (t) => {
  assert.equal(teamConfig({}).claudeApi.enabled, false)
  assert.equal(mergeTeamConfig(undefined, { claudeApi: { enabled: true, low: { model: 'claude-haiku-5-5' } } }).claudeApi.low.model, 'claude-haiku-5-5')
  assert.throws(() => mergeTeamConfig(undefined, { claudeApi: { low: { enabled: false }, mid: { enabled: false }, enabled: true } }), /Claude（API）/)

  const { threads, agents, tool, team, workspace, manager, terminals, leader } = await setup(t, {
    claudeApi: { enabled: true, low: { enabled: true, model: 'claude-haiku-5-5', effort: null }, mid: { enabled: false, model: null, effort: null } },
  })
  const args = terminals.records.get(leader).launch.args
  const prompt = await fs.readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')
  assert.match(prompt, /provider "claudeApi" \(Claude through dsh on the user's Anthropic API key.*low = Claude Haiku 5\.5.*mid = turned off/)
  assert.match(prompt, /Claude Code using its own user-confirmed subscription, API key or cloud authentication/)
  assert.doesNotMatch(prompt, /monthly API credits/)
  assert.match(await tool('spawn', { title: '要約', task: 'docs を要約', tier: 'low', provider: 'claudeApi', name: 'A' }), /子「A」を起動しました（Claude Haiku 5\.5・低）/)
  const [, options] = threads.calls.find((call) => call[0] === 'create')
  assert.deepEqual(options, {
    workspace, model: '["anthropic","claude-haiku-5-5"]', effort: '', permissionMode: 'danger-full-access', toolMode: 'native',
    team: { id: team.id, childId: team.children[0].id },
  })
  assert.deepEqual([manager.summary(team).children[0].kind, manager.summary(team).children[0].provider], ['thread', 'claudeApi'])
  assert.equal(agents.calls.some((call) => call[0] === 'create'), false)
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'mid', provider: 'claudeApi' }), /Claude（API）の中枠はユーザーがオフ/)
})

test('a GPT leader is a dsh task whose session mounts the team tools with the leader instructions', async (t) => {
  const { threads, terminals, manager, team, leader, workspace } = await setup(t, { leaderProvider: 'gpt', gptLeader: { model: null, effort: 'high' } })
  assert.equal(team.leaderKind, 'thread')
  assert.equal(terminals.calls.filter((call) => call[0] === 'create').length, 0)
  const [, options] = threads.calls.find((call) => call[0] === 'create')
  // No model of its own: the GPT "mid" tier's.
  assert.deepEqual(options, {
    workspace, model: '["openai-codex","gpt-6.1-sol"]', effort: 'high', permissionMode: 'danger-full-access', toolMode: 'native', team: { id: team.id, role: 'leader' },
  })
  assert.equal(manager.teamLedBy(leader), team.id)
  assert.equal(manager.isChild(leader), false)
  assert.equal(manager.inTeam(leader), true)
  const server = manager.mcpServerFor(threads.threads.get(leader))
  assert.equal(server.name, MCP_SERVER)
  const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
  assert.equal(env.AGENT_DESK_TEAM_SECRET, team.secret)
  const prompt = await fs.readFile(env.AGENT_DESK_TEAM_INSTRUCTIONS, 'utf8')
  assert.match(prompt, /you are the leader/)
  assert.match(prompt, /not to your own `subagent` tools/)
  // Other tasks get nothing.
  assert.equal(manager.mcpServerFor({ id: 'x', team: undefined }), null)
  assert.equal(manager.summary(team).leaderKind, 'thread')
})

for (const [provider, catalogProvider, model, effort] of [
  ['claudeApi', 'anthropic', 'claude-haiku-5-5', 'low'],
  ['deepseek', 'deepseek-official', 'deepseek-v4-flash', 'medium'],
  ['opencodeGo', 'opencode-go', 'glm-5.3', null],
  ['local', 'local-llm', 'org/qwen:8b', 'low'],
]) {
  test(`a ${provider} leader keeps its model, effort, billing route and team tools`, async (t) => {
    const f = await setup(t)
    const chosen = { provider, model, effort }
    const result = await f.manager.create({ workspace: f.workspace, choices: { leaderProvider: provider, dshLeader: chosen, leaderBypass: false, toolMode: 'ptc' } })
    const team = f.manager.teams.get(result.team.id)
    assert.equal(team.leaderKind, 'thread')
    assert.deepEqual(team.config.dshLeader, chosen)
    const thread = f.threads.threads.get(team.leaderId)
    assert.equal(thread.model, JSON.stringify([catalogProvider, model]))
    assert.equal(thread.effort, effort ?? '')
    assert.equal(thread.permissionMode, 'workspace-write')
    assert.equal(thread.toolMode, 'ptc')
    assert.deepEqual(thread.team, { id: team.id, role: 'leader' })
    assert.equal(f.manager.mcpServerFor(thread).name, MCP_SERVER)
    assert.equal(f.manager.teamLedBy(thread.id), team.id)
    await f.manager.call(team.id, team.secret, 'spawn', { title: 'child', task: 'work', provider: 'gpt', tier: 'low' })
    assert.equal(team.children[0].model, 'gpt-6-luna')
  })
}

test('extra leader routes require their own valid model and never fall back to another provider', async (t) => {
  const f = await setup(t)
  const choices = { leaderProvider: 'deepseek', dshLeader: { provider: 'claudeApi', model: 'claude-haiku-5-5', effort: null } }
  await assert.rejects(f.manager.create({ workspace: f.workspace, choices }), /一致/)
  assert.throws(() => mergeTeamConfig({}, { leaderProvider: 'local', dshLeader: { provider: 'local', model: '../bad', effort: null } }), /モデル/)
  assert.throws(() => mergeTeamConfig({}, { leaderProvider: 'claudeApi', dshLeader: { provider: 'claudeApi', model: 'haiku', effort: 'bad!' } }), /推論/)
  assert.throws(() => mergeTeamConfig({}, { leaderProvider: 'claudeApi' }), /一致/)
  assert.throws(() => mergeTeamConfig({}, { dshLeader: { provider: 'gpt', model: 'gpt-6-luna' } }), /プロバイダー/)
})

test('a non-GPT leader selection survives restart and does not affect eco choices', async (t) => {
  const chosen = { provider: 'deepseek', model: 'deepseek-v4-flash', effort: 'low' }
  const f = await setup(t, { leaderProvider: 'deepseek', dshLeader: chosen })
  await f.manager.stop()
  const again = await new TeamManager({
    file: path.join(f.dir, 'teams.json'), dir: path.join(f.dir, 'teams'), threads: f.threads, terminals: f.terminals, agents: f.agents, catalog: CATALOG,
    getSettings: () => ({}), apiUrl: () => '',
  }).load()
  t.after(() => again.stop())
  const restored = again.teams.get(f.team.id)
  assert.equal(restored.config.leaderProvider, 'deepseek')
  assert.deepEqual(restored.config.dshLeader, chosen)
  assert.equal(f.threads.threads.get(restored.leaderId).model, '["deepseek-official","deepseek-v4-flash"]')
  const eco = await again.create({ workspace: f.workspace, execution: {}, choices: { ...restored.config, leaderProvider: 'gpt' } })
  assert.equal(eco.team.config.leaderProvider, 'gpt')
  assert.equal(f.threads.threads.get(eco.team.leaderId).model, '["openai-codex","gpt-6.1-sol"]')
})

test('with batchReports off, a GPT leader gets each report as a message once its turn has ended', async (t) => {
  const { threads, tool, leader, manager, team, sent } = await setup(t, { leaderProvider: 'gpt', batchReports: false })
  await tool('spawn', { title: 'first', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  await tool('spawn', { title: 'second', task: 'b', tier: 'low', provider: 'gpt', name: 'B' })
  // The leader is on a turn of its own (it just spawned them).
  threads.threads.get(leader).status = 'running'
  threads.turns.get(leader).push({ id: 'l1', items: [], status: 'running' })
  threads.finish('thread-3', 'B の報告')
  threads.finish('thread-2', 'A の報告')
  assert.equal(sent().length, 0)
  threads.finish(leader, 'spawned')
  await tick()
  assert.equal(sent().length, 1)
  assert.match(sent()[0], /子「B」.*から報告が届きました（このあとに 1 件が待っています）/)
  assert.equal(manager.summary(team).delivery, 'waiting')
  // The second waits for the leader's next turn to end.
  threads.finish(leader, '確認しました')
  await tick()
  assert.equal(sent().length, 2)
  assert.match(sent()[1], /子「A」/)
})

test('a GPT leader gets the reports that waited for its turn in one message', async (t) => {
  const { threads, tool, leader, manager, team, sent } = await setup(t, { leaderProvider: 'gpt' })
  await tool('spawn', { title: 'first', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  await tool('spawn', { title: 'second', task: 'b', tier: 'low', provider: 'gpt', name: 'B' })
  threads.threads.get(leader).status = 'running'
  threads.turns.get(leader).push({ id: 'l1', items: [], status: 'running' })
  threads.finish('thread-3', 'B の報告')
  threads.finish('thread-2', 'A の報告')
  threads.finish(leader, 'spawned')
  await tick()
  assert.equal(sent().length, 1)
  assert.match(sent()[0], /2 件がまとめて届きました[\s\S]*B の報告[\s\S]*A の報告/)
  assert.equal(manager.summary(team).delivery, 'idle')
})

test('a GPT leader that starts a Claude (API-billed) subagent is stopped and told why', async (t) => {
  const { threads, manager, leader, sent } = await setup(t, { leaderProvider: 'gpt' })
  threads.threads.get(leader).status = 'running'
  threads.turns.get(leader).push({ id: 'l1', items: [], status: 'running' })
  await manager.stopApiUse(leader)
  await manager.stopApiUse(leader)
  assert.deepEqual(threads.calls.filter((call) => call[0] === 'cancel'), [['cancel', leader]])
  threads.finish(leader, '', 'cancelled')
  await tick()
  assert.match(sent()[0], /Anthropic API の従量課金/)
})

test('a GPT leader\'s questions are answered when the user writes to it; deleting it deletes the team', async (t) => {
  const { threads, tool, manager, team, leader } = await setup(t, { leaderProvider: 'gpt' })
  const asked = []
  manager.on('ask', (info) => asked.push(info))
  await tool('ask_user', { message: 'どちらにしますか' })
  assert.equal(asked[0].leaderKind, 'thread')
  manager.userWrote(leader)
  assert.equal(manager.summary(team).asks.length, 0)
  await tool('spawn', { title: 'g', task: 'a', tier: 'low', provider: 'gpt' })
  await threads.remove(leader)
  await tick()
  assert.equal(manager.list().length, 0)
  assert.ok(threads.calls.some((call) => call[0] === 'remove' && call[1] === 'thread-2'))
})

test('a GPT leader needs a model', async (t) => {
  const { manager, workspace, setSettings } = await setup(t)
  setSettings(mergeTeamConfig(TEAM_DEFAULTS, { leaderProvider: 'gpt', gpt: { enabled: true } }))
  await assert.rejects(manager.create({ workspace }), /GPT のリーダーのモデル/)
  assert.equal(manager.list().length, 1)
})

test('send with fresh starts the child over in a new conversation and drops the old one', async (t) => {
  const { threads, agents, tool, team, manager } = await setup(t)
  await tool('spawn', { title: 'docs', task: 'first task', tier: 'low', provider: 'gpt', name: 'G' })
  await tool('spawn', { title: 'code', task: 'first task', tier: 'low', provider: 'claude', name: 'C' })
  const [gpt, claude] = team.children
  await assert.rejects(tool('send', { child: 'G', message: 'next', fresh: true }), /作業中です/)
  threads.finish('thread-1', 'done')
  agents.finish('agent-1', 'done')
  await tool('close', { child: 'G' })

  assert.match(await tool('send', { child: 'G', message: 'new task', fresh: true }), /新しい会話で始めました/)
  assert.equal(gpt.taskId, 'thread-2')
  assert.deepEqual(threads.calls.filter((call) => call[0] === 'create').at(-1)[1].team, { id: team.id, childId: gpt.id })
  const first = threads.calls.filter((call) => call[0] === 'send' && call[1] === 'thread-2')[0][2]
  assert.match(first, /You are the child agent "G"[\s\S]*# Task: docs\n\nnew task$/)
  assert.ok(threads.calls.some((call) => call[0] === 'remove' && call[1] === 'thread-1'))
  assert.deepEqual([gpt.closed, gpt.awaiting], [false, true])

  await tool('send', { child: 'C', message: 'other task', fresh: true })
  assert.equal(claude.taskId, 'agent-2')
  assert.deepEqual(agents.calls.filter((call) => call[0] === 'run').at(-1), ['run', 'agent-2', '# Task from the team leader: code\n\nother task'])
  assert.ok(agents.calls.some((call) => call[0] === 'remove' && call[1] === 'agent-1'))
  // Both are still on the team, and report from their new conversations.
  assert.equal(manager.summary(team).children.length, 2)
  threads.finish('thread-2', 'fresh report')
  assert.equal(gpt.reports.at(-1).text, 'fresh report')
})

for (const leanChildren of [true, false]) {
  test(`startup choices override saved leanChildren=${!leanChildren} with ${leanChildren}`, async (t) => {
    const { manager, workspace, team: existing, agents } = await setup(t, { leanChildren: !leanChildren })
    const { team: view } = await manager.create({ workspace, choices: { leanChildren } })
    const team = manager.teams.get(view.id)
    assert.equal(view.config.leanChildren, leanChildren)
    assert.equal(manager.summary(existing).config.leanChildren, !leanChildren)
    for (const provider of ['claude', 'gpt']) {
      await manager.call(team.id, team.secret, 'spawn', { title: provider, task: 'x', tier: 'low', provider })
    }
    const args = agents.calls.find((call) => call[0] === 'create')[1].args
    assert.equal(args.includes('--strict-mcp-config'), leanChildren)
    assert.equal(args.includes('--chrome'), !leanChildren)
    const child = team.children[1]
    assert.equal(manager.toolsFor({ id: child.taskId, team: { id: team.id, childId: child.id } }), !leanChildren)
    const { team: next } = await manager.create({ workspace })
    assert.equal(next.config.leanChildren, !leanChildren, 'creating a team does not mutate the saved defaults')
  })
}

test('lean children start without the extra tools unless spawn asks for them', async (t) => {
  const { tool, team, manager, agents, terminals, leader } = await setup(t, { leanChildren: true })
  const args = terminals.records.get(leader).launch.args
  assert.match(await fs.readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8'), /`spawn` with `tools: true`/)
  await tool('spawn', { title: 'a', task: 'x', tier: 'low', provider: 'claude', name: 'C1' })
  await tool('spawn', { title: 'b', task: 'x', tier: 'low', provider: 'claude', name: 'C2', tools: true })
  await tool('spawn', { title: 'c', task: 'x', tier: 'low', provider: 'gpt', name: 'G1' })
  await tool('spawn', { title: 'd', task: 'x', tier: 'low', provider: 'gpt', name: 'G2', tools: true })
  const created = agents.calls.filter((call) => call[0] === 'create').map((call) => call[1].args)
  assert.deepEqual(created.map((list) => list.includes('--strict-mcp-config')), [true, false])
  assert.deepEqual(created.map((list) => list.includes('--chrome')), [false, true])
  assert.equal(created[0].includes('--no-chrome'), true)
  const [, , g1, g2] = team.children
  assert.equal(manager.toolsFor({ id: g1.taskId, team: { id: team.id, childId: g1.id } }), false)
  assert.equal(manager.toolsFor({ id: g2.taskId, team: { id: team.id, childId: g2.id } }), true)
  assert.equal(manager.toolsFor({ id: 'plain' }), true)
})

test('children keep every tool by default, and report how they checked their work', async (t) => {
  const { tool, team, manager, agents, terminals, leader } = await setup(t)
  const args = terminals.records.get(leader).launch.args
  assert.doesNotMatch(await fs.readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8'), /tools: true/)
  await tool('spawn', { title: 'a', task: 'x', tier: 'low', provider: 'claude', name: 'C' })
  await tool('spawn', { title: 'b', task: 'x', tier: 'low', provider: 'gpt', name: 'G' })
  const childArgs = agents.calls.find((call) => call[0] === 'create')[1].args
  assert.equal(childArgs.includes('--strict-mcp-config'), false)
  assert.equal(childArgs.includes('--chrome'), true)
  assert.match(await fs.readFile(childArgs[childArgs.indexOf('--append-system-prompt-file') + 1], 'utf8'), /3\) how you checked it/)
  const g = team.children[1]
  assert.equal(manager.toolsFor({ id: g.taskId, team: { id: team.id, childId: g.id } }), true)
})

/** A dsh child's turn that ended on an error with this message. */
function failThread(threads, id, message) {
  const thread = threads.threads.get(id)
  thread.status = 'error'
  const turn = threads.turns.get(id).at(-1)
  Object.assign(turn, { status: 'error', error: { message } })
  threads.emit('thread', { ...thread })
  threads.emit('turn-finished', { threadId: id, title: thread.title, status: 'error' })
}

test('passing failures are told apart from ones that would come back at once', () => {
  for (const message of ['API Error: 529 {"type":"overloaded_error"}', 'WebSocket closed 1006', 'fetch failed: ECONNRESET', '503 Service Unavailable', 'Request timed out']) {
    assert.equal(transientError(message), true, message)
  }
  for (const message of ['利用上限に達しました。', '429 rate limit exceeded', '401 Unauthorized', 'prompt is too long: context window', 'Claude Code が終了しました（終了コード 1）', '', undefined]) {
    assert.equal(transientError(message), false, message)
  }
})

test('a child stopped by a passing failure goes on by itself once, and the leader hears only if that fails too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { threads, terminals, tool, leader, typed } = await setup(t)
  terminals.set(leader, { activity: 'idle' })
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  failThread(threads, 'thread-1', 'WebSocket closed 1006')
  assert.equal(typed().length, 0)
  t.mock.timers.tick(RESUME_DELAY_MS)
  assert.match(threads.calls.at(-1)[2], /自動で再開しました/)
  assert.equal(threads.calls.at(-1)[1], 'thread-1')
  failThread(threads, 'thread-1', 'WebSocket closed 1006')
  assert.equal(typed().length, 1)
  assert.match(typed()[0], /自動で 1 回再開しましたが、また止まりました[\s\S]*WebSocket closed/)
  // The leader's next work gets its own retry.
  await tool('send', { child: 'A', message: '続けて' })
  failThread(threads, 'thread-1', 'WebSocket closed 1006')
  assert.equal(typed().length, 1)
})

test('a Claude child goes on after an overloaded service, and its report reads as usual', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { agents, terminals, tool, leader, typed } = await setup(t)
  terminals.set(leader, { activity: 'idle' })
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  agents.finish('agent-1', '', 'error', { error: 'API Error: 529 Overloaded' })
  assert.equal(typed().length, 0)
  t.mock.timers.tick(RESUME_DELAY_MS)
  assert.deepEqual(agents.calls.at(-1).slice(0, 2), ['run', 'agent-1'])
  agents.finish('agent-1', 'できました')
  assert.equal(typed().length, 1)
  assert.match(typed()[0], /から報告が届きました[\s\S]*できました/)
  assert.doesNotMatch(typed()[0], /自動で/)
})

test('a lasting failure reaches the leader at once, and stopping all also stops a child waiting to go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { threads, terminals, tool, leader, typed, manager, team } = await setup(t)
  terminals.set(leader, { activity: 'running' })
  await tool('spawn', { title: 'one', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  await tool('spawn', { title: 'two', task: 'b', tier: 'low', provider: 'gpt', name: 'B' })
  failThread(threads, 'thread-1', '429 rate limit exceeded')
  assert.deepEqual(team.queue.map((item) => item.kind), ['error'])
  failThread(threads, 'thread-2', '503 Service Unavailable')
  assert.equal(team.queue.length, 1)
  assert.equal((await manager.stopAll(team.id)).stopped, 1)
  assert.deepEqual(team.queue.map((item) => [item.kind, item.byUser]), [['error', undefined], ['cancelled', true]])
  const sends = threads.calls.length
  t.mock.timers.tick(RESUME_DELAY_MS)
  assert.equal(threads.calls.length, sends)
  terminals.set(leader, { activity: 'idle' })
  assert.match(typed()[0], /rate limit[\s\S]*ユーザーが全停止で止めました/)
})

test('more passing failures dsh and the services report are told apart', () => {
  for (const message of ['stream disconnected before completion', 'An error occurred while processing your request. server_error', 'We are experiencing high demand', '522 Connection timed out', 'premature close', 'other side closed', 'terminated']) {
    assert.equal(transientError(message), true, message)
  }
})

test('a closed child does not go on, and stopping all does not report it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { threads, terminals, tool, leader, manager, team } = await setup(t)
  terminals.set(leader, { activity: 'running' })
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  failThread(threads, 'thread-1', '503 Service Unavailable')
  await tool('close', { child: 'A' })
  assert.equal((await manager.stopAll(team.id)).stopped, 0)
  const calls = threads.calls.length
  t.mock.timers.tick(RESUME_DELAY_MS)
  assert.equal(threads.calls.length, calls)
  assert.equal(team.queue.length, 0)
})

test('fresh is refused while the child waits for an approval, and still works when the old task is already gone', async (t) => {
  const { threads, tool, team } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  threads.threads.get('thread-1').pendingApproval = true
  await assert.rejects(tool('send', { child: 'A', message: 'b', fresh: true }), /承認待ちです/)
  threads.threads.get('thread-1').pendingApproval = false
  threads.finish('thread-1', 'done')
  // Gone without a word: its removal throws at once.
  threads.remove = (id) => {
    if (id === 'thread-1') throw new Error('タスクが見つかりません')
    threads.threads.delete(id)
  }
  assert.match(await tool('send', { child: 'A', message: 'b', fresh: true }), /新しい会話で始めました/)
  assert.equal(threads.calls.filter((call) => call[0] === 'create').length, 2)
  assert.ok(threads.threads.has(team.children[0].taskId))
  assert.equal(team.children[0].awaiting, true)
})

for (const mode of ['TM', 'eco']) {
  for (const provider of ['gpt', 'claude']) {
    test(`${mode}: user can delete a running ${provider} child without deleting files`, async (t) => {
      const f = mode === 'eco' ? await setupExecution(t) : await setup(t)
      const args = mode === 'eco' ? { ...exTask, provider, mode: 'research' } : { title: 'job', task: 'work', tier: 'low', provider }
      await f.tool('spawn', args)
      const child = f.team.children[0]
      const file = path.join(f.workspace, 'kept.txt')
      await fs.writeFile(file, 'keep')
      f.team.queue.push({ id: 'report', childId: child.id, kind: 'report', text: 'old', at: Date.now() })
      assert.deepEqual(await f.manager.removeChild(f.team.id, child.id), { removed: true })
      assert.equal(f.team.children.length, 0)
      assert.equal(f.team.queue.some((item) => item.childId === child.id), false)
      const calls = provider === 'gpt' ? f.threads.calls : f.agents.calls
      assert.ok(calls.some((call) => call[0] === 'remove' && call[1] === child.taskId))
      assert.equal(await fs.readFile(file, 'utf8'), 'keep')
      await tick()
      const notice = [...f.team.queue.map((item) => item.text), ...f.threads.calls.filter((call) => call[0] === 'send' && call[1] === f.leader).map((call) => call[2]), ...f.typed()].join('\n')
      assert.match(notice, /ユーザーが子.*削除/)
      await assert.rejects(f.manager.removeChild(f.team.id, child.id), /見つかりません/)
    })
  }
}

test('eco deletion keeps the write guard until verification stops', async (t) => {
  const f = await setupExecution(t)
  await f.tool('spawn', exTask)
  const child = f.team.children[0]
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  f.manager.execution.active.set(child.id, { done, stop: () => {} })
  const removal = f.manager.removeChild(f.team.id, child.id)
  assert.throws(() => f.manager.guardExecution({ workspace: f.workspace, id: 'other' }), /eco/)
  await assert.rejects(f.tool('send', { child: child.id, message: 'again' }), /削除中/)
  f.manager.execution.active.delete(child.id)
  finish()
  await removal
  assert.doesNotThrow(() => f.manager.guardExecution({ workspace: f.workspace, id: 'other' }))
})

test('failed task deletion keeps the child and allows retry', async (t) => {
  const f = await setup(t)
  await f.tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt' })
  const child = f.team.children[0]
  const remove = f.threads.remove
  f.threads.remove = async () => { throw new Error('disk failure') }
  await assert.rejects(f.manager.removeChild(f.team.id, child.id), /disk failure/)
  assert.equal(f.team.children[0], child)
  assert.equal(child.closed, false)
  f.threads.remove = remove
  await f.manager.removeChild(f.team.id, child.id)
  assert.equal(f.team.children.length, 0)
})

test('deleting a child during fresh start removes both old and new tasks', async (t) => {
  const { threads, tool, team, manager } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  threads.finish('thread-1', 'done')
  const child = team.children[0]
  const create = threads.create
  threads.create = async (options) => {
    await manager.removeChild(team.id, child.id)
    return create(options)
  }
  await assert.rejects(tool('send', { child: 'A', message: 'b', fresh: true }), /終了されました/)
  assert.deepEqual([...threads.threads.keys()].filter((id) => id !== team.leaderId), [])
  assert.equal(team.children.length, 0)
})

test('a team removed while a fresh start runs leaves neither task behind', async (t) => {
  const { threads, tool, team, manager } = await setup(t)
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'gpt', name: 'A' })
  threads.finish('thread-1', 'done')
  const create = threads.create
  threads.create = async (options) => {
    await manager.removeTeam(team.id)
    return create(options)
  }
  await assert.rejects(tool('send', { child: 'A', message: 'b', fresh: true }), /team was removed/)
  assert.deepEqual([...threads.threads.keys()].filter((id) => id !== team.leaderId), [])
})

test('stopping all drops what waited for the stopped turns, so nothing starts again', async (t) => {
  const { agents, threads, terminals, tool, leader, manager, team } = await setup(t)
  terminals.set(leader, { activity: 'running' })
  await tool('spawn', { title: 'c', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  await tool('spawn', { title: 'g', task: 'b', tier: 'low', provider: 'gpt', name: 'G' })
  agents.sessions.get('agent-1').steerable = false
  await tool('send', { child: 'C', message: 'あとで' })
  manager.messageChild(team.id, team.children[0].id, 'ユーザーの予約')
  await tool('send', { child: 'G', message: 'あとで' })
  assert.deepEqual(team.children.map((child) => child.pending.length), [1, 1])
  await manager.stopAll(team.id)
  threads.threads.get('thread-1').status = 'idle'
  threads.emit('turn-finished', { threadId: 'thread-1', status: 'cancelled' })
  await tick()
  assert.equal(agents.running('agent-1'), false)
  assert.equal(threads.threads.get('thread-1').status, 'idle')
  assert.equal(agents.calls.filter((call) => call[0] === 'run').length, 1)
})

test('a closed child does not start again on a message the user left for it', async (t) => {
  const { agents, tool, manager, team } = await setup(t)
  await tool('spawn', { title: 'c', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  manager.messageChild(team.id, team.children[0].id, 'ユーザーの予約')
  await tool('close', { child: 'C' })
  await tick()
  assert.equal(agents.running('agent-1'), false)
  assert.equal(agents.calls.filter((call) => call[0] === 'run').length, 1)
})

test('a message that missed the turn ending while it was steered goes when the child is free', async (t) => {
  const { threads, tool } = await setup(t)
  await tool('spawn', { title: 'g', task: 'b', tier: 'low', provider: 'gpt', name: 'G' })
  // The turn ends while the steer is answered, and the steer did not take.
  threads.steer = async (id, { text }) => {
    threads.calls.push(['steer', id, text])
    threads.finish(id, 'done')
    await tick()
    return { steered: false }
  }
  await tool('send', { child: 'G', message: '追加の指示' })
  await tick()
  assert.equal(threads.calls.filter((call) => call[0] === 'send' && call[1] === 'thread-1').at(-1)[2], '[リーダーから]\n追加の指示')
})

test('a child waiting to go on after a passing failure shows as such', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { threads, tool, manager, team } = await setup(t)
  await tool('spawn', { title: 'g', task: 'b', tier: 'low', provider: 'gpt', name: 'G' })
  failThread(threads, 'thread-1', '503 Service Unavailable')
  assert.equal(manager.summary(team).children[0].state, 'resuming')
  assert.match(await tool('status'), /G \[再開待ち\]/)
})

test('a Claude child may leave a long command in the background; a dsh child is told to wait for it', async (t) => {
  const { tool, agents } = await setup(t)
  await tool('spawn', { title: 'a', task: 'x', tier: 'low', provider: 'claude', name: 'C' })
  const args = agents.calls.find((call) => call[0] === 'create')[1].args
  const prompt = await fs.readFile(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')
  assert.match(prompt, /you are woken when it ends/)
  assert.doesNotMatch(prompt, /Wait for every command to finish/)
  const { childPrompt } = await import('../server/teams-prompts.js')
  assert.match(childPrompt(), /Wait for every command to finish/)
})

test('stopping all stops a child that a turn of its own runs while it waits after a passing failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { agents, terminals, tool, leader, manager, team } = await setup(t)
  terminals.set(leader, { activity: 'running' })
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  agents.finish('agent-1', '', 'error', { error: 'API Error: 529 Overloaded' })
  manager.messageChild(team.id, team.children[0].id, 'ユーザーの追加指示')
  assert.equal(manager.summary(team).children[0].state, 'running')
  assert.equal((await manager.stopAll(team.id)).stopped, 1)
  assert.equal(agents.running('agent-1'), false)
  assert.deepEqual(team.queue.map((item) => [item.kind, item.byUser]), [['cancelled', true]])
  const runs = agents.calls.filter((call) => call[0] === 'run').length
  t.mock.timers.tick(RESUME_DELAY_MS)
  assert.equal(agents.calls.filter((call) => call[0] === 'run').length, runs)
})

test('a task being removed reports no turn that ends with its removal', async (t) => {
  const { threads, agents, terminals, tool, leader, typed, team } = await setup(t)
  terminals.set(leader, { activity: 'idle' })
  await tool('spawn', { title: 'g', task: 'b', tier: 'low', provider: 'gpt', name: 'G' })
  await tool('spawn', { title: 'c', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  // As threads.remove: the running turn is cancelled first (turn-finished), then the task goes (removed).
  threads.remove = async (id) => {
    threads.removing.set(id, Promise.resolve())
    threads.finish(id, '', 'cancelled')
    threads.threads.delete(id)
    threads.emit('removed', { threadId: id })
    threads.removing.delete(id)
  }
  await threads.remove('thread-1')
  // As claude-runner remove: the record goes first, then the session's turn ends (finished).
  agents.sessions.delete('agent-1')
  agents.emit('finished', { id: 'agent-1', status: 'cancelled', text: '', error: null, denials: [] })
  agents.emit('removed', { id: 'agent-1' })
  assert.equal(team.children.length, 0)
  assert.deepEqual(typed(), [])
})

test('a GPT child whose waiting instruction did not go is no longer awaiting, so a restart reports nothing', async (t) => {
  const { threads, terminals, tool, leader, manager, team } = await setup(t)
  terminals.set(leader, { activity: 'idle' })
  await tool('spawn', { title: 'g', task: 'b', tier: 'low', provider: 'gpt', name: 'G' })
  await tool('send', { child: 'G', message: '追加の指示' })
  const send = threads.send
  threads.send = async () => {
    throw new Error('ChatGPT のモデルを使うには、設定から ChatGPT にサインインしてください。')
  }
  threads.finish('thread-1', '途中まで')
  threads.send = send
  await tick()
  assert.equal(team.children[0].awaiting, false)
  // The report of the failed instruction waits behind the report just handed to the leader.
  assert.deepEqual(team.queue.map((item) => item.kind), ['error'])
  manager.start()
  assert.deepEqual(team.queue.map((item) => item.kind), ['error'])
})

test('removing a team whose leader will not go still saves the team out and says so', async (t) => {
  const { terminals, tool, manager, team, dir } = await setup(t)
  await tool('spawn', { title: 'c', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  const removed = []
  manager.on('removed', ({ teamId }) => removed.push(teamId))
  const remove = terminals.remove
  terminals.remove = async () => {
    throw new Error('disk busy')
  }
  await assert.rejects(() => manager.removeTeam(team.id), /disk busy/)
  terminals.remove = remove
  assert.equal(manager.teams.size, 0)
  assert.deepEqual(removed, [team.id])
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'teams.json'), 'utf8'))
  assert.deepEqual(saved.teams, [])
})

test('a turn the app shutdown cut off is not reported; the restart reports it as cut off', async (t) => {
  const { threads, terminals, tool, leader, typed, manager, team } = await setup(t)
  terminals.set(leader, { activity: 'idle' })
  await tool('spawn', { title: 'g', task: 'b', tier: 'low', provider: 'gpt', name: 'G' })
  // As threads.shutdown: the app is stopping, and the running turn ends cancelled.
  threads.stopping = true
  threads.finish('thread-1', '途中まで', 'cancelled')
  assert.deepEqual(typed(), [])
  assert.equal(team.children[0].awaiting, true)
  manager.start()
  assert.match(typed().at(-1), /再起動したため、作業が途中で止まりました/)
})

test('a passing failure in a turn the user started gets the automatic resume once that turn is over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { agents, terminals, tool, leader, manager, team } = await setup(t)
  terminals.set(leader, { activity: 'running' })
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  agents.finish('agent-1', '', 'error', { error: 'API Error: 529 Overloaded' })
  manager.messageChild(team.id, team.children[0].id, 'ユーザーの追加指示')
  // The wait ends while the user's turn runs: it is no automatic resume, so the next passing failure gets one.
  t.mock.timers.tick(RESUME_DELAY_MS)
  agents.finish('agent-1', '', 'error', { error: 'API Error: 529 Overloaded' })
  t.mock.timers.tick(RESUME_DELAY_MS)
  assert.equal(agents.calls.at(-1)[0], 'run')
  assert.match(agents.calls.at(-1)[2], /自動で再開しました/)
})

test('a child whose task was not made when the app stopped is dropped, and the leader is told', async (t) => {
  const { terminals, tool, leader, typed, manager, team } = await setup(t)
  terminals.set(leader, { activity: 'idle' })
  await tool('spawn', { title: 'job', task: 'a', tier: 'low', provider: 'claude', name: 'C' })
  // A saved team whose child's task was being made: no task is saved for it.
  team.children[0].taskId = null
  manager.start()
  assert.deepEqual(team.children, [])
  assert.match(typed().at(-1), /子の作業を始める前に止まりました/)
})
