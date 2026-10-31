import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { TaskPresets } from '../server/task-presets.js'
import { TeamManager } from '../server/teams.js'
import { parsePresetBrief, parsePresetResult, preparePresetPrompt, matchesPresetPrompt } from '../server/task-preset-protocol.js'
import { gitPresetReview } from '../server/task-preset-evidence.js'
import { createMcpServerList } from '../server/mcp-servers.js'
import { runtimeKey } from '../server/runtime.js'
import { fixture as threadFixture } from './helpers/thread-manager.js'
import { writeTaskPresetPatch } from '../server/dsh-config.js'
import YAML from 'yaml'
import { DEFAULT_SETTINGS, planSettingsUpdate } from '../server/settings.js'
const fence = String.fromCharCode(96).repeat(3)
const block = (value) => fence + 'task-preset\n' + JSON.stringify(value) + '\n' + fence
const brief = (run, extra = {}) => block({ version: 1, requestId: run.id, kind: run.kind, status: 'ready', brief: '目的: バグ修正。対象 source.txt。既存変更を保持。検証する。', questions: '', ...extra })
const result = (run, extra = {}) => block({ version: 1, requestId: run.id, status: 'complete', summary: '修正と関連確認を完了', remaining: '', blocker: '', ...extra })
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-presets-'))
  const workspace = path.join(root, 'project')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'source.txt'), 'before')
  const threads = Object.assign(new EventEmitter(), { threads: new Map(), active: new Map(), restoring: new Set(), calls: [], waits: [], turns: new Map(),
    async get(id) { if (!this.threads.has(id)) throw new Error('missing'); return { thread: this.threads.get(id), turns: this.turns.get(id) } },
    async create(input) { const value = { ...input, id: randomUUID(), status: 'idle', sessionId: randomUUID() }; this.threads.set(value.id, value); this.turns.set(value.id, []); return value },
    async send(id, input, context) {
      this.executionGuard?.(this.threads.get(id), context)
      const turn = { id: randomUUID(), user: input, status: 'running', items: [] }
      this.turns.get(id).push(turn); this.threads.get(id).status = 'running'; this.calls.push({ id, input, context }); return { turnId: turn.id }
    },
    async setGoalWaiting(id, waiting) { this.waits.push({ id, waiting }) },
    async cancel(id) { const record = this.threads.get(id); if (record) record.status = 'idle' },
  })
  const parent = await threads.create({ workspace, model: 'A', permissionMode: 'workspace-write', title: '元の相談' })
  const terminal = { id: 'terminal', sessionId: 'S', workspace, title: 'CLI相談', state: 'running', activity: 'idle', background: 0 }
  const terminals = Object.assign(new EventEmitter(), { records: new Map([['terminal', terminal]]), calls: [], turns: [], list: () => [terminal], status: () => ({ ready: true }),
    async conversation() { return { turns: this.turns } }, async sendMessage(id, text, context) { this.executionGuard?.(terminal, context); this.calls.push({ id, text }) }, interrupt() {} })
  const agents = Object.assign(new EventEmitter(), { turns: () => [], live: new Map(), calls: [], run(id, text) { this.calls.push({ id, text }) }, stop() {} })
  const teams = { teams: new Map(), list() { return [...this.teams.values()] }, teamLedBy: () => null, execution: { checks: () => [] }, guardExecution(record, context) { this.presetGuard?.(record, context) } }
  const config = { taskPresets: { delegate: { model: 'B', effort: 'low' }, review: { model: 'C', effort: 'low' } } }
  const options = { dir: path.join(root, 'state'), threads, terminals, agents, teams, settings: () => config, catalog: () => ({}), validateModel() {}, authorize: async () => {} }
  const manager = await new TaskPresets(options).load()
  threads.executionGuard = terminals.executionGuard = (record, context) => teams.guardExecution(record, context)
  teams.presetGuard = (record, context) => manager.guard(record, context)
  const source = { kind: 'thread', id: parent.id }
  const input = { requestId: randomUUID(), source, kind: 'delegate' }
  const start = async (extra = {}) => { const { run } = await manager.create({ ...input, ...extra }); return manager.require(run.id) }
  const complete = async (id, output, status = 'done') => {
    const turn = threads.turns.get(id).at(-1); Object.assign(turn, { status, items: [{ type: 'agent', text: output }] }); threads.threads.get(id).status = 'idle'; threads.emit('turn-finished', { threadId: id, status })
    await Promise.all([...manager.pending.values()])
  }
  t.after(async () => { await manager.shutdown(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, workspace, parent, threads, terminals, terminal, agents, teams, manager, source, start, complete, config, options }
}

test('one-shot envelopes reject wrong run, ambiguous blocks, extra fields and invalid completion', () => {
  const run = { id: 'R', kind: 'review' }
  assert.equal(parsePresetBrief(brief(run), run).status, 'ready')
  for (const output of [brief({ ...run, id: 'old' }), brief(run) + brief(run), brief(run, { model: 'secret-route' }), 'tool output']) assert.throws(() => parsePresetBrief(output, run))
  assert.equal(parsePresetResult(result(run, { remaining: '未修正' }), run).status, 'continue')
  assert.throws(() => parsePresetResult(result(run, { status: 'blocked' }), run))
  assert.match(preparePresetPrompt(run), /推論.*完了宣言/)
  const wrapped = '<pasted_content id="123a">\n' + preparePresetPrompt(run) + '\n</pasted_content id="123a">'
  assert.ok(matchesPresetPrompt(wrapped, preparePresetPrompt(run)))
  assert.equal(matchesPresetPrompt('extra instructions\n' + wrapped, preparePresetPrompt(run)), false)
  assert.equal(matchesPresetPrompt(wrapped.replace('id="123a">', 'id="different">'), preparePresetPrompt(run)), false)
})

test('delegate completes one-way; only explicit delivery sends a parent prompt, once', async (t) => {
  const f = await fixture(t)
  const run = await f.start()
  assert.equal(f.threads.calls.length, 1)
  await f.complete(f.parent.id, brief(run))
  assert.equal(run.phase, 'running')
  assert.equal(f.threads.calls.length, 2)
  assert.equal(f.threads.threads.get(run.worker.id).preset.runId, run.id)
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'implemented')
  await f.complete(run.worker.id, result(run))
  assert.equal(run.phase, 'completed')
  assert.equal(run.verification.status, 'unverified')
  assert.equal(f.threads.calls.length, 2, 'no automatic report delivery')
  assert.equal(f.manager.goalWaiting(f.parent), true, 'completion must not rearm parent goal')
  assert.match(await fs.readFile(run.patch, 'utf8'), /implemented/)
  assert.match((await f.manager.readEvidence(run.id, 'patch')).text, /implemented/)
  await assert.rejects(f.manager.readEvidence(run.id, '../state.json'))
  await assert.rejects(f.manager.readEvidence(run.id, 'check', -1))
  await Promise.all([f.manager.deliver(run.id), f.manager.deliver(run.id)])
  assert.equal(f.threads.calls.length, 3)
  await f.manager.deliver(run.id)
  assert.equal(f.threads.calls.length, 3)
  assert.equal(f.threads.calls.at(-1).context.userInitiated, true)
  assert.match(f.threads.calls.at(-1).input.messageId, /^[a-f0-9-]{36}$/)
  f.manager.userAccepted(f.parent.id)
  assert.equal(f.manager.goalWaiting(f.parent), false)
})

test('creation is idempotent, mismatched resend fails, malformed/interrupted parent never starts worker', async (t) => {
  const f = await fixture(t)
  const requestId = randomUUID()
  const run = await f.start({ requestId })
  assert.equal((await f.start({ requestId })).id, run.id)
  await assert.rejects(f.start({ requestId, instruction: 'different' }))
  await f.complete(f.parent.id, brief({ ...run, id: 'unrelated' }))
  assert.equal(run.phase, 'needs-attention')
  assert.equal(run.worker, undefined)
  const next = await f.start({ requestId: randomUUID() })
  await f.complete(f.parent.id, brief(next), 'cancelled')
  assert.equal(next.worker, undefined)
})

test('a stale displayed model or effort never routes a newly started run to a different selection', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.start({ expectedModel: 'old-model' }), /設定が更新/)
  await assert.rejects(f.start({ expectedModel: 'B', expectedEffort: 'high' }), /設定が更新/)
  assert.equal(f.threads.calls.length, 0)
  assert.equal(f.manager.runs.size, 0)
})

test('preparation refuses changed sources and asks questions without launching a worker', async (t) => {
  const f = await fixture(t)
  const run = await f.start()
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'parent unexpectedly edited')
  await f.complete(f.parent.id, brief(run))
  assert.equal(run.phase, 'needs-attention')
  assert.equal(run.worker, undefined)
  const question = await f.start({ requestId: randomUUID() })
  await f.complete(f.parent.id, brief(question, { status: 'needs_input', brief: '', questions: '仕様を確認してください' }))
  assert.equal(question.error, '仕様を確認してください')
  assert.equal(question.worker, undefined)
})

test('review fixes actual changes in a fresh worker and records original versus reviewer patch', async (t) => {
  const f = await fixture(t)
  const delegated = await f.start()
  await f.complete(f.parent.id, brief(delegated))
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'bug')
  await f.complete(delegated.worker.id, result(delegated))
  const run = await f.start({ requestId: randomUUID(), kind: 'review', review: { base: 'run:' + delegated.id } })
  await f.complete(f.parent.id, brief(run))
  assert.equal(run.phase, 'running')
  assert.notEqual(run.worker.id, delegated.worker.id)
  assert.match(await fs.readFile(run.originalPatch, 'utf8'), /bug/)
  assert.doesNotMatch(f.threads.calls.at(-1).input.text, /修正と関連確認を完了/)
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'fixed')
  await f.complete(run.worker.id, result(run))
  assert.equal(run.phase, 'completed')
  assert.match(await fs.readFile(run.patch, 'utf8'), /-bug/)
  assert.match(await fs.readFile(run.patch, 'utf8'), /\+fixed/)
})

test('report-only findings continue in the same worker; repeated lack of progress is not completion', async (t) => {
  const f = await fixture(t)
  const run = await f.start()
  await f.complete(f.parent.id, brief(run))
  const worker = run.worker.id
  await f.complete(worker, result(run, { status: 'continue', remaining: 'バグを発見、修正が必要' }))
  assert.equal(run.phase, 'running')
  assert.equal(run.worker.id, worker)
  await f.complete(worker, result(run, { status: 'continue', remaining: 'まだ未修正' }))
  assert.equal(run.phase, 'needs-attention')
  assert.match(run.error, /進捗/)
})

test('overlapping writers and parent sends are blocked in both directions; stop prevents late launches', async (t) => {
  const f = await fixture(t)
  const run = await f.start()
  assert.throws(() => f.manager.guard(f.parent), /実行中/)
  assert.throws(() => f.manager.guard({ ...f.parent, permissionMode: 'read-only' }), /実行中/)
  assert.throws(() => f.manager.guard({ workspace: path.dirname(f.workspace) }), /実行中/)
  assert.throws(() => f.manager.guard({ workspace: path.join(f.workspace, 'child') }), /実行中/)
  assert.doesNotThrow(() => f.manager.guard({ workspace: f.workspace, permissionMode: 'read-only' }))
  await f.manager.stop(run.id)
  await f.complete(f.parent.id, brief(run))
  assert.equal(run.phase, 'stopped')
  assert.equal(run.worker, undefined)
})

test('terminal handoff needs matching submission AND the corresponding final transcript, not Stop text', async (t) => {
  const f = await fixture(t)
  const run = await f.start({ source: { kind: 'terminal', id: 'terminal' } })
  f.terminals.turns.push({ id: 'new', user: { text: run.preparePrompt }, status: 'done', items: [{ type: 'agent', text: brief(run) }] })
  f.terminals.emit('hook', { terminalId: 'terminal', input: { hook_event_name: 'UserPromptSubmit', task_preset_marks: [run.id] } })
  f.terminals.emit('hook', { terminalId: 'terminal', input: { hook_event_name: 'Stop', last_assistant_message: 'untrusted hook text' } })
  await Promise.all([...f.manager.pending.values()])
  assert.equal(run.phase, 'running')
  assert.equal(f.terminals.calls.length, 1)
  await f.complete(run.worker.id, result(run))
  assert.equal(f.terminals.calls.length, 1)
})

test('interrupted runs restore as attention without replaying any model calls', async (t) => {
  const f = await fixture(t)
  const run = await f.start()
  const restored = await new TaskPresets(f.options).load()
  assert.equal(restored.require(run.id).phase, 'needs-attention')
  assert.equal(f.threads.calls.length, 1)
  assert.equal(restored.goalWaiting(f.parent), true)
})

test('preset settings have no runtime restart effect; dedicated workers mount no default MCP', () => {
  const { settings, effects } = planSettingsUpdate(DEFAULT_SETTINGS, { taskPresets: { delegate: { model: 'B', effort: 'low' } } }, Date.now())
  assert.equal(settings.taskPresets.delegate.model, 'B')
  assert.equal(settings.taskPresets.review.model, null)
  assert.equal(effects.homePatch, false)
  assert.equal(effects.restart, false)
  assert.throws(() => planSettingsUpdate(DEFAULT_SETTINGS, { taskPresets: { review: { model: 4 } } }, Date.now()))
  const servers = createMcpServerList({ paths: {}, getSettings: () => ({ browserTool: true, imageTool: true }), getTeams: () => null })
  assert.deepEqual(servers({ preset: {}, workspace: '.' }), [])
  assert.equal(servers({ preset: { browser: true }, workspace: '.' }).length, 1)
  assert.equal(runtimeKey({ preset: {}, permissionMode: 'workspace-write' }), 'preset:workspace-write')
})

test('Git review includes committed, staged, unstaged and untracked changes without touching index/HEAD', async (t) => {
  const f = await fixture(t)
  const git = (...args) => execFileSync('git', args, { cwd: f.workspace, encoding: 'utf8' })
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD').trim()
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'committed change')
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'implementation')
  await fs.writeFile(path.join(f.workspace, 'new file.txt'), 'untracked')
  const head = git('rev-parse', 'HEAD'), index = git('diff', '--cached')
  const evidence = await gitPresetReview(f.workspace, base)
  assert.match(evidence.patch, /committed change/)
  assert.match(evidence.patch, /untracked/)
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('diff', '--cached'), index)
  await assert.rejects(gitPresetReview(f.workspace, '--output=other'))
})

test('registered verification failure returns to the same worker until repaired', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.workspace, 'check.cjs'), 'if (require("fs").readFileSync("source.txt", "utf8") !== "fixed") process.exit(1)')
  const run = await f.start({ command: 'node check.cjs' })
  await f.complete(f.parent.id, brief(run))
  const worker = run.worker.id
  await f.complete(worker, result(run))
  assert.equal(run.phase, 'running')
  assert.equal(run.worker.id, worker)
  assert.equal(run.verification.status, 'failed')
  assert.match(f.threads.calls.at(-1).input.text, /検証が失敗/)
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'fixed')
  await f.complete(worker, result(run))
  assert.equal(run.phase, 'completed')
  assert.equal(run.verification.status, 'passed')
})

test('explicit app-verification handoff completes without pretending the worker ran restricted checks', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.workspace, 'check.cjs'), 'if (require("fs").readFileSync("source.txt", "utf8") !== "fixed") process.exit(1)')
  const run = await f.start({ command: 'node check.cjs' })
  await f.complete(f.parent.id, brief(run))
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'fixed')
  await f.complete(run.worker.id, result(run, { status: 'verify', remaining: '登録されたアプリ側の検証待ち' }))
  assert.equal(run.phase, 'completed')
  assert.equal(run.verification.status, 'passed')
  assert.equal(run.result.remaining, '')
  const next = await f.start({ requestId: randomUUID() })
  await f.complete(f.parent.id, brief(next))
  await f.complete(next.worker.id, result(next, { status: 'verify', remaining: '登録されていない検証' }))
  assert.equal(next.phase, 'needs-attention')
})

test('stop during preparation cannot send a late parent prompt', async (t) => {
  const f = await fixture(t)
  let entered, release
  const started = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const snapshot = f.manager.snapshot
  f.manager.snapshot = async (...args) => { entered(); await gate; return snapshot(...args) }
  const starting = f.start()
  await started
  const run = [...f.manager.runs.values()][0]
  await f.manager.stop(run.id)
  release()
  await starting
  assert.equal(run.phase, 'stopped')
  assert.equal(f.threads.calls.length, 0)
})

test('concurrent resumes start only one continuation and keep the original model', async (t) => {
  const f = await fixture(t)
  const run = await f.start()
  await f.complete(f.parent.id, brief(run))
  await f.complete(run.worker.id, result(run, { status: 'blocked', blocker: '環境の確認が必要', remaining: '検証' }))
  assert.equal(run.phase, 'needs-attention')
  const count = f.threads.calls.length
  f.config.taskPresets.delegate.model = 'different'
  await Promise.all([f.manager.resume(run.id), f.manager.resume(run.id)])
  await Promise.all([...f.manager.pending.values()])
  assert.equal(f.threads.calls.length, count + 1)
  assert.equal(run.model, 'B')
})

test('terminal final text alone cannot authorize a worker and exit ends preparation safely', async (t) => {
  const f = await fixture(t)
  const run = await f.start({ source: { kind: 'terminal', id: 'terminal' } })
  f.terminals.turns.push({ id: 'new', user: { text: run.preparePrompt }, status: 'done', items: [{ type: 'agent', text: brief(run) }] })
  f.terminals.emit('hook', { terminalId: 'terminal', input: { hook_event_name: 'Stop' } })
  await Promise.all([...f.manager.pending.values()])
  assert.equal(run.worker, undefined)
  const next = await f.start({ requestId: randomUUID(), source: { kind: 'terminal', id: 'terminal' } })
  f.terminals.emit('terminal', { id: 'terminal', state: 'exited' })
  await Promise.all([...f.manager.pending.values()])
  assert.equal(next.phase, 'needs-attention')
  assert.equal(next.worker, undefined)
})

test('actual ThreadManager immediately denies hidden worker approvals without leaving a pending request', async (t) => {
  const f = await threadFixture(t)
  await f.manager.send(f.thread.id, { text: 'work' })
  await f.started.promise
  const record = f.manager.threads.get(f.thread.id)
  record.preset = { runId: 'R' }
  const answer = await f.manager.onPermission({ sessionId: record.sessionId, toolCall: { toolCallId: 'write', title: 'write' }, options: [{ kind: 'allow_once', optionId: 'yes' }] })
  assert.deepEqual(answer, { outcome: { outcome: 'cancelled' } })
  assert.equal(f.manager.pendingPermissions(f.thread.id).length, 0)
  assert.equal(record.pendingApproval, false)
})

function suspendedClaudeRun(f, id, source = f.source) {
  const run = { id, source, kind: 'delegate', title: id, workspace: f.workspace, model: 'claude:haiku', effort: 'low', phase: 'stopped', cancelled: true, checks: [], report: '', brief: '元の依頼', worker: { kind: 'claude', id: 'worker-' + id } }
  f.manager.runs.set(id, run)
  return run
}

test('read-only task restore and undo remain writes during preset work and verification', async (t) => {
  for (const phase of ['running', 'verifying']) await t.test(phase, async (t) => {
    let restored = 0
    const f = await threadFixture(t, { checkpoints: { async restore() { restored++; return { restored: ['source.txt'], removed: [], undo: 'undo' } } } })
    const terminals = Object.assign(new EventEmitter(), { list: () => [] })
    const agents = Object.assign(new EventEmitter(), { live: new Map() })
    const manager = new TaskPresets({ dir: path.join(f.base, 'presets'), threads: f.manager, terminals, agents, teams: {}, settings: () => ({}), catalog: () => ({}), authorize: async () => {}, validateModel() {} })
    t.after(async () => { manager.runs.clear(); await manager.shutdown() })
    const record = f.manager.threads.get(f.thread.id)
    record.permissionMode = 'read-only'
    const turn = { id: 'earlier-write', status: 'done', user: { text: 'earlier implementation' }, items: [], checkpoint: { before: 'saved', changed: 1 } }
    f.manager.turns.set(record.id, [turn])
    manager.runs.set('writer', { id: 'writer', source: { kind: 'thread', id: 'other-parent' }, workspace: f.base, phase, kind: 'delegate', title: 'active writer' })
    f.manager.executionGuard = (value, context) => manager.guard(value, context)
    assert.doesNotThrow(() => manager.guard(record), 'parallel read-only model work remains allowed')
    await assert.rejects(f.manager.restoreCheckpoint(record.id, turn.id), /実行中/)
    turn.restore = { at: Date.now(), undo: 'undo', turns: 1 }
    await assert.rejects(f.manager.undoRestore(record.id, turn.id), /実行中/)
    assert.equal(restored, 0, 'neither restore path can touch files')
    manager.runs.clear()
    await f.manager.undoRestore(record.id, turn.id)
    assert.equal(restored, 1, 'restore is allowed again when the writer ends')
  })
})

test('ordinary TM admission uses computed child state, including startup and closing Claude workers', async (t) => {
  const f = await fixture(t)
  let state = 'running'
  f.agents.get = () => ({ state })
  f.agents.running = () => state === 'running'
  const teams = new TeamManager({ file: path.join(f.root, 'teams.json'), dir: path.join(f.root, 'teams'), threads: f.threads, terminals: f.terminals, agents: f.agents, catalog: { data: { models: [] } }, getSettings: () => ({}), apiUrl: () => '' })
  teams.presetGuard = (record, context) => f.manager.guard(record, context)
  f.manager.teams = teams
  t.after(async () => { teams.teams.clear(); await teams.stop() })
  const child = { id: 'C', name: 'child', title: 'TM writer', provider: 'claude', model: 'haiku', kind: 'agent', taskId: 'tm-worker', closed: false, awaiting: true, pending: [], followups: [], reports: [] }
  const team = { id: 'TM', workspace: f.workspace, leaderId: f.terminal.id, leaderKind: 'terminal', children: [child], queue: [], asks: [] }
  teams.teams.set(team.id, team)
  assert.equal(child.state, undefined, 'stored children do not carry runtime state')
  assert.equal(teams.summary(team).children[0].state, 'running')
  assert.throws(() => f.manager.room(f.workspace), /チーム/)
  await assert.rejects(f.start(), /チーム/)
  assert.equal(f.threads.calls.length, 0, 'reject before prompting the parent')
  child.closed = true
  assert.throws(() => f.manager.room(f.workspace), /チーム/, 'closing does not make a live writer harmless')
  child.closed = false
  state = 'idle'
  assert.doesNotThrow(() => f.manager.room(f.workspace))
  child.taskId = null
  assert.throws(() => f.manager.room(f.workspace), /チーム/, 'startup is also a writer reservation')
  child.taskId = 'tm-worker'
  teams.approvals.set('ask', { childId: child.id })
  assert.throws(() => f.manager.room(f.workspace), /チーム/)
  teams.approvals.clear()
  teams.retries.set('resume:' + child.id, null)
  assert.equal(teams.summary(team).children[0].state, 'resuming')
  assert.throws(() => f.manager.room(f.workspace), /チーム/)
  teams.retries.clear()
})

test('distinct Claude runs cannot both resume after concurrent authorization in one workspace', async (t) => {
  const f = await fixture(t)
  const other = await f.threads.create({ workspace: f.workspace, model: 'A', permissionMode: 'workspace-write', title: 'other parent' })
  const a = suspendedClaudeRun(f, 'A'), b = suspendedClaudeRun(f, 'B', { kind: 'thread', id: other.id })
  let entered, release, count = 0
  const both = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  f.manager.authorize = async () => { if (++count === 2) entered(); await gate }
  const resuming = Promise.allSettled([f.manager.resume(a.id), f.manager.resume(b.id)])
  await both; release()
  const settled = await resuming
  await Promise.all([...f.manager.pending.values()])
  assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1)
  const rejected = settled.find((entry) => entry.status === 'rejected')
  assert.match(rejected?.reason.message ?? '', /実行中/)
  assert.equal(f.agents.calls.length, 1)
  assert.equal([a, b].filter((run) => run.phase === 'running').length, 1)
  assert.equal([a, b].filter((run) => run.phase === 'stopped').length, 1)
})

test('a newly created run reserves the workspace while another run waits for resume authorization', async (t) => {
  const f = await fixture(t), old = suspendedClaudeRun(f, 'old')
  let entered, release
  const authorizing = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  f.manager.authorize = async ({ model }) => { if (model.startsWith('claude:')) { entered(); await gate } }
  const resumed = f.manager.resume(old.id)
  const denied = assert.rejects(resumed, /実行中|作業・復元中/)
  await authorizing
  const other = await f.threads.create({ workspace: f.workspace, model: 'A', permissionMode: 'workspace-write', title: 'other parent' })
  const fresh = await f.start({ requestId: randomUUID(), source: { kind: 'thread', id: other.id } })
  release(); await denied
  assert.equal(fresh.phase, 'preparing')
  assert.equal(old.phase, 'stopped')
  assert.equal(f.agents.calls.length, 0)
})

test('each resumed result can be delivered once with a new receipt and no automatic parent prompt', async (t) => {
  for (const kind of ['thread', 'terminal']) await t.test(kind, async (t) => {
    const f = await fixture(t)
    const source = kind === 'thread' ? f.source : { kind, id: f.terminal.id }
    const run = await f.start({ source })
    if (kind === 'thread') await f.complete(f.parent.id, brief(run))
    else {
      f.terminals.turns.push({ id: 'prepared', user: { text: run.preparePrompt }, status: 'done', items: [{ type: 'agent', text: brief(run) }] })
      f.terminals.emit('hook', { terminalId: f.terminal.id, input: { hook_event_name: 'UserPromptSubmit', task_preset_marks: [run.id] } })
      f.terminals.emit('hook', { terminalId: f.terminal.id, input: { hook_event_name: 'Stop' } })
      await Promise.all([...f.manager.pending.values()])
    }
    const parentCalls = () => kind === 'thread' ? f.threads.calls.filter((call) => call.id === f.parent.id) : f.terminals.calls
    await f.complete(run.worker.id, result(run, { status: 'blocked', summary: 'old blocked report', remaining: 'verification', blocker: 'environment' }))
    await f.manager.deliver(run.id)
    const oldReceipt = run.deliveryMessageId
    assert.ok(run.deliveredAt)
    if (kind === 'thread') await f.complete(f.parent.id, '報告を確認しました')
    const sent = parentCalls().length
    await f.manager.resume(run.id)
    await Promise.all([...f.manager.pending.values()])
    assert.equal(run.deliveredAt, undefined, 'the resumed attempt has not been delivered')
    await fs.writeFile(path.join(f.workspace, 'source.txt'), 'fixed after resume')
    await f.complete(run.worker.id, result(run, { summary: 'new final result' }))
    assert.equal(run.phase, 'completed')
    assert.equal(parentCalls().length, sent, 'completion still never prompts the parent')
    await Promise.all([f.manager.deliver(run.id), f.manager.deliver(run.id)])
    assert.equal(parentCalls().length, sent + 1)
    assert.notEqual(run.deliveryMessageId, oldReceipt)
    assert.match(parentCalls().at(-1).input?.text ?? parentCalls().at(-1).text, /new final result/)
    await f.manager.deliver(run.id)
    assert.equal(parentCalls().length, sent + 1, 'the same result is not delivered twice')
  })
})

test('resume does not replace delivery state while a previous result is still being sent', async (t) => {
  const f = await fixture(t), run = suspendedClaudeRun(f, 'R')
  Object.assign(run, { deliveredAt: 123, deliveryAttempted: true, deliveryMessageId: randomUUID() })
  const receipt = run.deliveryMessageId
  f.manager.sends.set(run.id, Promise.resolve())
  try {
    await assert.rejects(f.manager.resume(run.id), /送信中/)
    assert.equal(run.phase, 'stopped')
    assert.equal(run.deliveredAt, 123)
    assert.equal(run.deliveryMessageId, receipt)
    assert.equal(f.agents.calls.length, 0)
  } finally { f.manager.sends.delete(run.id) }
})

test('dedicated patch disables inherited delegate definitions while preserving the base persona', async (t) => {
  const f = await fixture(t)
  const file = path.join(f.root, 'preset.yml')
  const persona = { personaPrefix: 'Coding', personaSuffix: 'Workspace {{cwd}}' }
  await writeTaskPresetPatch(file, { subagents: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }], persona })
  const rows = YAML.parse(await fs.readFile(file, 'utf8'))
  assert.ok(rows.some((row) => row.id === 'agent-desk-subagent-claude' && row.disabled))
  assert.deepEqual(rows.find((row) => row.id === 'system-prompt').config, persona)
  const policy = rows.find((row) => row.insert)?.insert[0]
  assert.equal(policy.id, 'agent-desk-task-preset-policy')
  assert.match(policy.name, /task-preset-policy-plugin/)
})
