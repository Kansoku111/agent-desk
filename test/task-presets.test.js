import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { TaskPresets } from '../server/task-presets.js'
import { TeamManager } from '../server/teams.js'
import { parsePresetBrief, parsePresetResult, preparePresetPrompt, matchesPresetPrompt, workerPresetInstructions } from '../server/task-preset-protocol.js'
import { createMcpServerList } from '../server/mcp-servers.js'
import { runtimeKey } from '../server/runtime.js'
import { sourceSnapshot } from '../server/execution.js'
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
  const threads = Object.assign(new EventEmitter(), { threads: new Map(), active: new Map(), restoring: new Set(), calls: [], steers: [], waits: [], turns: new Map(),
    async get(id) { if (!this.threads.has(id)) throw new Error('missing'); return { thread: this.threads.get(id), turns: this.turns.get(id) } },
    async create(input) { const value = { ...input, id: randomUUID(), status: 'idle', sessionId: randomUUID() }; this.threads.set(value.id, value); this.turns.set(value.id, []); return value },
    async send(id, input, context) {
      this.executionGuard?.(this.threads.get(id), context)
      const turn = { id: randomUUID(), user: input, status: 'running', items: [] }
      this.turns.get(id).push(turn); this.threads.get(id).status = 'running'; this.calls.push({ id, input, context }); return { turnId: turn.id }
    },
    async steer(id, input, context) {
      this.executionGuard?.(this.threads.get(id), context)
      this.steers.push({ id, input, context }); return { steered: !this.noSteer }
    },
    async setGoalWaiting(id, waiting) { this.waits.push({ id, waiting }) },
    async cancel(id) { const record = this.threads.get(id); if (record) record.status = 'idle' },
  })
  const parent = await threads.create({ workspace, model: 'A', permissionMode: 'workspace-write', title: '元の相談' })
  const terminal = { id: 'terminal', sessionId: 'S', workspace, title: 'CLI相談', state: 'running', activity: 'idle', background: 0 }
  const terminals = Object.assign(new EventEmitter(), { records: new Map([['terminal', terminal]]), calls: [], turns: [], list: () => [terminal], status: () => ({ ready: true }),
    async conversation() { return { turns: this.turns } }, async sendMessage(id, text, context) { this.executionGuard?.(terminal, context); this.calls.push({ id, text }) }, interrupt() {} })
  const agents = Object.assign(new EventEmitter(), { turns: () => [], live: new Map(), calls: [], steers: [], run(id, text) { this.calls.push({ id, text }) }, steer(id, text) { this.steers.push({ id, text }); return !this.noSteer }, stop() {} })
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

test('review fix uses the explicitly selected DSH permission and opinion stays read-only', async (t) => {
  for (const [reviewMode, expected] of [['fix', 'danger-full-access'], ['opinion', 'read-only']]) {
    await t.test(reviewMode, async (t) => {
      const f = await fixture(t)
      const run = await f.start({ kind: 'review', reviewMode, permissionMode: 'danger-full-access' })
      await f.complete(f.parent.id, brief(run))
      assert.equal(run.permissionMode, expected)
      assert.equal(f.threads.threads.get(run.worker.id).permissionMode, expected)
    })
  }
})

const sourceLimit = () => Object.assign(new Error('検証対象が多すぎます。プロジェクト範囲を絞ってください'), { code: 'SOURCE_SNAPSHOT_LIMIT' })

test('large plain-folder creative delegation prepares the parent and finishes without pretending whole-folder checks ran', async (t) => {
  const f = await fixture(t)
  const readdir = fs.readdir.bind(fs)
  const entries = Array.from({ length: 100001 }, (_, index) => ({ name: 'asset-' + index, isDirectory: () => false }))
  const mocked = t.mock.method(fs, 'readdir', (folder, ...args) => path.resolve(String(folder)) === f.workspace ? Promise.resolve(entries) : readdir(folder, ...args))
  let reads = 0
  f.manager.snapshot = async (...args) => { reads++; return sourceSnapshot(...args) }
  f.manager.checkpoints.snapshot = async () => { throw new Error('whole-folder checkpoint must not be retried') }
  f.manager.verifier.verify = async () => { throw new Error('unselected whole-folder checks must not be retried') }
  try {
    const run = await f.start({ instruction: 'AgentDrawで合意した絵を制作し、完成画像を確認する' })
    assert.equal(run.phase, 'preparing')
    assert.equal(f.threads.calls.length, 1, 'the actual parent still creates the brief')
    assert.ok(run.snapshotUnavailable)
    assert.match(run.warning, /全体.*差分/)
    await f.complete(f.parent.id, brief(run, { brief: 'AgentDrawで合意した絵を制作。編集可能なソースと画像を保存し、画像を見て確認する。' }))
    assert.equal(run.phase, 'running')
    assert.equal(f.threads.threads.get(run.worker.id).workspace, f.workspace, 'do not silently change the workspace')
    assert.match(f.threads.calls.at(-1).input.text, /AgentDraw/)
    assert.match(f.threads.calls.at(-1).input.text, /artwork/)
    await fs.mkdir(path.join(f.workspace, 'out'), { recursive: true })
    await fs.writeFile(path.join(f.workspace, 'out', 'fixture.adraw.json'), JSON.stringify({ fixture: true }))
    await f.complete(run.worker.id, result(run, { summary: '制作物と確認結果の報告' }))
    assert.equal(run.phase, 'completed')
    assert.equal(run.verification.status, 'unverified')
    assert.equal(JSON.parse(await fs.readFile(run.verification.record, 'utf8')).endHash, null)
    assert.equal(run.patch, undefined, 'unavailable is not an empty diff')
    assert.equal(reads, 1, 'do not repeat an unsupported global scan')
    assert.equal(f.threads.calls.filter((call) => call.id === f.parent.id).length, 1, 'completion still never wakes the parent')
    await f.manager.deliver(run.id)
    assert.match(f.threads.calls.at(-1).input.text, /注意:.*全体/s)
    assert.doesNotMatch(f.threads.calls.at(-1).input.text, /資料: 担当開始前/)
  } finally { mocked.mock.restore() }
})

test('recording fallback never bypasses permission errors or selected checks', async (t) => {
  const cases = [
    { name: 'permissions', error: Object.assign(new Error('access denied'), { code: 'EACCES' }), input: {} },
    { name: 'explicit checks', error: sourceLimit(), input: { command: 'node check.cjs' } },
  ]
  for (const item of cases) await t.test(item.name, async (t) => {
    const f = await fixture(t)
    f.manager.snapshot = async () => { throw item.error }
    const run = await f.start(item.input)
    assert.equal(run.phase, 'needs-attention')
    assert.equal(run.snapshotUnavailable, undefined)
    assert.equal(run.worker, undefined)
    assert.equal(f.threads.calls.length, 0)
    await assert.rejects(f.manager.deliver(run.id), /報告|開始/)
    assert.equal(f.threads.calls.length, 0, 'a startup error is not a worker report')
    assert.equal(run.deliveryAttempted, undefined)
  })
})

test('checkpoint budget does not block delegated work, but its missing diff remains explicit', async (t) => {
  for (const when of ['before', 'after']) await t.test(when, async (t) => {
    const f = await fixture(t)
    const snapshot = f.manager.checkpoints.snapshot.bind(f.manager.checkpoints)
    f.manager.checkpoints.snapshot = async (workspace, ref) => {
      if (ref.endsWith('/' + when)) throw Object.assign(new Error('checkpoint budget'), { code: 'CHECKPOINT_SNAPSHOT_LIMIT' })
      return snapshot(workspace, ref)
    }
    const run = await f.start()
    await f.complete(f.parent.id, brief(run))
    assert.equal(run.phase, 'running')
    await fs.writeFile(path.join(f.workspace, 'source.txt'), 'finished')
    await f.complete(run.worker.id, result(run))
    assert.equal(run.phase, 'completed')
    assert.equal(run.snapshotUnavailable, undefined, 'fingerprinting remains enabled when only diff storage is unavailable')
    assert.ok(run.verification.endHash)
    assert.equal(run.patch, undefined)
    assert.match(run.warning, /差分.*省略/)
  })
})

test('checkpoint permission errors are not treated as optional recording budgets', async (t) => {
  const f = await fixture(t)
  f.manager.checkpoints.snapshot = async () => { throw Object.assign(new Error('checkpoint access denied'), { code: 'EACCES' }) }
  const run = await f.start()
  await f.complete(f.parent.id, brief(run))
  assert.equal(run.phase, 'needs-attention')
  assert.equal(run.worker, undefined)
  assert.equal(run.diffUnavailable, undefined)
  assert.match(run.error, /access denied/)
  await assert.rejects(f.manager.deliver(run.id), /報告/)
})

test('an allocated worker with no report cannot forward application-only failure metadata', async (t) => {
  const f = await fixture(t), run = await f.start()
  await f.complete(f.parent.id, brief(run))
  await f.manager.stop(run.id)
  const count = f.threads.calls.length
  assert.ok(run.worker)
  await assert.rejects(f.manager.deliver(run.id), /報告/)
  assert.equal(f.threads.calls.length, count)
})

test('task handoff retains requested creative tools and does not inherit an assistant-only consultation restriction', () => {
  const run = { id: 'R', kind: 'delegate' }
  assert.match(preparePresetPrompt(run), /スキル/)
  assert.match(preparePresetPrompt(run), /既定は実装/)
  assert.match(preparePresetPrompt(run), /利用者自身が相談のみ.*最優先/)
  assert.match(workerPresetInstructions(run), /artwork/)
  assert.match(workerPresetInstructions(run), /Default to implementation.*Explicit user instructions .* take precedence/)
  assert.doesNotMatch(workerPresetInstructions({ id: 'R', kind: 'review' }), /Default to implementation/)
  assert.match(preparePresetPrompt({ id: 'R', kind: 'review' }), /報告や修正方針の相談だけで止める依頼にせず.*利用者自身が指摘の報告のみ.*最優先/)
  assert.match(preparePresetPrompt({ id: 'R', kind: 'review' }), /レビューの対象.*あなたが判断して依頼に明記/)
  assert.match(workerPresetInstructions({ id: 'R', kind: 'review' }), /scope named in the brief.*only if the project has it/)
  assert.match(workerPresetInstructions({ id: 'R', kind: 'review' }), /do not stop to ask whether to fix them\. Explicit user instructions .* take precedence/)
  assert.doesNotMatch(workerPresetInstructions(run), /running implementation worker/)
})

test('review-and-fix asks for evidence and focused verification without affecting opinion or delegation', () => {
  const review = { id: 'R', kind: 'review', reviewMode: 'fix' }
  const prompt = workerPresetInstructions(review)
  assert.match(preparePresetPrompt(review), /発生条件・具体的な影響と根拠/)
  assert.match(prompt, /concern as a hypothesis.*triggering conditions, concrete impact and evidence/)
  assert.match(prompt, /Do not require a dangerous reproduction.*report significant risks/)
  assert.match(prompt, /verify the original issue and related regressions/)
  assert.match(prompt, /unsubstantiated concerns and checks you could not perform as unverified/)
  assert.match(prompt, /stop; do not search indefinitely/)
  assert.match(prompt, /No findings is valid/)
  for (const run of [{ id: 'R', kind: 'review', reviewMode: 'opinion' }, { id: 'D', kind: 'delegate' }]) {
    assert.doesNotMatch(workerPresetInstructions(run), /concern as a hypothesis/)
  }
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

test('preparation asks questions without launching a worker', async (t) => {
  const f = await fixture(t)
  const question = await f.start()
  await f.complete(f.parent.id, brief(question, { status: 'needs_input', brief: '', questions: '仕様を確認してください' }))
  assert.equal(question.error, '仕様を確認してください')
  assert.equal(question.worker, undefined)
})

test('opinion passes the proposed design without asking for edits and runs DSH read-only', async (t) => {
  const f = await fixture(t)
  const run = await f.start({ kind: 'review', harness: 'dsh', reviewMode: 'opinion', expectedModel: 'C', expectedEffort: 'low' })
  assert.equal(run.reviewMode, 'opinion')
  assert.equal(run.permissionMode, 'read-only')
  assert.match(run.preparePrompt, /検討中の案を具体的に渡し/)
  assert.match(run.preparePrompt, /作成・変更や実装をせず/)
  assert.doesNotMatch(run.preparePrompt, /不具合・回帰・要件違反を修正/)
  assert.match(run.preparePrompt, /設計が未決であること自体は質問や起動停止の理由にせず/)
  await f.complete(f.parent.id, brief(run, { brief: '認証設計の案と制約を独立に評価する' }))
  assert.equal(f.threads.threads.get(run.worker.id).permissionMode, 'read-only')
  const prompt = f.threads.calls.at(-1).input.text
  assert.match(prompt, /認証設計の案と制約/)
  assert.match(prompt, /Do not create or modify files/)
  assert.doesNotMatch(prompt, /Fix substantiated in-scope bugs/)
  await f.complete(run.worker.id, '結果ブロックが欠落')
  const retry = f.threads.calls.at(-1).input.text
  assert.match(retry, /ファイルを変更せず/)
  assert.doesNotMatch(retry, /必要な修正・検証/)
  await f.complete(run.worker.id, '設計案への意見: 前提と代替案の具体的な根拠\n\n' + result(run, { summary: '設計案への意見' }))
  assert.equal(run.phase, 'completed')
  const parentCalls = f.threads.calls.filter((call) => call.id === f.parent.id)
  assert.equal(parentCalls.length, 2, 'opinion is automatically returned exactly once')
  assert.match(parentCalls.at(-1).input.text, /前提と代替案の具体的な根拠/)
  assert.doesNotMatch(parentCalls.at(-1).input.text, /```task-preset/)
  assert.match(parentCalls.at(-1).input.text, /明示的な依頼なく実装・修正を始めない/)
  assert.equal(parentCalls.at(-1).context.userInitiated, false, 'automatic delivery does not rearm a parent goal')
  assert.ok(run.deliveredAt)
  await f.manager.deliver(run.id)
  assert.equal(f.threads.calls.filter((call) => call.id === f.parent.id).length, 2)
})

test('review modes and harness choices validate and preserve legacy settings', async (t) => {
  const f = await fixture(t)
  f.config.taskPresets.reviewClaude = { model: 'claude:haiku', effort: 'low' }
  await assert.rejects(f.start({ kind: 'review', harness: 'other' }), /ハーネス/)
  await assert.rejects(f.start({ kind: 'review', harness: 'dsh', reviewMode: 'other' }), /レビュー方法/)
  await assert.rejects(f.start({ kind: 'review', harness: 'dsh', reviewMode: 'opinion', command: 'test' }), /検証コマンド/)
  await assert.rejects(f.start({ kind: 'review', harness: 'claude', reviewMode: 'opinion', expectedModel: 'C' }), /設定が更新/)
  let created
  f.agents.create = async (input) => { created = input; return { id: 'claude-worker' } }
  const run = await f.start({ kind: 'review', harness: 'claude', reviewMode: 'opinion', expectedModel: 'claude:haiku', expectedEffort: 'low' })
  await f.complete(f.parent.id, brief(run, { brief: '設計案への意見を報告' }))
  assert.equal(run.model, 'claude:haiku')
  assert.equal(run.permissionMode, 'danger-full-access')
  assert.ok(created.args.includes('--tools'))
  assert.match(created.args[created.args.indexOf('--tools') + 1], /^Read,Glob,Grep/)
  assert.doesNotMatch(created.args[created.args.indexOf('--tools') + 1], /Bash|Write|Edit/)
})

test('opinion auto-delivery reports a busy parent without repeating or losing the result', async (t) => {
  const f = await fixture(t)
  const run = await f.start({ kind: 'review', harness: 'dsh', reviewMode: 'opinion' })
  await f.complete(f.parent.id, brief(run))
  f.parent.status = 'running'
  await f.complete(run.worker.id, result(run, { summary: '相談結果' }))
  assert.equal(run.phase, 'completed')
  assert.match(run.deliveryError, /自動返送できません/)
  assert.equal(run.deliveredAt, undefined)
  assert.equal(f.threads.calls.filter((call) => call.id === f.parent.id).length, 1)
  f.parent.status = 'idle'
  await f.manager.deliver(run.id)
  assert.ok(run.deliveredAt)
  assert.equal(run.deliveryError, undefined)
  assert.equal(f.threads.calls.filter((call) => call.id === f.parent.id).length, 2)
})

test('opinion automatically returns to a Claude Code parent exactly once', async (t) => {
  const f = await fixture(t)
  const run = await f.start({ source: { kind: 'terminal', id: f.terminal.id }, kind: 'review', harness: 'dsh', reviewMode: 'opinion' })
  f.terminals.turns.push({ id: 'prepared', user: { text: run.preparePrompt }, status: 'done', items: [{ type: 'agent', text: brief(run) }] })
  f.terminals.emit('hook', { terminalId: f.terminal.id, input: { hook_event_name: 'UserPromptSubmit', task_preset_marks: [run.id] } })
  f.terminals.emit('hook', { terminalId: f.terminal.id, input: { hook_event_name: 'Stop' } })
  await Promise.all([...f.manager.pending.values()])
  await f.complete(run.worker.id, result(run, { summary: '別の観点' }))
  assert.equal(f.terminals.calls.length, 2)
  assert.match(f.terminals.calls.at(-1).text, /別の観点/)
  assert.ok(run.deliveredAt)
  await f.manager.deliver(run.id)
  assert.equal(f.terminals.calls.length, 2)
})

test('automatic opinion delivery does not target a replaced parent session', async (t) => {
  const f = await fixture(t)
  const run = await f.start({ kind: 'review', harness: 'dsh', reviewMode: 'opinion' })
  await f.complete(f.parent.id, brief(run))
  f.parent.sessionId = randomUUID()
  await f.complete(run.worker.id, result(run, { summary: '相談結果' }))
  assert.match(run.deliveryError, /元セッションが変更/)
  assert.equal(f.threads.calls.filter((call) => call.id === f.parent.id).length, 1)
  assert.equal(run.deliveryAttempted, undefined)
})

test('uncertain Claude Code automatic delivery is not resent', async (t) => {
  const f = await fixture(t)
  const run = await f.start({ source: { kind: 'terminal', id: f.terminal.id }, kind: 'review', harness: 'dsh', reviewMode: 'opinion' })
  f.terminals.turns.push({ id: 'prepared', user: { text: run.preparePrompt }, status: 'done', items: [{ type: 'agent', text: brief(run) }] })
  f.terminals.emit('hook', { terminalId: f.terminal.id, input: { hook_event_name: 'UserPromptSubmit', task_preset_marks: [run.id] } })
  f.terminals.emit('hook', { terminalId: f.terminal.id, input: { hook_event_name: 'Stop' } })
  await Promise.all([...f.manager.pending.values()])
  let sends = 0
  f.terminals.sendMessage = async () => { sends++; throw new Error('受理状態不明') }
  await f.complete(run.worker.id, result(run))
  assert.match(run.deliveryError, /受理状態不明/)
  assert.equal(sends, 1)
  await assert.rejects(f.manager.deliver(run.id), /送信状態が不明/)
  assert.equal(sends, 1)
})

test('legacy reviewer is retained only for its own harness and explicit choices win', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.start({ kind: 'review', harness: 'claude', reviewMode: 'opinion' }), /担当モデルを選択/)
  f.config.taskPresets.reviewDsh = { model: 'D', effort: 'low' }
  const run = await f.start({ kind: 'review', harness: 'dsh', reviewMode: 'fix', expectedModel: 'D', expectedEffort: 'low' })
  assert.equal(run.model, 'D')
  assert.equal(run.permissionMode, 'workspace-write')
  assert.match(workerPresetInstructions(run), /Fix substantiated in-scope bugs/)
  assert.throws(() => planSettingsUpdate(DEFAULT_SETTINGS, { taskPresets: { reviewDsh: { model: 'claude:haiku' } } }, Date.now()), /ハーネス/)
  assert.throws(() => planSettingsUpdate(DEFAULT_SETTINGS, { taskPresets: { reviewClaude: { model: 'D' } } }, Date.now()), /ハーネス/)
})

test('review in a non-Git folder takes its scope from the parent brief and records the reviewer patch', async (t) => {
  const f = await fixture(t)
  const delegated = await f.start()
  await f.complete(f.parent.id, brief(delegated))
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'bug')
  await f.complete(delegated.worker.id, result(delegated))
  const run = await f.start({ requestId: randomUUID(), kind: 'review' })
  await f.complete(f.parent.id, brief(run, { brief: 'source.txt の直近の修正をレビューし、問題を直す' }))
  assert.equal(run.phase, 'running')
  assert.notEqual(run.worker.id, delegated.worker.id)
  const prompt = f.threads.calls.at(-1).input.text
  assert.match(prompt, /source\.txt の直近の修正をレビュー/)
  assert.doesNotMatch(prompt, /修正と関連確認を完了/)
  assert.equal(run.originalPatch, undefined, 'the app no longer decides or pre-computes the review scope')
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'fixed')
  await f.complete(run.worker.id, result(run))
  assert.equal(run.phase, 'completed')
  assert.match(await fs.readFile(run.patch, 'utf8'), /-bug/)
  assert.match(await fs.readFile(run.patch, 'utf8'), /\+fixed/)
})

test('independent review rejects a model that already worked on the task', async (t) => {
  const f = await fixture(t)
  f.config.taskPresets.review.model = 'A'
  await assert.rejects(f.start({ requestId: randomUUID(), kind: 'review' }), /別のモデル/)
  const delegated = await f.start({ requestId: randomUUID() })
  await f.complete(f.parent.id, brief(delegated))
  await f.complete(delegated.worker.id, result(delegated))
  f.config.taskPresets.review.model = 'B'
  await assert.rejects(f.start({ requestId: randomUUID(), kind: 'review' }), /別のモデル/)
  f.config.taskPresets.review.model = 'C'
  assert.equal((await f.start({ requestId: randomUUID(), kind: 'review' })).phase, 'preparing')
})

test('review needs no whole-folder evidence, so a folder too large to record does not block it', async (t) => {
  const f = await fixture(t)
  f.manager.snapshot = async () => { throw sourceLimit() }
  const run = await f.start({ kind: 'review' })
  assert.equal(run.phase, 'preparing')
  assert.ok(run.snapshotUnavailable)
  assert.equal(f.threads.calls.length, 1)
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

test('a preset can start while an independent ordinary conversation is running', async (t) => {
  const f = await fixture(t)
  const other = await f.threads.create({ workspace: f.workspace, model: 'A', permissionMode: 'workspace-write', title: '別の会話' })
  await f.threads.send(other.id, { text: '別の作業' })
  f.terminal.activity = 'running'
  const run = await f.start()
  assert.equal(run.phase, 'preparing')
  await f.complete(f.parent.id, brief(run))
  assert.equal(run.phase, 'running')
  await f.complete(run.worker.id, result(run))
  assert.equal(run.phase, 'completed')
})

test('an independent ordinary conversation can start during preparation and delegated work', async (t) => {
  const f = await fixture(t)
  const run = await f.start()
  const other = await f.threads.create({ workspace: f.workspace, model: 'A', permissionMode: 'workspace-write', title: '別の会話' })
  await f.threads.send(other.id, { text: '別の相談' })
  assert.doesNotThrow(() => f.manager.guard(f.terminal))
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'parallel work')
  await f.complete(f.parent.id, brief(run))
  assert.equal(run.phase, 'running')
  await f.threads.send(other.id, { text: '続ける' })
  assert.throws(() => f.manager.guard(f.parent), /実行中/)
  assert.throws(() => f.manager.guard(f.threads.threads.get(run.worker.id)), /実行中/)
  await f.complete(run.worker.id, result(run))
  assert.equal(run.phase, 'completed')
})

test('real thread creation accepts the first message during a preset run', async (t) => {
  const f = await threadFixture(t)
  const terminals = Object.assign(new EventEmitter(), { records: new Map(), list: () => [] })
  const agents = Object.assign(new EventEmitter(), { live: new Map() })
  const manager = new TaskPresets({ dir: path.join(f.base, 'presets'), threads: f.manager, terminals, agents, teams: {}, settings: () => ({}), catalog: () => ({}), authorize: async () => {}, validateModel() {} })
  manager.runs.set('writer', { id: 'writer', source: { kind: 'thread', id: f.thread.id }, workspace: f.base, phase: 'running', kind: 'delegate', title: '委託中' })
  f.manager.executionGuard = (record, context) => manager.guard(record, context)
  t.after(async () => { manager.runs.clear(); await manager.shutdown() })
  const created = await f.manager.createWithFirstMessage({
    createId: randomUUID(), payloadHash: 'a'.repeat(64),
    options: { workspace: f.base, model: '["test","model"]', toolMode: 'native' }, message: { text: '新しい会話' },
  })
  await f.started.promise
  assert.notEqual(created.thread.id, f.thread.id)
  assert.equal(f.calls.prompts.length, 1)
  await assert.rejects(f.manager.send(f.thread.id, { text: '親への入力' }), /実行中/)
})

test('other guarded operations and parent sends are blocked; stop prevents late launches', async (t) => {
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

test('unified reviewer settings accept either harness and take precedence for new requests', async (t) => {
  const f = await fixture(t)
  f.config.taskPresets.reviewDsh = { model: 'D', effort: 'low' }
  const update = planSettingsUpdate(f.config, { taskPresets: { reviewSelected: { model: 'C', effort: 'low' } } }, Date.now())
  f.config.taskPresets = update.settings.taskPresets
  await assert.rejects(f.start({ kind: 'review', reviewMode: 'opinion', expectedModel: 'D', expectedEffort: 'low' }), /設定が更新/)
  const run = await f.start({ kind: 'review', reviewMode: 'opinion', expectedModel: 'C', expectedEffort: 'low' })
  assert.equal(run.model, 'C')
  assert.equal(run.permissionMode, 'read-only')
  assert.equal(planSettingsUpdate(update.settings, { taskPresets: { reviewSelected: { model: 'claude:haiku', effort: 'low' } } }, Date.now()).settings.taskPresets.reviewSelected.model, 'claude:haiku')
  assert.throws(() => planSettingsUpdate(update.settings, { taskPresets: { reviewSelected: { model: 42 } } }, Date.now()))
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

test('concurrent resumes never acknowledge a different reply without sending it', async (t) => {
  for (const firstReply of ['', '最初の返信']) await t.test(firstReply || 'continue', async (t) => {
    const f = await fixture(t), run = suspendedClaudeRun(f, 'R')
    let entered, release
    const authorizing = new Promise((resolve) => { entered = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    f.manager.authorize = async () => { entered(); await gate }
    const first = f.manager.resume(run.id, firstReply)
    await authorizing
    const duplicate = f.manager.resume(run.id, firstReply)
    assert.equal(duplicate, first, 'identical concurrent requests share their receipt')
    const rejected = assert.rejects(async () => f.manager.message(run.id, '別の返信'), /再開中/)
    release()
    await Promise.all([first, rejected])
    await Promise.all([...f.manager.pending.values()])
    assert.equal(f.agents.calls.length, 1)
    if (firstReply) assert.equal(f.agents.calls[0].text, firstReply)
    assert.equal(f.manager.resuming.size, 0)
  })
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

test('a conversational reply compares changes with its own start, not an earlier result', async (t) => {
  for (const phase of ['stopped', 'needs-attention', 'completed']) await t.test(phase, async (t) => {
    const f = await fixture(t), run = await f.start()
    await f.complete(f.parent.id, brief(run))
    if (phase === 'stopped') await f.manager.stop(run.id)
    else await f.complete(run.worker.id, result(run, phase === 'needs-attention' ? { status: 'blocked', blocker: '環境の確認が必要' } : {}))
    const previous = structuredClone({ phase: run.phase, error: run.error, report: run.report, result: run.result })
    // Changes before the question are not changes made by its answer.
    await fs.writeFile(path.join(f.workspace, 'source.txt'), 'changed before the reply')
    await f.manager.message(run.id, 'ここまでの状況を教えて')
    await Promise.all([...f.manager.pending.values()])
    const sent = f.threads.calls.length
    await f.complete(run.worker.id, 'ここまでの状況です。作業は再開していません。')
    assert.equal(f.threads.calls.length, sent, 'a conversational answer must not trigger more work')
    assert.deepEqual({ phase: run.phase, error: run.error, report: run.report, result: run.result }, previous)
    assert.equal(run.replying, undefined)
  })
})

test('a missing reply snapshot does not drop the message or reuse an old verified hash', async (t) => {
  const f = await fixture(t), run = await f.start()
  await f.complete(f.parent.id, brief(run))
  await f.complete(run.worker.id, result(run))
  const snapshot = f.manager.snapshot
  f.manager.snapshot = async () => { throw sourceLimit() }
  await f.manager.message(run.id, '状況だけ教えて')
  await Promise.all([...f.manager.pending.values()])
  assert.equal(f.threads.calls.at(-1).input.text, '状況だけ教えて')
  assert.equal(run.phase, 'running')
  assert.equal(run.replying.sourceHash, null)
  f.manager.snapshot = snapshot
  assert.equal(await f.manager.unchanged(run), false, 'an unknown reply baseline is not the old verification baseline')
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

test('the user can interrupt a running worker and reply after it stops, as in an ordinary task', async (t) => {
  const f = await fixture(t)
  const run = await f.start()
  const pending = () => Promise.all([...f.manager.pending.values()])
  await f.complete(f.parent.id, brief(run))
  assert.match(f.threads.calls.at(-1).input.text, /^\[Agent Desk: 委託の指示\]/, 'the app\'s own prompt is marked so the worker view can hide it')
  const sent = f.threads.calls.length
  await f.manager.message(run.id, 'テストも直して')
  assert.deepEqual(f.threads.steers.map((entry) => entry.input.text), ['テストも直して'])
  assert.equal(f.threads.calls.length, sent, 'a running turn is interrupted, not given a second turn')
  assert.equal(f.threads.steers[0].context.presetRunId, run.id)
  f.threads.noSteer = true
  await assert.rejects(f.manager.message(run.id, '届かない'), /割り込めません/)
  f.threads.noSteer = false

  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'fixed')
  await f.complete(run.worker.id, result(run, { summary: '初回の結果' }))
  assert.equal(run.phase, 'completed')
  await f.manager.deliver(run.id)
  const delivered = run.deliveredAt
  const parentCalls = f.threads.calls.filter((call) => call.id === f.parent.id).length

  // A question that changes nothing: the finished result, its report and its delivery stay as they were.
  await f.manager.message(run.id, 'この変更の意図は？')
  await pending()
  assert.equal(run.phase, 'running')
  assert.equal(f.threads.calls.at(-1).input.text, 'この変更の意図は？', 'the user\'s words reach the worker unchanged')
  await f.complete(run.worker.id, '意図は次のとおりです')
  assert.equal(run.phase, 'completed')
  assert.equal(run.result.summary, '初回の結果')
  assert.equal(run.report, result(run, { summary: '初回の結果' }))
  assert.equal(run.deliveredAt, delivered)

  // A reply that fixes more is a new result: verified again and deliverable once more.
  await f.manager.message(run.id, 'もう一箇所直して')
  await pending()
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'fixed again')
  await f.complete(run.worker.id, result(run, { summary: '二回目の結果' }))
  assert.equal(run.phase, 'completed')
  assert.equal(run.result.summary, '二回目の結果')
  assert.equal(run.deliveredAt, undefined)
  assert.equal(f.threads.calls.filter((call) => call.id === f.parent.id).length, parentCalls, 'a reply never prompts the parent')

  // Changed files without a result block are not accepted as conversation.
  await f.manager.message(run.id, 'さらに直して')
  await pending()
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'fixed a third time')
  const turns = f.threads.calls.length
  await f.complete(run.worker.id, '直しました')
  assert.equal(run.phase, 'running')
  assert.equal(f.threads.calls.length, turns + 1)
  assert.match(f.threads.calls.at(-1).input.text, /同じ作業を完了/)
})

test('a message is accepted before the worker exists and not while it is being verified', async (t) => {
  const f = await fixture(t)
  const run = await f.start()
  await assert.rejects(f.manager.message(run.id, '先に送る'), /開始前/)
  for (const text of ['', '   ', 5]) assert.throws(() => f.manager.message(run.id, text), /不正/)
  await f.complete(f.parent.id, brief(run))
  run.phase = 'verifying'
  await assert.rejects(f.manager.message(run.id, '検証中'), /開始前|担当/)
  assert.equal(f.threads.steers.length, 0)
})

test('a Claude Code worker takes an interruption and a reply through its own runner', async (t) => {
  const f = await fixture(t), run = suspendedClaudeRun(f, 'R')
  run.phase = 'completed'
  await f.manager.message(run.id, '図を直して')
  await Promise.all([...f.manager.pending.values()])
  assert.equal(run.phase, 'running')
  assert.deepEqual(f.agents.calls, [{ id: 'worker-R', text: '図を直して' }])
  await f.manager.message(run.id, 'いまの作業に追加')
  assert.deepEqual(f.agents.steers, [{ id: 'worker-R', text: 'いまの作業に追加' }])
  f.agents.noSteer = true
  await assert.rejects(f.manager.message(run.id, '届かない'), /割り込めません/)
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
