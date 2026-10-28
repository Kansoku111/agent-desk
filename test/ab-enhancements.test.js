import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AbManager, abConfig } from '../server/ab.js'
import { AbRunner } from '../server/ab-runner.js'
import { createAbHandlers } from '../server/rpc-handlers-ab.js'
import { abTimeline, abMarkdown } from '../web/src/ab-transcript.ts'
import { fixture } from './helpers/thread-manager.js'

async function setup(t, delegate = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-enhancements-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = [], stops = [], removed = []
  const runner = Object.assign(new EventEmitter(), {
    async start(input) { calls.push(input); return { id: input.jobId, kind: 'fake' } },
    async stop(handle) { stops.push(handle) }, async remove(handle) { removed.push(handle) },
  })
  const manager = await new AbManager({ dir, runner }).load()
  const { run: initial } = await manager.create({ workspace: dir, text: 'original request', config: {
    a: 'A', b: 'B', leader: 'L', implementer: 'I', delegate,
    efforts: { a: 'low', b: 'medium', leader: 'high', implementer: 'max' },
  } })
  const run = manager.require(initial.id)
  const finish = async (role, extra = {}) => manager.lock(run.id, () => manager.finished({
    runId: run.id, jobId: run.jobs.findLast((job) => job.role === role).id,
    status: 'completed', text: `${role} report`, ...extra,
  }))
  const approve = () => manager.approve({ id: run.id, revision: run.revision, delegate, review: true })
  await finish('a'); await finish('b'); await finish('leader')
  return { dir, runner, manager, run, calls, stops, removed, finish, approve }
}

test('AB effort defaults are isolated, validated and compatible with old settings', () => {
  const first = abConfig(); first.efforts.a = 'high'
  assert.equal(abConfig().efforts.a, '')
  for (const efforts of [[], null, 'high', { a: 3 }]) assert.throws(() => abConfig({ efforts }))
  assert.throws(() => abConfig({ a: 'claude:opus', efforts: { a: 'unsupported' } }))
})

for (const delegate of [false, true]) {
  test(`AB persists role efforts through every stage and retry (delegate=${delegate})`, async (t) => {
    const f = await setup(t, delegate)
    assert.deepEqual(f.calls.map((call) => call.effort), ['low', 'medium', 'high'])
    await f.approve()
    assert.equal(f.calls.at(-1).effort, 'high')
    if (delegate) { await f.finish('instructions'); assert.equal(f.calls.at(-1).effort, 'max') }
    const previous = f.run.jobs.at(-1)
    await f.finish(previous.role, { status: 'error', error: 'failed' })
    // Even a later configuration change must not affect the failed job's retry.
    f.run.config.efforts[delegate ? 'implementer' : 'leader'] = 'low'
    await f.manager.retry({ id: f.run.id, jobId: previous.id })
    assert.equal(f.calls.at(-1).model, previous.model)
    assert.equal(f.calls.at(-1).effort, previous.effort)
    await f.finish(previous.role)
    if (delegate) { assert.equal(f.calls.at(-1).effort, 'high'); await f.finish('reviewer') }
    const count = f.calls.length
    const restored = await new AbManager({ dir: f.dir, runner: f.runner }).load()
    assert.equal(restored.require(f.run.id).jobs.find((job) => job.id === previous.id).effort, previous.effort)
    assert.equal(f.calls.length, count)
  })
}

for (const phase of ['completed', 'reviewed', 'needs-attention']) {
  test(`AB ${phase} follow-up is read-only, contextual and requires fresh approval`, async (t) => {
    const f = await setup(t, phase === 'reviewed')
    await f.approve()
    if (phase === 'reviewed') await f.finish('instructions')
    const implementation = f.run.jobs.at(-1)
    await f.finish(implementation.role, phase === 'needs-attention' ? { denials: ['blocked operation'] } : {})
    if (phase === 'reviewed') await f.finish('reviewer')
    assert.equal(f.run.phase, phase)
    const oldRevision = f.run.revision
    const results = await Promise.allSettled([
      f.manager.revise({ id: f.run.id, text: 'follow-up one' }),
      f.manager.revise({ id: f.run.id, text: 'duplicate follow-up' }),
      f.manager.retry({ id: f.run.id, jobId: implementation.id }),
      f.manager.approve({ id: f.run.id, revision: oldRevision, delegate: false, review: false }),
    ])
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'rejected', 'rejected'])
    assert.equal(f.run.retryJobId, undefined)
    assert.equal(f.run.approvedRevision, undefined)
    const consultation = f.calls.at(-1)
    assert.equal(consultation.writable, false)
    assert.equal(consultation.permissionMode, 'read-only')
    assert.notEqual(consultation.jobId, implementation.id)
    const context = JSON.parse(consultation.text)
    assert.equal(context.originalRequest, 'original request')
    assert.equal(context.approvedPlan, 'leader report')
    assert.ok(context.reports.some((report) => report.id === implementation.id && report.report))
    assert.equal(context.conversation.at(-1).text, 'follow-up one')
    await f.finish('leader', { text: 'updated plan' })
    assert.equal(f.run.phase, 'awaiting-approval')
    await assert.rejects(f.manager.approve({ id: f.run.id, revision: oldRevision, delegate: false, review: false }))
    const count = f.calls.length
    const restored = await new AbManager({ dir: f.dir, runner: f.runner }).load()
    assert.equal(f.calls.length, count)
    await restored.revise({ id: f.run.id, text: 'follow-up after restart' })
    const after = JSON.parse(f.calls.at(-1).text)
    assert.equal(after.conversation.length, 2)
    assert.ok(after.reports.some((report) => report.report === 'updated plan'))
    assert.equal(f.calls.at(-1).writable, false)
  })
}

test('AB failed/interrupted follow-up never revives an old implementation retry on reload', async (t) => {
  const f = await setup(t)
  await f.approve(); const previous = f.run.jobs.at(-1)
  await f.finish('direct', { denials: ['blocked'] })
  await f.manager.revise({ id: f.run.id, text: 'new conditions' })
  let restored = await new AbManager({ dir: f.dir, runner: f.runner }).load()
  await assert.rejects(restored.retry({ id: f.run.id, jobId: previous.id }))
  await f.finish('leader', { status: 'error', error: 'consultation failed' })
  restored = await new AbManager({ dir: f.dir, runner: f.runner }).load()
  assert.equal(restored.require(f.run.id).retryJobId, undefined)
  await assert.rejects(restored.retry({ id: f.run.id, jobId: previous.id }))
})

test('AB refuses follow-up and approval if any job is still stopping', async (t) => {
  const f = await setup(t)
  f.run.jobs[0].status = 'stopping'
  await assert.rejects(f.manager.revise({ id: f.run.id, text: 'unsafe' }))
  await assert.rejects(f.approve())
})

test('AB rename/archive RPC persists without stopping active jobs; deletion still stops/removes', async (t) => {
  const f = await setup(t)
  await f.approve()
  const handlers = createAbHandlers(f.manager)
  await handlers['ab.update']({ id: 99, runId: f.run.id, title: ' renamed ', archived: true })
  assert.equal(f.run.title, 'renamed'); assert.equal(f.run.archived, true)
  assert.equal(f.stops.length, 0); assert.equal(f.run.phase, 'implementing')
  const restored = await new AbManager({ dir: f.dir, runner: f.runner }).load()
  assert.equal(restored.require(f.run.id).archived, true)
  assert.equal(restored.require(f.run.id).title, 'renamed')
  await handlers['ab.update']({ runId: f.run.id, archived: false })
  assert.equal(f.run.archived, false)
  await assert.rejects(handlers['ab.update']({ runId: f.run.id, title: '', archived: true }))
  assert.equal(f.run.archived, false)
  await handlers['ab.remove']({ runId: f.run.id })
  assert.equal(f.stops.length, 1)
  assert.equal(f.removed.length, f.run.jobs.length)
})

test('AB timeline and copied history interleave old and new messages with reports', () => {
  const job = (id, role, report = id) => ({ id, role, report, model: 'model', status: 'completed' })
  const run = { title: 'title', text: 'original', jobs: [job('a', 'a'), job('b', 'b'), job('plan1', 'leader'), job('plan2', 'leader'), job('implementation', 'direct'), job('review', 'reviewer'), job('answer', 'leader')],
    messages: ['old follow-up', { text: 'new follow-up', afterJobId: 'review' }] }
  const entries = abTimeline(run).map((entry) => entry.kind === 'job' ? entry.job.id : entry.text)
  assert.deepEqual(entries, ['a', 'b', 'plan1', 'old follow-up', 'plan2', 'implementation', 'review', 'new follow-up', 'answer'])
  const markdown = abMarkdown(run)
  let previous = markdown.indexOf('original')
  for (const text of entries) { const index = markdown.indexOf(text, previous + 1); assert.ok(index > previous, text); previous = index }
})

test('AB copied history labels the current unfinished status without changing content or order', () => {
  const image = { file: 'fixture.png', name: '画像.png' }
  const job = { id: 'job', role: 'direct', model: 'model', effort: 'low', status: 'completed', report: '途中の報告', error: '実行エラー', stopError: '停止確認エラー' }
  const run = { title: 'title', text: 'original', images: [image], jobs: [job], messages: [{ text: 'follow-up', images: [image], afterJobId: 'job' }] }
  const completed = '# title\n\n## ユーザー\n\noriginal\n\n![画像.png](/attachments/fixture.png)\n\n## direct — model (low)\n\n途中の報告\n\n実行エラー\n\n停止確認エラー\n\n## ユーザー\n\nfollow-up\n\n![画像.png](/attachments/fixture.png)'
  assert.equal(abMarkdown(run), completed)
  for (const [status, label] of Object.entries({ running: '実行中', stopping: '停止確認中', error: 'エラー', stopped: '停止', interrupted: '中断' })) {
    job.status = status
    assert.equal(abMarkdown(run), completed.replace('## direct — model (low)', `## direct — model (low)［${label}］`))
  }
  job.status = 'completed'
  job.effort = ''
  assert.equal(abMarkdown(run), completed.replace('model (low)', 'model'))
})

test('AB runner forwards explicit and unspecified effort to both backends', async () => {
  for (const model of ['claude:opus', '["test","model"]']) for (const effort of ['', 'high']) {
    let created
    const threads = Object.assign(new EventEmitter(), { create: async (input) => { created = input; return { id: 'T' } }, send: async () => {} })
    const agents = Object.assign(new EventEmitter(), { create: async (input) => { created = input; return { id: 'C' } }, run() {} })
    await new AbRunner({ threads, agents }).start({ runId: 'R', jobId: 'J', model, effort, workspace: '/project', text: 'text', instructions: 'instructions' })
    assert.equal(created.effort, model.startsWith('claude:') ? effort || null : effort)
  }
})

test('AB updated plan starts a new writer only on explicit fresh approval', async (t) => {
  const f = await setup(t)
  await f.approve(); await f.finish('direct', { denials: ['blocked'] })
  await f.manager.revise({ id: f.run.id, text: 'fix without repeating previous work' })
  const count = f.calls.length
  await f.finish('leader', { text: 'new bounded plan' })
  assert.equal(f.calls.length, count)
  await f.approve()
  assert.equal(f.calls.length, count + 1)
  assert.equal(f.calls.at(-1).writable, true)
  assert.equal(JSON.parse(f.calls.at(-1).text).approvedPlan, 'new bounded plan')
  assert.equal(f.run.warning, undefined)
  await assert.rejects(f.approve())
})

for (const acknowledge of [true, false]) {
  test(`AB ThreadManager confirms exact effort before prompt (acknowledge=${acknowledge})`, async (t) => {
    const f = await fixture(t)
    const model = '["test","model"]'
    const options = [{ id: 'model', currentValue: model, options: [{ value: model }] },
      { id: 'reasoning_effort', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] }]
    const original = f.runtime.newSession.bind(f.runtime)
    f.runtime.newSession = async () => ({ ...await original(), configOptions: options })
    const applied = []
    f.runtime.setOption = async (_session, key, value) => {
      applied.push({ key, value })
      if (acknowledge) options.find((entry) => entry.id === key).currentValue = value
      return options
    }
    const thread = await f.manager.create({ workspace: f.base, model, effort: 'high', ab: { runId: 'R', jobId: 'J' } })
    const result = once(f.manager, 'turn-finished')
    await f.manager.send(thread.id, { text: 'test' })
    if (acknowledge) { await f.started.promise; f.finish.resolve() }
    const [event] = await result
    assert.equal(event.status, acknowledge ? 'done' : 'error')
    assert.deepEqual(applied, [{ key: 'reasoning_effort', value: 'high' }])
    assert.equal(f.calls.prompts.length, acknowledge ? 1 : 0)
    assert.equal(f.manager.threads.get(thread.id).effort, 'high')
  })
}

test('AB ThreadManager rejects unsupported effort before sending instead of substituting', async (t) => {
  const f = await fixture(t)
  const thread = await f.manager.create({ workspace: f.base, model: '["test","model"]', effort: 'max', ab: { runId: 'R', jobId: 'J' } })
  const result = once(f.manager, 'turn-finished')
  await f.manager.send(thread.id, { text: 'do not send' })
  const [event] = await result
  assert.equal(event.status, 'error')
  assert.equal(f.calls.prompts.length, 0)
  assert.equal(f.manager.threads.get(thread.id).effort, 'max')
})
