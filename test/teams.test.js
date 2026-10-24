import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DELIVERY_CHECK_MS, DELIVERY_GIVE_UP_MS, LEADER_SETTLE_MS, MCP_SERVER, PREFIX, REPORT_PREVIEW, REPORT_GATHER_MS, RESUME_DELAY_MS, TeamManager, TYPING_QUIET_MS, describeTool, transientError } from '../server/teams.js'
import { assertChildrenOn, mergeTeamConfig, teamConfig, TEAM_DEFAULTS } from '../server/team-config.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** dsh tasks as the team sees them: create, send, steer, and the events a turn makes. */
function fakeThreads() {
  const threads = Object.assign(new EventEmitter(), {
    threads: new Map(),
    turns: new Map(),
    calls: [],
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
    async send(id, { text }) {
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

async function setupExecution(t) {
  const base = await setup(t, { leaderProvider: 'gpt' })
  execFileSync('git', ['init', '-q', base.workspace])
  await fs.writeFile(path.join(base.workspace, 'source.txt'), 'original')
  const { team: view } = await base.manager.create({ workspace: base.workspace, execution: {} })
  const team = base.manager.teams.get(view.id)
  return { ...base, team, leader: team.leaderId, tool: (name, args = {}) => base.manager.call(team.id, team.secret, name, args) }
}
const exTask = { title: 'implement', task: 'do the bounded work', criteria: 'the test passes without unrelated changes', checks: [], tier: 'low', provider: 'gpt' }

test('EX holds one writer through verification and parent judgment, then checks freshness', async (t) => {
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
  assert.match(child.reports.at(-1).text, /EX 検証: passed/)
  await fs.writeFile(path.join(workspace, 'source.txt'), 'external edit')
  await assert.rejects(tool('close', { child: child.id }), /変更/)
  assert.equal(child.execution.verification.status, 'stale')
  await tool('close', { child: child.id, accept: false, reason: 'external edit needs a new plan' })
  assert.equal(child.execution.outcome, 'abandoned')
})

test('EX retries explicitly repairable failures once, then escalates repeated evidence', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await manager.configureExecution(workspace, [{ id: 'test', command: 'node -e "console.log(123);process.exit(2)"', autoRepair: true }])
  await tool('spawn', { ...exTask, checks: ['test'] })
  const child = team.children[0]
  threads.finish(child.taskId, 'done')
  await Promise.all([...manager.exPending])
  assert.equal(child.execution.repairs, 1)
  assert.equal(child.execution.phase, 'working')
  assert.equal(child.reports.length, 0)
  threads.finish(child.taskId, 'done again')
  await Promise.all([...manager.exPending])
  assert.equal(child.execution.repairs, 1)
  assert.equal(child.execution.phase, 'review')
  assert.equal(child.execution.verification.status, 'failed')
  await assert.rejects(tool('close', { child: child.id }), /成功していません/)
})

test('EX requires acceptance criteria and checks, isolates research and preserves TM defaults', async (t) => {
  const { tool, team, manager, threads, workspace } = await setupExecution(t)
  await assert.rejects(tool('spawn', { ...exTask, criteria: '' }), /criteria/)
  await assert.rejects(tool('spawn', { ...exTask, checks: ['missing'] }), /登録/)
  await assert.rejects(tool('spawn', { ...exTask, tier: 'mid' }), /低枠/)
  await tool('spawn', { ...exTask, mode: 'research' })
  const research = team.children[0]
  assert.equal(threads.threads.get(research.taskId).permissionMode, 'read-only')
  await tool('spawn', exTask)
  const writer = team.children[1]
  assert.throws(() => manager.guardExecution({ id: 'ordinary', workspace }), /EX/)
  manager.guardExecution({ id: team.leaderId, workspace })
  threads.finish(writer.taskId, 'done')
  await Promise.all([...manager.exPending])
  assert.equal(writer.execution.verification.status, 'unverified')
  await assert.rejects(tool('close', { child: writer.id }), /根拠/)
  await tool('close', { child: writer.id, reason: 'manually reviewed source' })
  assert.equal(writer.execution.outcome, 'accepted')
})

test('EX stopAll before verification starts does not launch a command or auto-repair', async (t) => {
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

test('EX failed send preserves the reviewed evidence and restart interrupts verification', async (t) => {
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
  assert.throws(() => manager.guardExecution({ id: 'other', workspace: path.join(workspace, 'nested') }), /EX/)
})

test('EX accepts an explicitly chosen API parent and records mode in launch tools', async (t) => {
  const { manager, workspace } = await setupExecution(t)
  const result = await manager.create({ workspace, execution: { leaderModel: '["anthropic","claude-haiku-5-5"]' } })
  assert.equal(result.thread.model, '["anthropic","claude-haiku-5-5"]')
  assert.equal(result.thread.title, '実行モード')
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
  assert.match(prompt, /provider "gpt".*low = GPT-6 Luna, mid = GPT-6\.1 Sol/)
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
    workspace, model: '["openai-codex","gpt-6-luna"]', effort: 'medium', permissionMode: 'danger-full-access',
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
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'low' }), /provider を "gpt" \/ "claude" のどれか/)
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
  // DeepSeek is off until turned on, and only works as a child.
  assert.equal(teamConfig({}).deepseek.enabled, false)
  assert.equal(mergeTeamConfig(undefined, { deepseek: { enabled: true, low: { model: 'deepseek-v4-flash' } } }).deepseek.low.model, 'deepseek-v4-flash')
  assert.throws(() => mergeTeamConfig(undefined, { leaderProvider: 'deepseek' }), /リーダー/)
  assert.equal(teamConfig({ leaderProvider: 'deepseek' }).leaderProvider, 'claude')
  // So is OpenCode Go.
  assert.equal(mergeTeamConfig(undefined, { opencodeGo: { enabled: true, mid: { model: 'kimi-k3' } } }).opencodeGo.mid.model, 'kimi-k3')
  assert.throws(() => mergeTeamConfig(undefined, { opencodeGo: { enabled: true, low: { enabled: false }, mid: { enabled: false } } }), /OpenCode Go の低枠と中枠/)
  assert.throws(() => mergeTeamConfig(undefined, { leaderProvider: 'opencodeGo' }), /リーダー/)
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
  assert.match(prompt,/provider "deepseek" \(DeepSeek, billed per token.*low = DeepSeek V4 Flash, mid = turned off/)
  assert.match(await tool('spawn', { title: '翻訳', task: 'docs を訳す', tier: 'low', provider: 'deepseek', name: 'D' }), /子「D」を起動しました（DeepSeek V4 Flash・低）/)
  const [, options] = threads.calls.find((call) => call[0] === 'create')
  assert.deepEqual(options, {
    workspace, model: '["deepseek-official","deepseek-v4-flash"]', effort: '', permissionMode: 'danger-full-access',
    team: { id: team.id, childId: team.children[0].id },
  })
  assert.equal(manager.summary(team).children[0].kind, 'thread')
  assert.equal(manager.summary(team).children[0].provider, 'deepseek')
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'mid', provider: 'deepseek' }), /DeepSeekの中枠はユーザーがオフ/)
  await assert.rejects(tool('spawn', { title: 'x', task: 'y', tier: 'low' }), /"gpt" \/ "claude" \/ "deepseek"/)
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
    workspace, model: '["opencode-go","glm-5.3"]', effort: 'high', permissionMode: 'danger-full-access',
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
  assert.match(prompt, /provider "claudeApi" \(Claude through dsh on the user's Anthropic API key.*low = Claude Haiku 5\.5, mid = turned off/)
  assert.match(prompt, /Claude Code using its own user-confirmed subscription, API key or cloud authentication/)
  assert.doesNotMatch(prompt, /monthly API credits/)
  assert.match(await tool('spawn', { title: '要約', task: 'docs を要約', tier: 'low', provider: 'claudeApi', name: 'A' }), /子「A」を起動しました（Claude Haiku 5\.5・低）/)
  const [, options] = threads.calls.find((call) => call[0] === 'create')
  assert.deepEqual(options, {
    workspace, model: '["anthropic","claude-haiku-5-5"]', effort: '', permissionMode: 'danger-full-access',
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
    workspace, model: '["openai-codex","gpt-6.1-sol"]', effort: 'high', permissionMode: 'danger-full-access', team: { id: team.id, role: 'leader' },
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
