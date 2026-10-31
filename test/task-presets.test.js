import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { TaskPresets } from '../server/task-presets.js'
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
  const agents = Object.assign(new EventEmitter(), { turns: () => [], live: new Map() })
  const teams = { teams: new Map(), teamLedBy: () => null, execution: { checks: () => [] }, guardExecution(record, context) { this.presetGuard?.(record, context) } }
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
  return { root, workspace, parent, threads, terminals, terminal, manager, source, start, complete, config, options }
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
