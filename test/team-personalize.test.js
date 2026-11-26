import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'
import { CodexRunner } from '../server/codex-runner.js'
import { CUSTOM_INSTRUCTIONS_CONFIG, assertCustomInstructionsApplied, assertCustomInstructionsMode, customInstructionsOption } from '../server/custom-instructions.js'
import { SECTION_NAME as INSTRUCTIONS_SECTION_NAME } from '../server/instructions-plugin.js'
import { assertPresentationReady, hasSessionOption, setCustomInstructions, setSessionOption, withToolMode } from '../server/ptc-bridge.js'
import { TOOL_MODE_CONFIG } from '../server/ptc.js'
import { createTerminalHandlers } from '../server/rpc-handlers-terminals.js'
import { effectiveCustomInstructions } from '../server/settings.js'
import { TEAM_DEFAULTS, TEAM_PERSONALIZE_MODES, mergeTeamConfig, teamConfig, teamPersonalizeEnabled } from '../server/team-config.js'
import { TeamManager } from '../server/teams.js'
import { restoreTeams } from '../server/teams-store.js'
import * as modelSelection from '../web/src/model-selection.ts'
import { fixture as threadFixture } from './helpers/thread-manager.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

const CATALOG = {
  data: {
    models: [
      { value: '["openai-codex","gpt-6-luna"]', provider: 'openai-codex', id: 'gpt-6-luna', name: 'GPT-6 Luna' },
      { value: '["openai-codex","gpt-6.1-sol"]', provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
      { value: 'codex:gpt-codex', provider: 'codex', id: 'gpt-codex', name: 'Codex' },
    ],
  },
}

function fakeThreads() {
  return Object.assign(new EventEmitter(), {
    threads: new Map(),
    turns: new Map(),
    calls: [],
    removing: new Map(),
    async create(options) {
      const thread = { id: `thread-${this.threads.size + 1}`, title: '新しいタスク', status: 'idle', pendingApproval: false, ...options }
      this.threads.set(thread.id, thread)
      this.turns.set(thread.id, [])
      this.calls.push(['create', options])
      return { ...thread }
    },
    async send(id, { text }, { guard } = {}) {
      guard?.()
      this.calls.push(['send', id, text])
      const thread = this.threads.get(id)
      thread.status = 'running'
      this.turns.get(id).push({ id: `turn-${this.turns.get(id).length + 1}`, user: { text, images: [] }, items: [], status: 'running' })
      return { status: 'accepted' }
    },
    async checkUsageFallbackModel() {},
    async update(id, patch) { Object.assign(this.threads.get(id), patch) },
    async suspendTeamLeader() {},
    async setGoalWaiting() {},
    async steer() { return { steered: false } },
    async cancel() {},
    async get(id) { return { turns: this.turns.get(id) ?? [] } },
    async remove(id) { this.threads.delete(id) },
    pendingPermissions: () => [],
  })
}

function fakeTerminals(holder) {
  const terminals = Object.assign(new EventEmitter(), {
    records: new Map(),
    states: new Map(),
    calls: [],
    async create(options) {
      const id = `terminal-${terminals.records.size + 1}`
      const record = { id, ...options }
      terminals.records.set(id, record)
      terminals.states.set(id, { state: 'running', activity: 'idle', ready: true, inputAt: 0 })
      record.launch = holder.manager?.launchFor({ ...record, team: options.team })
      terminals.calls.push(['create', options, record.launch])
      return { id, workspace: options.workspace, team: options.team, state: 'running', activity: 'idle', ready: true }
    },
    summary(record) { return { id: record.id, workspace: record.workspace, team: record.team, ...terminals.states.get(record.id) } },
    status(id) { return terminals.records.has(id) ? { ...terminals.states.get(id) } : null },
    async conversation() { return { turns: [{ id: 't1', status: 'done', user: { text: '依頼', images: [] }, items: [{ type: 'agent', text: '経過' }] }] } },
    async update(id, patch) { Object.assign(terminals.records.get(id), patch) },
    sendMessage() {},
    stop(id) { Object.assign(terminals.states.get(id), { state: 'exited', activity: 'idle' }); terminals.emit('terminal', terminals.summary(terminals.records.get(id))) },
    async remove(id) { terminals.records.delete(id) },
  })
  return terminals
}

function fakeAgents() {
  const agents = Object.assign(new EventEmitter(), {
    sessions: new Map(),
    calls: [],
    async create(options) {
      const id = `agent-${agents.sessions.size + 1}`
      agents.sessions.set(id, { id, running: false, lastStatus: null, turns: [], ...options })
      agents.calls.push(['create', options])
      return agents.get(id)
    },
    get(id) {
      const session = agents.sessions.get(id)
      return session ? { id, state: session.running ? 'running' : 'idle', lastStatus: session.lastStatus } : null
    },
    turns(id) { return agents.sessions.get(id)?.turns ?? [] },
    running(id) { return Boolean(agents.sessions.get(id)?.running) },
    async setArgs(id, args) {
      agents.sessions.get(id).args = [...args]
      agents.calls.push(['setArgs', id, args])
    },
    async configure(id, patch) { Object.assign(agents.sessions.get(id), patch) },
    run(id, text) {
      const session = agents.sessions.get(id)
      agents.calls.push(['run', id, text, [...(session.args ?? [])]])
      session.running = true
    },
    steer() { return false },
    stop() { return false },
    async remove(id) { agents.sessions.delete(id) },
    finish(id, text) {
      const session = agents.sessions.get(id)
      session.running = false
      session.lastStatus = 'done'
      agents.emit('finished', { id, status: 'done', text, error: null, denials: [] })
    },
  })
  return agents
}

function fakeCodex() {
  return Object.assign(new EventEmitter(), {
    records: new Map(),
    calls: [],
    async create(options) {
      const id = `codex-${this.records.size + 1}`
      const record = { id, ...options }
      this.records.set(id, record)
      this.calls.push(['create', options])
      return { ...record }
    },
    get(id) { return this.records.get(id) ?? null },
    running: () => false,
    run(id, text) { this.calls.push(['run', id, text]) },
    async configure(id, patch) { Object.assign(this.records.get(id), patch) },
    async remove(id) { this.records.delete(id) },
  })
}

const promptFileText = (args) => fsSync.readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')

async function makeTeamEnv(t, { instructions = 'GLOBAL_PERSONALIZE', harness = () => ({ parent: 'PARENT_HARNESS', child: 'CHILD_HARNESS' }), settings = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-personalize-'))
  const workspace = path.join(dir, 'workspace')
  await fs.mkdir(workspace)
  const holder = {}
  const threads = fakeThreads()
  const terminals = fakeTerminals(holder)
  const agents = fakeAgents()
  const codex = fakeCodex()
  const saved = {
    ...structuredClone(TEAM_DEFAULTS),
    claude: { ...structuredClone(TEAM_DEFAULTS.claude), enabled: true },
    gpt: { enabled: true, low: { enabled: true, model: 'gpt-6-luna', effort: 'medium' }, mid: { enabled: true, model: 'gpt-6.1-sol', effort: 'high' } },
    codex: { enabled: true, low: { enabled: true, model: 'gpt-codex', effort: 'medium' }, mid: { enabled: true, model: 'gpt-codex', effort: 'high' } },
    ...settings,
  }
  const manager = await new TeamManager({
    file: path.join(dir, 'teams.json'),
    dir: path.join(dir, 'teams'),
    attachmentsDir: path.join(dir, 'attachments'),
    threads,
    terminals,
    agents,
    codex,
    catalog: CATALOG,
    getSettings: () => saved,
    apiUrl: () => 'http://127.0.0.1:47130/api/team',
    instructions: () => instructions,
    harness,
    gatherMs: 0,
  }).load()
  manager.claudeAuth = { context: () => ({}), guard: async () => null }
  holder.manager = manager
  t.after(async () => {
    await manager.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })
  return { dir, workspace, threads, terminals, agents, codex, manager, saved }
}

test('teamConfig, mergeTeamConfig and restoreTeams default personalizeMode to all and validate values', () => {
  assert.deepEqual(TEAM_PERSONALIZE_MODES, ['off', 'leader', 'all'])
  assert.equal(TEAM_DEFAULTS.personalizeMode, 'all')
  assert.equal(teamConfig({}).personalizeMode, 'all')
  assert.equal(teamConfig({ personalizeMode: 'bogus' }).personalizeMode, 'all')
  for (const mode of TEAM_PERSONALIZE_MODES) {
    assert.equal(mergeTeamConfig({}, { personalizeMode: mode }).personalizeMode, mode)
  }
  assert.throws(() => mergeTeamConfig({}, { personalizeMode: 'children' }), /パーソナライズ/)

  assert.equal(teamPersonalizeEnabled('off', 'leader'), false)
  assert.equal(teamPersonalizeEnabled('off', 'child'), false)
  assert.equal(teamPersonalizeEnabled('off', 'observer'), false)
  assert.equal(teamPersonalizeEnabled('leader', 'leader'), true)
  assert.equal(teamPersonalizeEnabled('leader', 'child'), false)
  assert.equal(teamPersonalizeEnabled('leader', 'observer'), false)
  assert.equal(teamPersonalizeEnabled('all', 'leader'), true)
  assert.equal(teamPersonalizeEnabled('all', 'child'), true)
  assert.equal(teamPersonalizeEnabled('all', 'observer'), true)

  // Legacy saved teams without team.config must stay at 'all', even when global defaults now use 'off'.
  const [legacy] = restoreTeams({ version: 1, teams: [{ id: 't1', leaderId: 'l1', secret: 's', workspace: '/w' }] }, () => ({ ...TEAM_DEFAULTS, personalizeMode: 'off' }))
  assert.equal(legacy.config.personalizeMode, 'all')
})

test('TM personalizeMode applies independently to Claude leader, child, observer and subsequent child turns while preserving harnesses', async (t) => {
  const cases = [
    { mode: 'all', leader: true, child: true, observer: true },
    { mode: 'leader', leader: true, child: false, observer: false },
    { mode: 'off', leader: false, child: false, observer: false },
  ]
  for (const expect of cases) {
    const env = await makeTeamEnv(t)
    const { team } = await env.manager.create({ workspace: env.workspace, choices: { personalizeMode: expect.mode } })
    const raw = env.manager.teams.get(team.id)
    assert.equal(team.config.personalizeMode, expect.mode)

    const leaderLaunch = env.terminals.calls.find(([op]) => op === 'create')[2]
    const leaderPromptText = promptFileText(leaderLaunch.args)
    assert.equal(leaderPromptText.includes('GLOBAL_PERSONALIZE'), expect.leader, `${expect.mode} leader`)
    assert.match(leaderPromptText, /<parent_harness>\nPARENT_HARNESS\n<\/parent_harness>/)

    await env.manager.call(team.id, raw.secret, 'spawn', { name: 'A', title: 'work', task: 'do', provider: 'claude', model: 'haiku' })
    const childCreate = env.agents.calls.find(([op]) => op === 'create')[1]
    const childFirstPrompt = promptFileText(childCreate.args)
    assert.equal(childFirstPrompt.includes('GLOBAL_PERSONALIZE'), expect.child, `${expect.mode} child first turn`)
    assert.match(childFirstPrompt, /<child_harness>\nCHILD_HARNESS\n<\/child_harness>/)

    // Subsequent child turn via leader `send` must keep the same personalization choice.
    const childSessionId = raw.children[0].taskId
    env.agents.finish(childSessionId, 'report 1')
    await tick()
    await env.manager.call(team.id, raw.secret, 'send', { child: 'A', message: 'follow up' })
    const childSecondRun = env.agents.calls.filter(([op, id]) => op === 'run' && id === childSessionId).at(-1)
    assert.equal(promptFileText(childSecondRun[3]).includes('GLOBAL_PERSONALIZE'), expect.child, `${expect.mode} child second turn`)

    // Claude observer
    await env.manager.observerMessage(team.id, { model: 'claude:haiku', effort: null, text: '状態は？' })
    const observerArgs = env.agents.calls.filter(([op]) => op === 'setArgs').at(-1)[2]
    const observerPrompt = promptFileText(observerArgs)
    assert.equal(observerPrompt.includes('GLOBAL_PERSONALIZE'), expect.observer, `${expect.mode} Claude observer`)
  }
})

test('TM personalizeMode governs dsh and Codex roles, cannot be mutated by team.update, survives leader switch, and eco always uses all', async (t) => {
  const env = await makeTeamEnv(t)
  const { team } = await env.manager.create({
    workspace: env.workspace,
    choices: { leaderProvider: 'gpt', personalizeMode: 'leader' },
  })
  const raw = env.manager.teams.get(team.id)

  // dsh leader gets 'on', dsh child gets 'off', dsh observer gets 'off'
  assert.equal(env.threads.teamCustomInstructions(env.threads.threads.get(team.leaderId)), 'on')
  await env.manager.call(team.id, raw.secret, 'spawn', { name: 'D', title: 'dsh', task: 'do', provider: 'gpt', model: 'gpt-6-luna' })
  assert.equal(env.threads.teamCustomInstructions(env.threads.threads.get(raw.children[0].taskId)), 'off')

  await env.manager.call(team.id, raw.secret, 'spawn', { name: 'X', title: 'codex', task: 'do', provider: 'codex', model: 'gpt-codex' })
  assert.equal(env.manager.personalizeFor(env.codex.get(raw.children[1].taskId)), false)

  await env.manager.observerMessage(team.id, { model: '["openai-codex","gpt-6-luna"]', effort: 'low', text: '進捗' })
  assert.equal(env.threads.teamCustomInstructions(env.threads.threads.get(raw.observer.id)), 'off')

  // Normal tasks outside a team return undefined for teamCustomInstructions and true for personalizeFor.
  assert.equal(env.threads.teamCustomInstructions({ id: 'normal', workspace: env.workspace }), undefined)
  assert.equal(env.manager.personalizeFor({ id: 'normal-codex' }), true)

  // updateConfig must ignore personalizeMode (immutable after creation).
  env.manager.updateConfig(team.id, { maxChildren: 4, personalizeMode: 'off' })
  assert.equal(env.manager.summary(raw).config.personalizeMode, 'leader')
  assert.equal(env.manager.summary(raw).config.maxChildren, 4)
  await tick()

  // changeLeader to Claude keeps personalizeMode ('leader' -> Claude leader gets GLOBAL_PERSONALIZE).
  await env.manager.changeLeader(team.id, { model: 'claude:sonnet', effort: null })
  const switchedLaunch = env.terminals.calls.at(-1)[2]
  assert.equal(promptFileText(switchedLaunch.args).includes('GLOBAL_PERSONALIZE'), true)
  assert.equal(env.manager.summary(raw).config.personalizeMode, 'leader')

  // Codex leader with personalizeMode 'off' disables personalization for leader and child.
  const offEnv = await makeTeamEnv(t)
  const { team: offTeam } = await offEnv.manager.create({
    workspace: offEnv.workspace,
    choices: { leaderProvider: 'codex', dshLeader: { provider: 'codex', model: 'gpt-codex', effort: 'medium' }, personalizeMode: 'off' },
  })
  assert.equal(offEnv.manager.personalizeFor(offEnv.codex.get(offTeam.leaderId)), false)
  await offEnv.manager.call(offTeam.id, offEnv.manager.teams.get(offTeam.id).secret, 'spawn', { name: 'C', title: 'cx', task: 't', provider: 'codex', model: 'gpt-codex' })
  assert.equal(offEnv.manager.personalizeFor(offEnv.codex.get(offEnv.manager.teams.get(offTeam.id).children[0].taskId)), false)

  // eco forces personalizeMode: 'all' even if saved settings and choices say 'off', and team.create RPC preserves TM settings without leaking eco override.
  const ecoEnv = await makeTeamEnv(t, { settings: { personalizeMode: 'off' } })
  const { team: ecoTeam } = await ecoEnv.manager.create({
    workspace: ecoEnv.workspace,
    choices: { personalizeMode: 'off' },
    execution: { planImplement: false },
  })
  assert.equal(ecoTeam.config.personalizeMode, 'all')
  assert.equal(ecoEnv.manager.personalizeFor({ team: { id: ecoTeam.id, childId: 'c1' } }), true)

  const persisted = { workspaces: [], agentTeams: structuredClone(TEAM_DEFAULTS) }
  const handlers = createTerminalHandlers({
    paths: { myPc: env.workspace },
    teams: env.manager,
    mutateSettings: async (fn) => fn(persisted),
  })
  await handlers['team.create']({ workspace: env.workspace, choices: { personalizeMode: 'off' } })
  assert.equal(persisted.agentTeams.personalizeMode, 'off')
})

test('ptc-bridge toggles scoped custom-instructions override, isolates errors and validates inputs', async () => {
  const registered = []
  const disposed = []
  const record = {
    assertActive() {},
    agent: {
      status: 'idle',
      ctx: {
        systemPrompt: {
          getSectionOrder: (name) => ({ DEPLOYMENT_PERSONA_SUFFIX: 10200 })[name],
          section(spec) {
            registered.push(spec)
            return () => { disposed.push(spec.name) }
          },
        },
      },
    },
  }

  assert.equal(hasSessionOption(TOOL_MODE_CONFIG), true)
  assert.equal(hasSessionOption(CUSTOM_INSTRUCTIONS_CONFIG), true)
  assert.equal(hasSessionOption('model'), false)

  const initial = withToolMode(record, [])
  assert.equal(customInstructionsOption(initial).currentValue, 'on')
  assert.doesNotThrow(() => assertPresentationReady(record))

  await setSessionOption(record, CUSTOM_INSTRUCTIONS_CONFIG, 'off')
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0], {
    name: INSTRUCTIONS_SECTION_NAME,
    order: 10300,
    text: '',
    interpolate: false,
  })
  assert.equal(customInstructionsOption(withToolMode(record, [])).currentValue, 'off')

  // Idempotent no-op when already 'off'.
  await setCustomInstructions(record, 'off')
  assert.equal(registered.length, 1)

  // Re-enabling disposes the scoped override.
  await setSessionOption(record, CUSTOM_INSTRUCTIONS_CONFIG, 'on')
  assert.deepEqual(disposed, [INSTRUCTIONS_SECTION_NAME])
  assert.equal(customInstructionsOption(withToolMode(record, [])).currentValue, 'on')

  // Busy & invalid validation.
  record.inflight = {}
  await assert.rejects(setCustomInstructions(record, 'off'), /busy/)
  delete record.inflight
  await assert.rejects(setCustomInstructions(record, 'bogus'), /unknown custom instructions/)

  // Failure leaves state null -> assertPresentationReady fails closed until repaired.
  record.agent.ctx.systemPrompt.section = () => { throw new Error('boom') }
  await assert.rejects(setCustomInstructions(record, 'off'), /boom/)
  assert.throws(() => assertPresentationReady(record), /not ready/)
  await setCustomInstructions(record, 'on')
  assertPresentationReady(record)
})

test('ThreadManager applies CUSTOM_INSTRUCTIONS_CONFIG per team role and fails closed when unconfirmed', async (t) => {
  const f = await threadFixture(t)
  let currentMode = 'on'
  const setCalls = []
  f.runtime.newSession = async () => {
    currentMode = 'on'
    const sessionId = `s-${++f.calls.sessions}`
    f.runtime.liveSessions.add(sessionId)
    return {
      sessionId,
      configOptions: [
        { id: 'model', currentValue: '["test","model"]' },
        { id: TOOL_MODE_CONFIG, currentValue: 'native' },
        { id: CUSTOM_INSTRUCTIONS_CONFIG, currentValue: currentMode },
      ],
    }
  }
  f.runtime.resumeSession = async (sessionId) => {
    currentMode = 'on'
    f.runtime.liveSessions.add(sessionId)
    return {
      configOptions: [
        { id: 'model', currentValue: '["test","model"]' },
        { id: TOOL_MODE_CONFIG, currentValue: 'native' },
        { id: CUSTOM_INSTRUCTIONS_CONFIG, currentValue: currentMode },
      ],
    }
  }
  f.runtime.setOption = async (_sessionId, id, value) => {
    setCalls.push([id, value])
    if (id === CUSTOM_INSTRUCTIONS_CONFIG) currentMode = value
    return [
      { id: 'model', currentValue: '["test","model"]' },
      { id: TOOL_MODE_CONFIG, currentValue: 'native' },
      { id: CUSTOM_INSTRUCTIONS_CONFIG, currentValue: currentMode },
    ]
  }
  f.finish.resolve()

  let desired = 'off'
  f.manager.teamCustomInstructions = (thread) => (thread.team ? desired : undefined)
  const child = await f.manager.create({ workspace: f.base, model: '["test","model"]', toolMode: 'native', team: { id: 'T1', childId: 'C1' } })

  const send = async (id, text) => {
    const done = new Promise((resolve) => f.manager.once('turn-finished', resolve))
    await f.manager.send(id, { text })
    return done
  }

  // First turn applies 'off'.
  assert.equal((await send(child.id, 'first')).status, 'done')
  assert.deepEqual(setCalls, [[CUSTOM_INSTRUCTIONS_CONFIG, 'off']])

  // Second turn on live session sees currentValue === 'off' and avoids redundant setOption.
  assert.equal((await send(child.id, 'second')).status, 'done')
  assert.deepEqual(setCalls, [[CUSTOM_INSTRUCTIONS_CONFIG, 'off']])

  // After runtime restart (resumeSession returns default 'on'), 'off' is re-applied.
  f.runtime.liveSessions.clear()
  f.manager.liveOptions.clear()
  assert.equal((await send(child.id, 'after restart')).status, 'done')
  assert.deepEqual(setCalls, [[CUSTOM_INSTRUCTIONS_CONFIG, 'off'], [CUSTOM_INSTRUCTIONS_CONFIG, 'off']])

  // Fail closed when option is missing, mismatched, or rejected by setOption.
  for (const mode of ['missing', 'wrong', 'error']) {
    const failing = await f.manager.create({ workspace: f.base, model: '["test","model"]', toolMode: 'native', team: { id: 'T2', childId: 'C2' } })
    const promptsBefore = f.calls.prompts.length
    f.runtime.setOption = async () => {
      if (mode === 'error') throw new Error('unsupported option')
      return mode === 'missing' ? [] : [{ id: CUSTOM_INSTRUCTIONS_CONFIG, currentValue: 'on' }]
    }
    const result = await send(failing.id, 'must fail')
    assert.equal(result.status, 'error')
    assert.equal(f.calls.prompts.length, promptsBefore)
  }
  assert.throws(() => assertCustomInstructionsMode('nope'), /パーソナライズ/)
  assert.throws(() => assertCustomInstructionsApplied([], 'off'), /パーソナライズ/)
})

test('CodexRunner omits global instructions when callback returns empty for a team record while keeping childPrompt', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-personalize-'))
  const calls = []
  const server = Object.assign(new EventEmitter(), {
    async use(fn) { return fn() },
    async stop() {},
    async rawRequest(method, params) {
      calls.push({ method, params })
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'a@example.test' } }
      if (method === 'model/list') return { data: [{ model: 'gpt-test', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
      if (method === 'thread/start') return { thread: { id: `th-${calls.length}` }, reasoningEffort: 'low' }
      if (method === 'turn/start') {
        queueMicrotask(() => server.emit('notification', 'turn/completed', { threadId: params.threadId, turn: { id: 'turn-1', status: 'completed', items: [] } }))
        return { turn: { id: 'turn-1' } }
      }
      return {}
    },
  })
  const runner = await new CodexRunner({
    home: dir,
    attachmentsDir: dir,
    server,
    instructions: (record) => (record.team?.childId === 'muted' ? '' : effectiveCustomInstructions({
      customInstructionItems: [{ id: '1', title: 't', body: 'GLOBAL_CODEX', enabled: true, targets: { dsh: true, claude: true } }],
    }, 'dsh')),
  }).load()
  t.after(async () => { await runner.shutdown(); await fs.rm(dir, { recursive: true, force: true }) })

  const muted = await runner.create({ workspace: dir, instructions: 'CHILD_PROMPT', team: { id: 't', childId: 'muted' } })
  const active = await runner.create({ workspace: dir, instructions: 'CHILD_PROMPT', team: { id: 't', childId: 'active' } })
  for (const task of [muted, active]) {
    const done = new Promise((resolve) => runner.once('finished', resolve))
    runner.run(task.id, 'go')
    await done
  }
  const starts = calls.filter((c) => c.method === 'thread/start').map((c) => c.params.developerInstructions)
  assert.equal(starts[0], 'CHILD_PROMPT')
  assert.equal(starts[1], 'GLOBAL_CODEX\n\nCHILD_PROMPT')
})

test('TeamStartDialog compact slider initializes, updates via click and keyboard, and TeamConfigDialog shows read-only status', async () => {
  const source = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  })
  const jsx = (type, props) => ({ type, props })
  const expand = (node) => {
    if (!node || typeof node !== 'object') return []
    const rendered = typeof node.type === 'function' && node.type.name === 'TeamPersonalizeSlider' ? node.type(node.props) : node
    return [rendered, ...[rendered.props?.children].flat(Infinity).flatMap(expand)]
  }
  const slots = []
  let cursor = 0
  const started = []
  const updates = []
  const stub = new Proxy({}, { get: (_t, prop) => () => null })
  const server = {
    app: { myPc: '/pc' },
    threads: [],
    terminals: [],
    codexModels: [],
    accounts: { chatgpt: { signedIn: true }, claude: { configured: false }, deepseek: { configured: false }, opencodeGo: { configured: false }, commandCode: { configured: false }, localLlm: { configured: false } },
    catalog: { providers: {}, models: [], effortsByModel: {}, fallbackEfforts: [] },
    settings: {
      projectNames: {},
      modelVisibility: {},
      agentTeams: teamConfig({ personalizeMode: 'leader', gpt: { enabled: true } }),
    },
  }
  const dependencies = {
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
        return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
      },
      useEffect() {},
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': stub,
    '../store': {
      useStore: (select) => select({ server }),
      setState() {},
      request: async () => ({}),
      act: async (name, args) => { updates.push({ name, args }); return true },
      startTeam: async (workspace, draft) => { started.push({ workspace, draft }); return true },
    },
    '../model-selection': modelSelection,
    '../util': { workspaceLabel: (w) => w, parseModel: () => null, pickableEfforts: () => [], effortLabel: (v) => v },
    './Modal': { Modal: ({ children }) => children },
    './Pickers': { byNewest: () => 0 },
    './TerminalPickers': { claudeEfforts: () => [], claudeModelName: () => null, claudeModels: () => [] },
    './ClaudeAuthConsent': { ClaudeAuthConsent: () => null },
    './TeamHarness': { TeamHarness: () => null },
    './ModeSections': stub,
    './PtcToggle': { PtcToggle: () => null },
    './FallbackSummary': { FallbackSummary: () => null },
    './WorkflowModelField': { ModelField: () => null, modelGroups: () => [] },
    './Popover': stub,
    '../team-auth-consent': { needsClaudeAuth: () => false },
    '../../../shared/workflow-effort.js': { workflowEffortSupported: () => true, workflowLevels: () => [] },
    '../../../shared/usage-fallback.js': { usageFallbackChoice: () => null },
    '../../../shared/team-limits.js': { MAX_CHILDREN_LIMIT: 24, MAX_TEAM_MODELS: 24 },
    '../subagent-routes': { usesClaudeApi: () => false },
  }
  const component = {}
  new Function('require', 'exports', outputText)((name) => dependencies[name] ?? {}, component)

  const renderStart = () => { cursor = 0; return expand(component.TeamStartDialog({ workspace: '/work' })) }
  let tree = renderStart()
  let group = tree.find((n) => n.props?.role === 'radiogroup')
  assert.ok(group)
  let radios = tree.filter((n) => n.props?.role === 'radio')
  assert.deepEqual(radios.map((r) => r.props.children), ['なし', '親のみ', 'すべて'])
  assert.equal(radios[1].props['aria-checked'], true)
  assert.equal(group.props.style['--tri-index'], 1)
  assert.equal(started.length, 0)

  // Click 'なし'
  radios[0].props.onClick()
  tree = renderStart()
  radios = tree.filter((n) => n.props?.role === 'radio')
  assert.equal(radios[0].props['aria-checked'], true)
  assert.equal(started.length, 0)

  // Keyboard ArrowRight -> '親のみ', End -> 'すべて'
  group = tree.find((n) => n.props?.role === 'radiogroup')
  group.props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, currentTarget: { querySelectorAll: () => [] } })
  tree = renderStart()
  assert.equal(tree.filter((n) => n.props?.role === 'radio')[1].props['aria-checked'], true)

  group = tree.find((n) => n.props?.role === 'radiogroup')
  group.props.onKeyDown({ key: 'End', preventDefault() {}, currentTarget: { querySelectorAll: () => [] } })
  tree = renderStart()
  assert.equal(tree.filter((n) => n.props?.role === 'radio')[2].props['aria-checked'], true)

  // Submit TeamStartDialog
  const startButton = tree.find((n) => n.type === 'button' && n.props?.children === '始める')
  await startButton.props.onClick()
  assert.equal(started.length, 1)
  assert.equal(started[0].draft.personalizeMode, 'all')

  // TeamConfigDialog shows read-only personalize label for TM teams and never submits personalizeMode in team.update.
  slots.length = 0
  cursor = 0
  const tmTeam = { id: 'tm', leaderId: 'l', leaderKind: 'thread', children: [], config: teamConfig({ personalizeMode: 'leader', gpt: { enabled: true } }) }
  const tmTree = expand(component.TeamConfigDialog({ team: tmTeam, onClose() {} }))
  assert.equal(tmTree.some((n) => n.props?.role === 'radiogroup'), false)
  assert.ok(tmTree.some((n) => n.props?.children === '開始時に固定'))
  assert.ok(tmTree.some((n) => n.props?.children === '親のみ'))
  await tmTree.find((n) => n.type === 'button' && n.props?.children === '保存').props.onClick()
  assert.equal(updates[0].name, 'team.update')
  assert.equal(Object.hasOwn(updates[0].args.patch, 'personalizeMode'), false)

  // eco omits the read-only personalize row too.
  slots.length = 0
  cursor = 0
  const ecoTeam = { ...tmTeam, execution: { metrics: {} } }
  const ecoTree = expand(component.TeamConfigDialog({ team: ecoTeam, onClose() {} }))
  assert.equal(ecoTree.some((n) => n.props?.children === '開始時に固定'), false)
})
