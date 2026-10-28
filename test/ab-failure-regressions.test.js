import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AbManager } from '../server/ab.js'
import { AbRunner } from '../server/ab-runner.js'
import { abToolAllowed, apply as applyAbPolicy } from '../server/ab-policy-plugin.js'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { notificationRoute, notificationText } from '../web/src/notification.ts'
import { createAbHandlers } from '../server/rpc-handlers-ab.js'
import { fixture, deferred, pending } from './helpers/thread-manager.js'

const config = { a: 'A', b: 'B', leader: 'L', implementer: 'I', lean: true, delegate: true, review: true }
async function setup(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-failures-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = [], stops = []
  const runner = Object.assign(new EventEmitter(), {
    async start(input) { calls.push(input); return { kind: 'fake', id: input.jobId } },
    async stop(handle) { stops.push(handle) }, async remove() {}, ...overrides,
  })
  const manager = await new AbManager({ dir, runner, validateModel: (value) => assert.ok(value) }).load()
  const notifications = []
  manager.on('notify', (event) => notifications.push(event))
  const { run } = await manager.create({ workspace: dir, text: 'request', config })
  const finish = async (role, extra = {}) => {
    const job = manager.require(run.id).jobs.filter((entry) => entry.role === role).at(-1)
    await manager.lock(run.id, () => manager.finished({ runId: run.id, jobId: job.id, status: 'completed', text: `${role} report`, ...extra }))
  }
  const approve = async (delegate = true, review = true) => {
    await finish('a'); await finish('b'); await finish('leader')
    await manager.approve({ id: run.id, revision: 1, delegate, review })
  }
  return { dir, runner, manager, run: manager.require(run.id), calls, stops, finish, approve, notifications }
}

test('actual ThreadManager approval event is denied immediately without promise/type errors', async (t) => {
  const f = await fixture(t)
  const runner = new AbRunner({ threads: f.manager, agents: new EventEmitter() })
  const handle = await runner.start({ runId: 'R', jobId: 'J', workspace: f.base, model: '["test","model"]',
    text: 'implement', instructions: 'test', writable: true, lean: true })
  await f.started.promise
  const permission = f.manager.onPermission({ sessionId: f.manager.threads.get(handle.id).sessionId,
    toolCall: { toolCallId: 'call', title: 'pwsh', rawInput: { command: 'test command' } },
    options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] })
  assert.deepEqual(await permission, { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(f.manager.pendingPermissions(handle.id), [])
  assert.equal(f.manager.threads.get(handle.id).pendingApproval, false)
  f.manager.onUpdate(f.manager.threads.get(handle.id).sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'report' } })
  const result = once(runner, 'finished')
  f.finish.resolve()
  const [event] = await result
  assert.equal(event.denials.length, 1)
  assert.match(event.denials[0], /pwsh/)
  assert.equal(runner.owned.size, 0)
})

test('Claude denied operations survive both successful and failed final results', async () => {
  for (const status of ['done', 'error']) {
    const threads = new EventEmitter()
    const agents = Object.assign(new EventEmitter(), { create: async () => ({ id: 'C' }), run() {} })
    const runner = new AbRunner({ threads, agents })
    await runner.start({ runId: 'R', jobId: 'J', model: 'claude:haiku', workspace: '/p', instructions: 'test', text: 'task', writable: true })
    const result = once(runner, 'finished')
    agents.emit('finished', { id: 'C', status, text: 'report', error: status === 'error' ? 'failure' : undefined,
      denials: [{ tool_name: 'Bash', tool_input: { command: 'npm test' } }] })
    const [event] = await result
    assert.match(event.denials[0], /Bash/)
    assert.equal(event.status, status === 'done' ? 'completed' : 'error')
    assert.equal(runner.owned.size, 0)
  }
})

test('AB startup rejection cleans up its newly created hidden session', async () => {
  for (const claude of [false, true]) {
    const removed = []
    const threads = Object.assign(new EventEmitter(), { create: async () => ({ id: 'T' }), send: async () => { throw new Error('not signed in') }, remove: async (id) => removed.push(id) })
    const agents = Object.assign(new EventEmitter(), { create: async () => ({ id: 'C' }), run: () => { throw new Error('CLI not found') }, remove: async (id) => removed.push(id) })
    const runner = new AbRunner({ threads, agents })
    await assert.rejects(runner.start({ runId: 'R', jobId: 'J', model: claude ? 'claude:haiku' : '["test","model"]', workspace: '/p', instructions: '', text: 'task' }))
    assert.deepEqual(removed, [claude ? 'C' : 'T'])
    assert.equal(runner.owned.size, 0)
  }
})

test('AB cancellation waits for real completion, with a timeout when it never settles', async () => {
  const done = deferred(), exited = deferred()
  const threads = Object.assign(new EventEmitter(), { active: new Map([['T', { done: done.promise }]]), cancel: async () => {} })
  const agents = Object.assign(new EventEmitter(), { live: new Map([['C', { exited: exited.promise }]]), stop() {} })
  const runner = new AbRunner({ threads, agents, stopTimeoutMs: 1000 })
  const stop = runner.stop({ kind: 'thread', id: 'T' })
  await pending(stop); done.resolve(); await stop
  const stopClaude = runner.stop({ kind: 'claude', id: 'C' })
  await pending(stopClaude); exited.resolve(); await stopClaude
  threads.active.set('stuck', { done: new Promise(() => {}) })
  runner.stopTimeoutMs = 10
  await assert.rejects(runner.stop({ kind: 'thread', id: 'stuck' }), /タイムアウト/)
})

test('AB consult failure stops the surviving peer and notifies once', async (t) => {
  const f = await setup(t)
  await f.finish('a', { status: 'error', text: '', error: 'provider failed' })
  assert.equal(f.run.phase, 'error')
  assert.equal(f.run.jobs[1].status, 'stopped')
  assert.equal(f.stops.length, 1)
  await f.finish('b')
  assert.equal(f.calls.length, 2)
  assert.equal(f.notifications.filter((event) => event.kind === 'ab-error').length, 1)
  assert.equal(f.manager.busy, false)
})

test('AB still cancels its peer when saving the stopping state fails', async (t) => {
  const f = await setup(t)
  const save = f.manager.save.bind(f.manager)
  let failed = false
  f.manager.save = async (run) => {
    if (!failed && run.jobs.some((job) => job.status === 'stopping')) { failed = true; throw new Error('disk failed') }
    return save(run)
  }
  await f.finish('a', { status: 'error', error: 'provider failed' })
  assert.equal(failed, true)
  assert.equal(f.stops.length, 1)
  assert.equal(f.manager.busy, false)
})

test('AB startup failure stops a peer whose handle arrives after the failure', async (t) => {
  const late = deferred(), failed = deferred()
  const starts = []
  const fTask = setup(t, { async start(input) {
    starts.push(input)
    if (input.model === 'A') { failed.resolve(); throw new Error('startup failed') }
    await late.promise
    return { kind: 'fake', id: input.jobId }
  } })
  await failed.promise
  await pending(fTask)
  late.resolve()
  const f = await fTask
  assert.equal(starts.length, 2)
  assert.equal(f.run.phase, 'error')
  assert.equal(f.stops[0].id, f.run.jobs[1].id)
  assert.equal(f.run.jobs[1].status, 'stopped')
})

test('AB stop failure keeps busy/stop visible and forbids retry or deletion until idle', async (t) => {
  const f = await setup(t)
  await f.approve(false)
  f.runner.stop = async () => { throw new Error('cannot confirm exit') }
  await f.manager.stop({ id: f.run.id })
  const job = f.run.jobs.at(-1)
  assert.equal(job.status, 'stopping')
  assert.match(job.stopError, /cannot confirm exit/)
  assert.equal(f.manager.busy, true)
  await assert.rejects(f.manager.retry({ id: f.run.id, jobId: job.id }))
  await assert.rejects(f.manager.remove({ id: f.run.id }), /停止/)
  await f.finish('direct', { status: 'cancelled', text: '' })
  assert.equal(job.status, 'stopped')
  assert.equal(job.stopError, undefined)
  assert.equal(f.manager.busy, false)
})

test('AB stop errors clear independently when multiple peers stop successfully', async (t) => {
  const f = await setup(t)
  f.runner.stop = async () => { throw new Error('cannot confirm exit') }
  await f.manager.stop({ id: f.run.id })
  assert.ok(f.run.jobs.every((job) => job.status === 'stopping' && job.stopError))
  await f.finish('a', { status: 'cancelled', text: '' })
  assert.equal(f.run.jobs[0].stopError, undefined)
  assert.equal(f.run.jobs[1].status, 'stopping')
  assert.ok(f.run.jobs[1].stopError)
  f.runner.stop = async () => {}
  await f.manager.stop({ id: f.run.id })
  assert.ok(f.run.jobs.every((job) => job.status === 'stopped' && job.stopError === undefined))
  assert.equal(f.manager.busy, false)
})

for (const phase of ['awaiting-approval', 'reviewed', 'completed']) {
  test(`AB late stop on ${phase} keeps the finished run, its plan and its next action`, async (t) => {
    const f = await setup(t)
    await f.finish('a'); await f.finish('b'); await f.finish('leader')
    if (phase !== 'awaiting-approval') await f.manager.approve({ id: f.run.id, revision: 1, delegate: phase === 'reviewed', review: phase === 'reviewed' })
    if (phase === 'reviewed') { await f.finish('instructions'); await f.finish('implementer'); await f.finish('reviewer') }
    if (phase === 'completed') await f.finish('direct')
    assert.equal(f.run.phase, phase)
    const before = { revision: f.run.revision, plan: f.run.plan, approvedPlan: f.run.approvedPlan, retryJobId: f.run.retryJobId }
    const statuses = f.run.jobs.map((job) => job.status)
    const stops = f.stops.length
    // A stop clicked while the stage was finishing arrives after it is done.
    const { run: viewed } = await f.manager.stop({ id: f.run.id })
    assert.equal(viewed.phase, phase)
    assert.equal(f.run.phase, phase)
    assert.deepEqual([f.run.revision, f.run.plan, f.run.approvedPlan, f.run.retryJobId], [before.revision, before.plan, before.approvedPlan, before.retryJobId])
    assert.deepEqual(f.run.jobs.map((job) => job.status), statuses)
    assert.equal(f.stops.length, stops)
    // What the finished stage produced is still usable: approval at the plan, a follow-up afterwards.
    if (phase === 'awaiting-approval') {
      await f.manager.approve({ id: f.run.id, revision: before.revision, delegate: false, review: false })
      assert.equal(f.run.phase, 'implementing')
    } else {
      await f.manager.revise({ id: f.run.id, text: 'follow-up after a late stop' })
      assert.equal(f.run.phase, 'judging')
    }
  })
}

test('AB stop while a stage runs still stops it and offers that stage to retry', async (t) => {
  const f = await setup(t)
  await f.approve(false)
  const job = f.run.jobs.at(-1)
  assert.equal(job.status, 'running')
  const { run: stopped } = await f.manager.stop({ id: f.run.id })
  assert.equal(stopped.phase, 'stopped')
  assert.equal(job.status, 'stopped')
  assert.equal(f.run.retryJobId, job.id)
  assert.deepEqual(f.stops.map((handle) => handle.id), [job.id])
  assert.equal(f.manager.busy, false)
  const count = f.calls.length
  await f.manager.retry({ id: f.run.id, jobId: job.id })
  assert.equal(f.calls.length, count + 1)
  assert.equal(f.calls.at(-1).writable, true)
  assert.equal(f.calls.at(-1).model, job.model)
})

test('AB deletion still removes a run whose stop had nothing to stop', async (t) => {
  const removed = []
  const f = await setup(t, { async remove(handle) { removed.push(handle) } })
  await f.finish('a'); await f.finish('b'); await f.finish('leader')
  await f.manager.stop({ id: f.run.id })
  assert.equal(f.run.phase, 'awaiting-approval')
  await f.manager.remove({ id: f.run.id })
  assert.equal(f.manager.list().length, 0)
  assert.equal(removed.length, f.run.jobs.length)
})

for (const role of ['instructions', 'implementer', 'direct', 'reviewer']) {
  test(`AB ${role} failure retries only that stage, on explicit latest-job request`, async (t) => {
    const f = await setup(t)
    await f.approve(role !== 'direct')
    if (role === 'implementer' || role === 'reviewer') await f.finish('instructions')
    if (role === 'reviewer') await f.finish('implementer')
    const previous = f.run.jobs.at(-1)
    assert.equal(previous.role, role)
    await f.finish(role, { status: 'error', text: 'partial report', error: 'interrupted' })
    assert.equal(f.run.retryJobId, previous.id)
    const before = f.calls.length
    const handlers = createAbHandlers(f.manager)
    await assert.rejects(handlers['ab.retry']({ id: 99, runId: f.run.id, jobId: 'stale' }))
    await handlers['ab.retry']({ id: 100, runId: f.run.id, jobId: previous.id })
    assert.equal(f.calls.length, before + 1)
    assert.equal(f.calls.at(-1).model, previous.model)
    assert.equal(f.calls.at(-1).writable, previous.writable)
    assert.match(f.calls.at(-1).text, /partial report/)
    assert.match(f.calls.at(-1).instructions, /重複して実行しない/)
    await assert.rejects(handlers['ab.retry']({ id: 101, runId: f.run.id, jobId: previous.id }))
    await f.finish(role)
    assert.ok(!['error', 'interrupted'].includes(f.run.phase))
  })
}

test('AB empty success report is an error, not a successful job', async (t) => {
  const f = await setup(t)
  await f.approve(false)
  await f.finish('direct', { text: '', denials: ['Bash: blocked'] })
  assert.equal(f.run.phase, 'error')
  assert.equal(f.run.jobs.at(-1).status, 'error')
  assert.match(f.run.jobs.at(-1).report, /実行されなかった操作/)
})

test('AB review OFF records denied implementation as attention, without waking leader', async (t) => {
  const f = await setup(t)
  await f.approve(true, false)
  await f.finish('instructions')
  const count = f.calls.length
  await f.finish('implementer', { denials: ['Bash: npm test'] })
  assert.equal(f.calls.length, count)
  assert.equal(f.run.phase, 'needs-attention')
  assert.match(f.run.warning, /未完了/)
  assert.match(f.run.jobs.at(-1).report, /Bash: npm test/)
  assert.equal(f.notifications.at(-1).kind, 'ab-attention')
})

test('AB reviewer receives denied operations and warning is retained', async (t) => {
  const f = await setup(t)
  await f.approve()
  await f.finish('instructions')
  await f.finish('implementer', { denials: ['Bash: blocked'] })
  assert.match(f.calls.at(-1).text, /Bash: blocked/)
  await f.finish('reviewer')
  assert.equal(f.run.phase, 'needs-attention')
  assert.ok(f.run.warning)
  assert.equal(f.run.retryJobId, f.run.jobs.find((job) => job.role === 'implementer').id)
  assert.deepEqual(f.notifications.map((event) => event.kind), ['ab-approval', 'ab-attention'])
})

test('AB notifications route to AB and describe approval, completion, review and errors', () => {
  for (const kind of ['approval', 'completed', 'reviewed', 'attention', 'error']) {
    const event = { kind: `ab-${kind}`, ab: true, threadId: 'R', title: '相談' }
    assert.deepEqual(notificationRoute(event), { view: 'ab', id: 'R' })
    assert.match(notificationText(event), /AB.*相談/)
  }
  assert.deepEqual(notificationRoute({ threadId: 'T', terminal: true }), { view: 'terminal', id: 'T' })
  assert.deepEqual(notificationRoute({ threadId: 'T' }), { view: 'thread', id: 'T' })
})

test('AB implementation allowlist rejects interactive/delegation and unknown future tools', () => {
  for (const name of ['write', 'edit', 'pwsh', 'bash', 'read', 'job_output', 'skill', 'mcp__chrome__take_snapshot']) assert.equal(abToolAllowed(name, true), true, name)
  for (const name of ['ask_user_question', 'exit_plan_mode', 'subagent', 'workflow', 'create_goal', 'update_goal', 'unknown_future_tool', 'mcp__other__spawn']) assert.equal(abToolAllowed(name, true), false, name)
})

test('real DSH ToolRuntime enforces AB guards before dispatch', async () => {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {} })
  const tools = new ToolRuntime(ctx)
  let calls = 0
  const register = (name) => tools.register({ name, description: 'fixture', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls++; return 'ran' } })
  register('read'); register('write')
  applyAbPolicy(ctx, { writable: false })
  const execute = (name, arguments_ = {}) => tools.execute({ name, arguments: arguments_, callId: `test-${name}`, signal: new AbortController().signal })
  assert.equal((await execute('read')).isError, false)
  assert.equal(calls, 1)
  assert.equal((await execute('write')).isError, true)
  assert.equal((await execute('read', { sandbox_permissions: 'danger-full-access' })).isError, true)
  assert.equal(calls, 1)
  await ctx.fiber.dispose()
})

test('AB malformed JSON is backed up and does not prevent app load', async (t) => {
  const f = await setup(t)
  await fs.writeFile(path.join(f.dir, 'state.json'), '{malformed')
  const restored = await new AbManager({ dir: f.dir, runner: f.runner }).load()
  assert.deepEqual(restored.list(), [])
  const backup = (await fs.readdir(f.dir)).find((entry) => entry.startsWith('state.json.corrupt-'))
  assert.equal(await fs.readFile(path.join(f.dir, backup), 'utf8'), '{malformed')
})

test('AB interrupted implementation keeps stage retry but never starts on restart', async (t) => {
  const f = await setup(t)
  await f.approve(false)
  const count = f.calls.length
  const restored = await new AbManager({ dir: f.dir, runner: f.runner }).load()
  const run = restored.require(f.run.id)
  assert.equal(run.phase, 'interrupted')
  assert.equal(run.retryJobId, run.jobs.at(-1).id)
  assert.equal(f.calls.length, count)
})
