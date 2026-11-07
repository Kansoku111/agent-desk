import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TaskPresets } from '../server/task-presets.js'
import { CodexRunner } from '../server/codex-runner.js'

const block = (value) => ['```task-preset', JSON.stringify(value), '```'].join(String.fromCharCode(10))
const brief = run => block({ version: 1, requestId: run.id, kind: run.kind, status: 'ready', brief: '要求と確認', questions: '' })
const result = run => block({ version: 1, requestId: run.id, status: 'complete', summary: '確認結果', remaining: '', blocker: '' })

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-gp-'))
  const threads = Object.assign(new EventEmitter(), { threads: new Map(), active: new Map(), restoring: new Set(), turns: new Map(), calls: [],
    async get(id) { return { thread: this.threads.get(id), turns: this.turns.get(id) } },
    async create(input) { const record = { ...input, id: randomUUID(), status: 'idle' }; this.threads.set(record.id, record); this.turns.set(record.id, []); return record },
    async send(id, input, context) { this.executionGuard?.(this.threads.get(id), context); this.calls.push({ id, input, context }); this.turns.get(id).push({ id: randomUUID(), user: input, status: 'running', items: [] }); return {} },
    async cancel() {}, async setGoalWaiting() {},
  })
  const terminals = Object.assign(new EventEmitter(), { records: new Map(), list: () => [] })
  const codex = Object.assign(new EventEmitter(), { records: new Map(), configuring: new Set(), calls: [],
    get(id) { const record = this.records.get(id); return record && { ...record } },
    turns(id) { return this.records.get(id)?.turns },
    run(id, text, context = {}) { const record = this.records.get(id); if (record.state !== 'idle') throw new Error('作業中です'); this.executionGuard?.(record, context)
      const turn = { id: randomUUID(), status: 'running', user: { text }, items: [] }; record.turns.push(turn); record.state = 'running'; this.calls.push({ id, text, context }); return record },
    async waitForStart() { if (this.failReceipt) throw new Error('送信状態不明'); return 'accepted' },
    async stop(id) { this.records.get(id).state = 'idle' },
    async finish(id, text, status = 'done', denials = []) { const record = this.records.get(id); const turn = record.turns.at(-1); turn.status = status; turn.items = [{ type: 'agent', text }]; record.state = 'idle'; this.emit('finished', { id, status, denials }) },
  })
  const parent = { id: 'gp', workspace: root, title: 'GP親', model: 'gpt-6-luna', sessionId: 'session', state: 'idle', turns: [] }
  codex.records.set(parent.id, parent)
  const teams = { teamLedBy: () => null, list: () => [], execution: { checks: () => [] }, guardExecution(record, context) { this.presetGuard?.(record, context) } }
  const agents = Object.assign(new EventEmitter(), { live: new Map(), turns: () => [], stop() {} })
  const config = { taskPresets: { delegate: { model: 'B', effort: 'low' }, reviewSelected: { model: 'C', effort: 'low' } } }
  const manager = await new TaskPresets({ dir: path.join(root, 'state'), threads, terminals, codex, agents, teams, settings: () => config,
    catalog: () => ({}), validateModel() {}, authorize: async () => {}, snapshot: async () => ({ hash: 'hash' }) }).load()
  manager.captureCheckpoint = async () => null
  manager.verifier.verify = async () => ({ status: 'unverified', checks: [], endHash: 'hash' })
  teams.presetGuard = (record, context) => manager.guard(record, context)
  codex.executionGuard = threads.executionGuard = (record, context) => teams.guardExecution(record, context)
  const start = async (kind = 'delegate', extra = {}) => { const { run } = await manager.create({ requestId: randomUUID(), source: { kind: 'codex', id: parent.id }, kind, ...extra }); return manager.require(run.id) }
  const flush = async () => { await Promise.all([...manager.pending.values()]) }
  const finishWorker = async run => { const turn = threads.turns.get(run.worker.id).at(-1); Object.assign(turn, { status: 'done', items: [{ type: 'agent', text: result(run) }] }); threads.emit('turn-finished', { threadId: run.worker.id }); await flush() }
  t.after(async () => { await manager.shutdown(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, manager, codex, threads, terminals, agents, parent, teams, config, start, flush, finishWorker }
}

test('GP delegates through its exact preparation turn and delivers once', async t => {
  const f = await fixture(t)
  const run = await f.start()
  assert.equal(f.codex.calls[0].context.presetRunId, run.id)
  assert.equal(run.parentTurnId, f.parent.turns[0].id)
  assert.throws(() => f.codex.executionGuard(f.parent), /実行中/)
  assert.throws(() => f.manager.guard({ ...f.parent, permissionMode: 'workspace-write' }), /実行中/)
  await f.codex.finish(f.parent.id, brief(run)); await f.flush()
  assert.equal(run.phase, 'running')
  assert.match(f.threads.calls[0].input.text, /要求と確認/)
  await f.finishWorker(run)
  assert.equal(run.phase, 'completed')
  assert.equal(f.codex.calls.length, 1)
  await f.manager.deliver(run.id)
  assert.equal(f.codex.calls.length, 2)
  await f.manager.deliver(run.id)
  assert.equal(f.codex.calls.length, 2)
})

test('GP opinion review returns automatically and prevents same GPT model', async t => {
  const f = await fixture(t)
  f.config.taskPresets.reviewSelected.model = JSON.stringify(['openai-codex', 'gpt-6-luna'])
  await assert.rejects(f.start('review', { reviewMode: 'opinion' }), /別のモデル/)
  f.config.taskPresets.reviewSelected.model = 'C'
  const run = await f.start('review', { reviewMode: 'opinion' })
  await f.codex.finish(f.parent.id, brief(run)); await f.flush()
  assert.equal(run.permissionMode, 'read-only')
  await f.finishWorker(run)
  assert.equal(run.phase, 'completed')
  assert.ok(run.deliveredAt)
  assert.match(f.codex.calls.at(-1).text, /別担当の意見/)
})

test('GP never starts a worker for a stale, failed or denied preparation turn', async t => {
  for (const failure of ['wrong-turn', 'changed-session', 'error', 'denied']) await t.test(failure, async t => {
    const f = await fixture(t)
    const run = await f.start('review', { reviewMode: 'fix' })
    if (failure === 'wrong-turn') run.parentTurnId = 'different'
    if (failure === 'changed-session') f.parent.sessionId = 'other'
    await f.codex.finish(f.parent.id, brief(run), failure === 'error' ? 'error' : 'done', failure === 'denied' ? [{}] : [])
    await f.flush()
    assert.equal(run.phase, 'needs-attention')
    assert.equal(run.worker, undefined)
  })
})

test('GP refuses active or configuring sources and does not retry uncertain delivery', async t => {
  const f = await fixture(t)
  f.parent.state = 'running'
  await assert.rejects(f.start(), /待機中/)
  f.parent.state = 'idle'; f.codex.configuring.add(f.parent.id)
  await assert.rejects(f.start(), /待機中/)
  f.codex.configuring.clear()
  const run = await f.start()
  await f.codex.finish(f.parent.id, brief(run)); await f.flush(); await f.finishWorker(run)
  f.codex.failReceipt = true
  await assert.rejects(f.manager.deliver(run.id), /送信状態不明/)
  f.parent.state = 'idle'
  await assert.rejects(f.manager.deliver(run.id), /前回の送信状態が不明/)
  assert.equal(f.codex.calls.length, 2)
})

test('GP auto-delivery does not target a changed session', async t => {
  const f = await fixture(t)
  const run = await f.start('review', { reviewMode: 'opinion' })
  await f.codex.finish(f.parent.id, brief(run)); await f.flush()
  f.parent.sessionId = 'replacement-session'
  await f.finishWorker(run)
  assert.equal(run.phase, 'completed')
  assert.match(run.deliveryError, /元セッションが変更/)
  assert.equal(f.codex.calls.length, 1)
})

test('removing the GP parent stops a running preset', async t => {
  const f = await fixture(t)
  const run = await f.start()
  const stopped = new Promise(resolve => f.manager.on('run', function onRun(value) { if (value.phase === 'stopped') { f.manager.off('run', onRun); resolve() } }))
  f.codex.emit('removed', { id: f.parent.id })
  await stopped
  assert.equal(run.sourceGone, true)
  assert.equal(run.phase, 'stopped')
})

test('GP source model changes during authorization do not bypass review independence', async t => {
  const f = await fixture(t)
  f.manager.authorize = async () => { f.parent.model = 'new-model' }
  f.config.taskPresets.reviewSelected.model = JSON.stringify(['openai-codex', 'new-model'])
  await assert.rejects(f.start('review', { reviewMode: 'fix' }), /元のGPタスクが変更/)
  assert.equal(f.codex.calls.length, 0)
})

test('other ordinary GP tasks may continue while the parent is reserved', async t => {
  const f = await fixture(t)
  const run = await f.start()
  const other = { ...f.parent, id: 'other', turns: [], state: 'idle' }
  f.codex.records.set(other.id, other)
  assert.doesNotThrow(() => f.codex.run(other.id, 'independent'))
  assert.throws(() => f.codex.executionGuard(f.parent), /実行中/)
  await f.manager.stop(run.id)
  assert.equal(run.phase, 'stopped')
})

test('GP settings cannot race a preset send and execution guards receive its context', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-gp-runner-'))
  const server = Object.assign(new EventEmitter(), { async stop() {} })
  const runner = new CodexRunner({ home: root, server, attachmentsDir: root })
  const record = { id: 'gp', model: 'old', effort: 'low', permissionMode: 'workspace-write', workspace: root, turns: [], sessionId: null }
  runner.records.set(record.id, record)
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  runner.models = async () => { entered(); await gate; return [{ id: 'new', efforts: ['low'], defaultEffort: 'low' }] }
  const change = runner.update(record.id, { model: 'new' })
  await ready
  assert.throws(() => runner.run(record.id, 'prepare', { presetRunId: 'R' }), /設定の変更/)
  release(); await change
  const seen = []
  runner.executionGuard = (_record, context) => { seen.push(context); throw new Error('guarded') }
  assert.throws(() => runner.run(record.id, 'prepare', { presetRunId: 'R' }), /guarded/)
  assert.deepEqual(seen, [{ presetRunId: 'R' }])
  await assert.rejects(runner.update(record.id, { permissionMode: 'read-only' }), /guarded/)
  await fs.rm(root, { recursive: true, force: true })
})

test('real Codex runner correlates GP preparation and delivery with app-server turns', async t => {
  const f = await fixture(t)
  const app = Object.assign(new EventEmitter(), {
    async use(callback) { return callback() },
    async rawRequest(method, params) {
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.test' } }
      if (method === 'model/list') return { data: [{ model: 'gpt-6-luna', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId ?? 'gp-session' } }
      if (method === 'turn/start') return { turn: { id: 'remote-' + params.clientUserMessageId } }
      return {}
    },
    async stop() {}, respond() {}, reject() {},
  })
  const codex = await new CodexRunner({ home: path.join(f.root, 'codex'), attachmentsDir: f.root, server: app }).load()
  const task = await codex.create({ workspace: f.root, model: 'gpt-6-luna', effort: 'low' })
  const manager = await new TaskPresets({ dir: path.join(f.root, 'real-preset'), threads: f.threads, terminals: f.terminals, codex, agents: f.agents, teams: f.teams,
    settings: () => f.config, catalog: () => ({}), validateModel() {}, authorize: async () => {}, snapshot: async () => ({ hash: 'hash' }) }).load()
  manager.captureCheckpoint = async () => null
  manager.verifier.verify = async () => ({ status: 'unverified', checks: [], endHash: 'hash' })
  f.teams.presetGuard = (record, context) => manager.guard(record, context)
  codex.executionGuard = (record, context) => f.teams.guardExecution(record, context)
  t.after(async () => { await manager.shutdown(); await codex.shutdown() })
  const { run: summary } = await manager.create({ source: { kind: 'codex', id: task.id }, kind: 'delegate', requestId: randomUUID() })
  const run = manager.require(summary.id)
  const remoteTurn = await codex.waitForStart(task.id)
  assert.equal(codex.turns(task.id).at(-1).id, run.parentTurnId)
  const finished = once(codex, 'finished')
  app.emit('notification', 'turn/completed', { threadId: codex.get(task.id).sessionId, turn: { id: remoteTurn, status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: brief(run) }] } })
  await finished; await Promise.all([...manager.pending.values()])
  assert.equal(run.phase, 'running')
  const turn = f.threads.turns.get(run.worker.id).at(-1)
  Object.assign(turn, { status: 'done', items: [{ type: 'agent', text: result(run) }] })
  f.threads.emit('turn-finished', { threadId: run.worker.id })
  await Promise.all([...manager.pending.values()])
  assert.equal(run.phase, 'completed')
  const delivery = manager.deliver(run.id)
  // Observe the runner's synchronous reservation instead of polling the model service.
  const sent = once(codex, 'turn')
  await sent
  const deliveredTurn = await codex.waitForStart(task.id)
  await delivery
  assert.equal(codex.turns(task.id).length, 2)
  const done = once(codex, 'finished')
  app.emit('notification', 'turn/completed', { threadId: codex.get(task.id).sessionId, turn: { id: deliveredTurn, status: 'completed', items: [] } })
  await done
})
