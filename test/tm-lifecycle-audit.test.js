import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { TeamManager } from '../server/teams.js'
import { TerminalManager } from '../server/terminals.js'
import { TEAM_DEFAULTS } from '../server/team-config.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const model = { id: 'mock-gpt', value: '["openai-codex","mock-gpt"]', provider: 'openai-codex', name: 'Mock GPT' }
const catalog = { data: { models: [model] } }
const settings = {
  ...structuredClone(TEAM_DEFAULTS),
  gpt: { ...structuredClone(TEAM_DEFAULTS.gpt), enabled: true, low: { enabled: true, model: model.id, effort: 'medium' } },
  claude: { ...structuredClone(TEAM_DEFAULTS.claude), enabled: true },
}

// Minimal event-driven stand-ins for the task managers; no external model is called.
function fakeThreads() {
  let seq = 0
  const threads = Object.assign(new EventEmitter(), {
    threads: new Map(), turns: new Map(), removing: new Map(), permissions: [], calls: [],
    async create(options) {
      const thread = { id: 'thread-' + ++seq, status: 'idle', pendingApproval: false, ...options }
      threads.threads.set(thread.id, thread)
      threads.turns.set(thread.id, [])
      threads.emit('thread', { ...thread })
      return { ...thread }
    },
    async send(id, { text }, { guard } = {}) {
      guard?.()
      const thread = threads.threads.get(id)
      if (!thread) throw new Error('task not found')
      if (thread.status === 'running') throw new Error('task is running')
      threads.calls.push(['send', id, text])
      thread.status = 'running'
      threads.turns.get(id).push({ items: [], status: 'running' })
      return { status: 'accepted' }
    },
    async update(id, patch) { Object.assign(threads.threads.get(id), patch) },
    async setGoalWaiting() {},
    async steer(_id, _message, { guard } = {}) { guard?.(); return { steered: false } },
    async cancel(id) { if (threads.threads.get(id)?.status === 'running') threads.finish(id, '', 'cancelled') },
    async remove(id) { threads.threads.delete(id); threads.emit('removed', { threadId: id }) },
    pendingPermissions: (id) => threads.permissions.filter((entry) => entry.threadId === id),
    respondPermission(requestId, optionId) {
      const pending = threads.permissions.find((entry) => entry.requestId === requestId)
      if (!pending) throw new Error('permission already settled')
      threads.calls.push(['respond', requestId, optionId])
      threads.permissions = threads.permissions.filter((entry) => entry !== pending)
      const thread = threads.threads.get(pending.threadId)
      thread.pendingApproval = threads.pendingPermissions(thread.id).length > 0
      threads.emit('thread', { ...thread })
    },
    finish(id, text, status = 'done') {
      const thread = threads.threads.get(id)
      thread.status = status === 'error' ? 'error' : 'idle'
      const turn = threads.turns.get(id).at(-1)
      turn.items.push({ type: 'agent', text })
      turn.status = status
      threads.emit('thread', { ...thread })
      threads.emit('turn-finished', { threadId: id, status })
    },
  })
  return threads
}

function fakeTerminals() {
  let seq = 0
  const terminals = Object.assign(new EventEmitter(), {
    records: new Map(), states: new Map(), calls: [],
    async create(options) {
      const record = { id: 'terminal-' + ++seq, ...options }
      terminals.records.set(record.id, record)
      terminals.states.set(record.id, { state: 'running', activity: 'idle', ready: true, inputAt: 0 })
      return terminals.summary(record)
    },
    summary: (record) => ({ ...record, ...terminals.states.get(record.id) }),
    status: (id) => terminals.states.get(id) ?? null,
    set(id, patch, input) {
      Object.assign(terminals.states.get(id), patch)
      terminals.emit('terminal', terminals.summary(terminals.records.get(id)), input)
    },
    sendMessage(id, text) { terminals.calls.push(['type', id, text]) },
    pressEnter(id) { terminals.calls.push(['enter', id]) },
    async remove(id) { terminals.records.delete(id); terminals.emit('removed', { terminalId: id }) },
    // TerminalManager emits the changed state before the hook with the submitted marks.
    took(id, marks) {
      const input = { hook_event_name: 'UserPromptSubmit', team_marks: marks }
      terminals.set(id, { activity: 'running' }, input)
      terminals.emit('hook', { terminalId: id, input })
    },
  })
  return terminals
}

function fakeAgents() {
  let seq = 0
  const agents = Object.assign(new EventEmitter(), {
    sessions: new Map(), calls: [],
    async create(options) {
      const session = { id: 'agent-' + ++seq, running: false, ...options }
      agents.sessions.set(session.id, session)
      return agents.get(session.id)
    },
    get(id) {
      const session = agents.sessions.get(id)
      return session ? { id, state: session.running ? 'running' : 'idle', lastStatus: session.lastStatus } : null
    },
    running: (id) => Boolean(agents.sessions.get(id)?.running),
    run(id, text) {
      const session = agents.sessions.get(id)
      if (!session || session.running) throw new Error('agent not available')
      agents.calls.push(['run', id, text])
      session.running = true
      agents.emit('session', agents.get(id))
    },
    stop(id) {
      const session = agents.sessions.get(id)
      if (!session?.running) return false
      session.running = false
      agents.emit('finished', { id, status: 'cancelled', text: '', error: null, denials: [] })
      return true
    },
    async remove(id) { agents.sessions.delete(id); agents.emit('removed', { id }) },
  })
  return agents
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-lifecycle-audit-'))
  const workspace = path.join(dir, 'project')
  await fs.mkdir(workspace)
  const threads = fakeThreads(), terminals = fakeTerminals(), agents = fakeAgents()
  const managers = []
  const newManager = async () => {
    const manager = await new TeamManager({
      file: path.join(dir, 'teams.json'), dir: path.join(dir, 'teams'),
      threads, terminals, agents, catalog, getSettings: () => settings,
      apiUrl: () => 'http://127.0.0.1:1/api/team', gatherMs: 0,
    }).load()
    managers.push(manager)
    return manager
  }
  t.after(async () => {
    for (const manager of managers) await manager.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })
  const manager = await newManager()
  const created = await manager.create({ workspace })
  const team = manager.teams.get(created.team.id)
  const call = (current, name, args = {}) => current.manager.call(current.team.id, current.team.secret, name, args)
  const ctx = { manager, team }
  return {
    dir, threads, terminals, agents, manager, team, leader: created.terminal.id, newManager,
    tool: (name, args) => call(ctx, name, args),
    toolFor: (current, name, args) => call(current, name, args),
    typed: () => terminals.calls.filter((entry) => entry[0] === 'type').map((entry) => entry[2]),
  }
}

const task = (name, provider = 'gpt') => ({ name, title: 'Job ' + name, task: 'Do the assigned work', tier: 'low', provider })

test('an unrelated leader prompt does not consume a report being delivered', async (t) => {
  const f = await setup(t)
  await f.tool('spawn', task('A'))
  f.threads.finish(f.team.children[0].taskId, 'child report')
  assert.equal(f.manager.summary(f.team).delivery, 'delivering')
  assert.equal(f.typed().length, 1)
  f.terminals.took(f.leader, [])
  f.terminals.set(f.leader, { activity: 'idle' })
  assert.equal(f.typed().length, 2, 'the undelivered report must be offered again after the unrelated turn')
  assert.match(f.typed()[1], /child report/)
})

test('a leader prompt with the report mark acknowledges it once', async (t) => {
  const f = await setup(t)
  await f.tool('spawn', task('A'))
  f.threads.finish(f.team.children[0].taskId, 'child report')
  const mark = f.typed()[0].match(/#([0-9a-f]{8})/)?.[1]
  assert.ok(mark)
  f.terminals.took(f.leader, [mark])
  f.terminals.set(f.leader, { activity: 'idle' })
  assert.equal(f.typed().length, 1)
  assert.equal(f.team.queue.length, 0)
})

test('stop all discards an interrupted child queued instruction after restart', async (t) => {
  const f = await setup(t)
  f.terminals.set(f.leader, { activity: 'running' })
  await f.tool('spawn', task('A'))
  await f.tool('send', { child: 'A', message: 'old queued instruction' })
  const id = f.team.children[0].taskId
  await f.manager.stop()
  f.manager.teams.clear() // The old process no longer receives task events.
  f.threads.threads.get(id).status = 'idle'
  const manager = await f.newManager()
  const team = manager.teams.get(f.team.id)
  const current = { manager, team }
  manager.start()
  await f.toolFor(current, 'spawn', task('B'))
  await manager.stopAll(team.id)
  const pendingAfterStop = [...team.children[0].pending]
  await f.toolFor(current, 'send', { child: 'A', message: 'new instruction' })
  f.threads.finish(id, 'new work finished')
  await tick()
  const sent = f.threads.calls.filter((entry) => entry[0] === 'send' && entry[1] === id).map((entry) => entry[2])
  assert.deepEqual(pendingAfterStop, [])
  assert.equal(sent.some((text) => text.includes('old queued instruction')), false)
})

for (const provider of ['gpt', 'claude']) {
  test('closing a ' + provider + ' child during creation prevents its turn from starting', async (t) => {
    const f = await setup(t)
    const tasks = provider === 'gpt' ? f.threads : f.agents
    const create = tasks.create
    let release, entered
    const gate = new Promise((resolve) => { release = resolve })
    const creating = new Promise((resolve) => { entered = resolve })
    tasks.create = async (options) => { entered(); await gate; return create(options) }
    const spawn = f.tool('spawn', task('A', provider))
    await creating
    const close = f.tool('close', { child: 'A' })
    await tick()
    release()
    const [closed] = await Promise.allSettled([close, spawn])
    assert.equal(closed.status, 'fulfilled')
    assert.equal(tasks.calls.filter((entry) => entry[0] === (provider === 'gpt' ? 'send' : 'run')).length, 0)
    assert.equal([...tasks[provider === 'gpt' ? 'threads' : 'sessions'].values()].some((entry) => entry.status === 'running' || entry.running), false)
    await f.manager.writes
    const saved = JSON.parse(await fs.readFile(path.join(f.dir, 'teams.json'), 'utf8')).teams.find((team) => team.id === f.team.id)
    assert.deepEqual(saved.children.map((child) => child.id), f.team.children.map((child) => child.id))
  })
}

test('resolving one of multiple approvals directly leaves only the other for the leader', async (t) => {
  const f = await setup(t)
  await f.tool('spawn', task('A'))
  f.terminals.set(f.leader, { activity: 'running' })
  const id = f.team.children[0].taskId
  f.threads.threads.get(id).pendingApproval = true
  for (const n of [1, 2]) {
    f.threads.permissions.push({
      threadId: id, requestId: 'req-' + n, name: 'shell', input: { command: 'command-' + n },
      options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
    })
    f.threads.emit('approval-needed', { threadId: id })
  }
  f.threads.respondPermission('req-1', 'no') // User answers in the child's task view.
  const reply = await f.tool('approve', { child: 'A', allow: true })
  assert.match(reply, /command-2/)
  assert.deepEqual(f.threads.calls.filter((entry) => entry[0] === 'respond'), [
    ['respond', 'req-1', 'no'], ['respond', 'req-2', 'yes'],
  ])
  assert.equal(f.threads.permissions.length, 0)
})

test('a startup interrupted before task creation identifies the lost child', async (t) => {
  const f = await setup(t)
  f.terminals.set(f.leader, { activity: 'running' })
  await f.tool('spawn', task('Lost'))
  f.team.children[0].taskId = null // The saved child had not acquired a task yet.
  f.manager.start()
  assert.equal(f.team.children.length, 0)
  await f.manager.stop()
  f.manager.teams.clear()
  const restored = await f.newManager()
  restored.start()
  f.terminals.set(f.leader, { activity: 'idle' })
  const message = f.typed().at(-1)
  assert.match(message, /Lost/)
  assert.match(message, /Job Lost/)
  assert.match(message, /spawn/)
  assert.doesNotMatch(message, /止まった子を続けるなら send/)
})


test('the terminal publishes submit context with its activity change', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-hook-context-'))
  const terminal = new TerminalManager({
    file: path.join(dir, 'terminals.json'), settingsFile: path.join(dir, 'settings.json'),
    hookUrl: () => '', send: () => {}, claudeHome: dir,
  })
  t.after(async () => { await terminal.writes; await fs.rm(dir, { recursive: true, force: true }) })
  const id = 'terminal-1', secret = 'test-secret'
  terminal.records.set(id, { id, workspace: dir })
  terminal.live.set(id, { alive: true, activity: 'idle', secret, background: new Map() })
  const events = []
  terminal.on('terminal', (summary, input) => events.push({ activity: summary.activity, input }))
  const input = { hook_event_name: 'UserPromptSubmit', team_marks: [] }
  assert.equal(terminal.hook(id, secret, input), true)
  assert.deepEqual(events, [{ activity: 'running', input }])
})

test('a failed old paste cannot replace the retry after another prompt', async (t) => {
  const f = await setup(t)
  let rejectFirst
  f.terminals.sendMessage = (id, text) => {
    f.terminals.calls.push(['type', id, text])
    if (f.typed().length === 1) return new Promise((_resolve, reject) => { rejectFirst = reject })
  }
  await f.tool('spawn', task('A'))
  f.threads.finish(f.team.children[0].taskId, 'child report')
  f.terminals.took(f.leader, [])
  f.terminals.set(f.leader, { activity: 'idle' })
  assert.equal(f.typed().length, 2)
  rejectFirst(new Error('old paste failed'))
  await tick()
  assert.equal(f.manager.summary(f.team).delivery, 'delivering')
  assert.equal(f.team.queue.length, 0)
})

for (const provider of ['gpt', 'claude']) {
  test('closing a ' + provider + ' child while starting fresh preserves the close', async (t) => {
    const f = await setup(t)
    const tasks = provider === 'gpt' ? f.threads : f.agents
    f.terminals.set(f.leader, { activity: 'running' })
    await f.tool('spawn', task('A', provider))
    const child = f.team.children[0]
    if (provider === 'gpt') f.threads.finish(child.taskId, 'done')
    else {
      const session = f.agents.sessions.get(child.taskId)
      session.running = false
      f.agents.emit('finished', { id: child.taskId, status: 'done', text: 'done', error: null, denials: [] })
    }
    const create = tasks.create
    let release, entered
    const gate = new Promise((resolve) => { release = resolve })
    const creating = new Promise((resolve) => { entered = resolve })
    tasks.create = async (options) => { entered(); await gate; return create(options) }
    const fresh = f.tool('send', { child: 'A', message: 'new conversation', fresh: true })
    await creating
    const close = f.tool('close', { child: 'A' })
    await tick()
    release()
    const [closed] = await Promise.allSettled([close, fresh])
    assert.equal(closed.status, 'fulfilled')
    assert.equal(child.closed, true)
    assert.equal(child.awaiting, false)
    assert.equal(tasks.calls.filter((entry) => entry[0] === (provider === 'gpt' ? 'send' : 'run')).length, 1)
  })
}


test('closing a GPT child before its initial send commits prevents the turn', async (t) => {
  const f = await setup(t)
  const send = f.threads.send
  let release, entered
  const gate = new Promise((resolve) => { release = resolve })
  const sending = new Promise((resolve) => { entered = resolve })
  f.threads.send = async (id, message, options) => { entered(); await gate; return send(id, message, options) }
  const spawn = f.tool('spawn', task('A'))
  await sending
  const close = f.tool('close', { child: 'A' })
  await tick()
  release()
  const [closed] = await Promise.allSettled([close, spawn])
  assert.equal(closed.status, 'fulfilled')
  assert.equal(f.threads.calls.filter((entry) => entry[0] === 'send').length, 0)
})

test('stop all discards a waiting Claude child user followup after restart', async (t) => {
  const f = await setup(t)
  f.terminals.set(f.leader, { activity: 'running' })
  await f.tool('spawn', task('A', 'claude'))
  const child = f.team.children[0]
  f.manager.messageChild(f.team.id, child.id, 'old user followup')
  await f.manager.stop()
  f.manager.teams.clear()
  f.agents.sessions.get(child.taskId).running = false
  const manager = await f.newManager()
  const team = manager.teams.get(f.team.id)
  manager.start()
  await f.toolFor({ manager, team }, 'spawn', task('B'))
  await manager.stopAll(team.id)
  const restored = team.children[0]
  assert.deepEqual(restored.followups, [])
  await f.toolFor({ manager, team }, 'send', { child: 'A', message: 'new instruction' })
  f.agents.sessions.get(child.taskId).running = false
  f.agents.emit('finished', { id: child.taskId, status: 'done', text: 'done', error: null, denials: [] })
  await tick()
  assert.equal(f.agents.calls.some((entry) => entry[2].includes('old user followup')), false)
})
