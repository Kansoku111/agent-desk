import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AbManager, abConfig } from '../server/ab.js'
import { AbRunner } from '../server/ab-runner.js'
import { RuntimePool, runtimeKey } from '../server/runtime.js'
import { fixture } from './helpers/thread-manager.js'

const full = 'danger-full-access'
const workspace = 'workspace-write'
const config = { a: 'A', b: 'B', leader: 'L', implementer: 'I', permissionMode: full }
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-permissions-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const runner = Object.assign(new EventEmitter(), {
    async start(input) { calls.push(input); return { kind: 'fake', id: input.jobId } },
    async stop() {}, async remove() {},
  })
  const manager = await new AbManager({ dir, runner }).load()
  const { run: initial } = await manager.create({ workspace: dir, text: 'request', config })
  const run = manager.require(initial.id)
  const finish = async (role, extra = {}) => {
    const job = run.jobs.findLast((entry) => entry.role === role)
    await manager.lock(run.id, () => manager.finished({ runId: run.id, jobId: job.id, status: 'completed', text: `${role} report`, ...extra }))
  }
  await finish('a'); await finish('b'); await finish('leader')
  return { dir, calls, runner, manager, run, finish }
}

test('AB permission config is validated and old config stays confined', () => {
  assert.equal(abConfig().permissionMode, workspace)
  assert.equal(abConfig({ permissionMode: full }).permissionMode, full)
  for (const permissionMode of ['read-only', 'full', '', null, {}, true]) assert.throws(() => abConfig({ permissionMode }))
})

test('AB full-access runtime retains the implementation guard and is isolated from consultation', () => {
  const paths = { abLeanPatch: 'lean', abResearchPatch: 'research', abWritePatch: 'write' }
  const pool = new RuntimePool({ paths })
  assert.equal(runtimeKey({ ab: { writable: true }, permissionMode: full }), 'ab:write:danger-full-access')
  assert.equal(runtimeKey({ ab: { writable: true }, permissionMode: workspace }), 'ab:write')
  assert.equal(runtimeKey({ ab: { writable: false, lean: true }, permissionMode: full }), 'ab:lean')
  const runtime = pool.runtimes.get('ab:write:danger-full-access')
  assert.equal(runtime.mode, full)
  assert.deepEqual(runtime.patches, ['write'])
  assert.equal(pool.runtimes.get('ab:write').mode, workspace)
  assert.equal(pool.runtimes.get('ab:lean').mode, 'read-only')
})

for (const delegate of [false, true]) {
  test(`AB approved permissions reach only implementation (delegate=${delegate})`, async (t) => {
    const f = await setup(t)
    assert.ok(f.calls.every((call) => call.permissionMode === 'read-only'))
    for (const permissionMode of ['read-only', 'bad', null]) {
      await assert.rejects(f.manager.approve({ id: f.run.id, revision: 1, delegate, review: true, permissionMode }))
      assert.equal(f.run.phase, 'awaiting-approval')
    }
    await f.manager.approve({ id: f.run.id, revision: 1, delegate, review: true, permissionMode: full })
    if (delegate) {
      assert.equal(f.calls.at(-1).permissionMode, 'read-only')
      await f.finish('instructions')
    }
    assert.equal(f.calls.at(-1).permissionMode, full)
    const implementation = f.run.jobs.at(-1)
    assert.equal(implementation.permissionMode, full)
    await f.finish(delegate ? 'implementer' : 'direct')
    if (delegate) {
      assert.equal(f.calls.at(-1).permissionMode, 'read-only')
      await f.finish('reviewer')
    }
    assert.equal(f.run.phase, delegate ? 'reviewed' : 'completed')
  })
}

for (const delegate of [false, true]) {
  test(`AB denied implementation can retry in chosen mode without replaying consultation (delegate=${delegate})`, async (t) => {
    const f = await setup(t)
    await f.manager.approve({ id: f.run.id, revision: 1, delegate, review: true, permissionMode: workspace })
    if (delegate) await f.finish('instructions')
    const previous = f.run.jobs.at(-1)
    await f.finish(previous.role, { denials: ['pwsh: permission repair'] })
    if (delegate) await f.finish('reviewer')
    assert.equal(f.run.phase, 'needs-attention')
    assert.equal(f.run.retryJobId, previous.id)
    const count = f.calls.length
    await f.manager.retry({ id: f.run.id, jobId: previous.id, permissionMode: full })
    assert.equal(f.calls.length, count + 1)
    assert.equal(f.calls.at(-1).permissionMode, full)
    assert.match(f.calls.at(-1).text, /permission repair/)
    assert.match(f.calls.at(-1).instructions, /重複して実行しない/)
    assert.equal(previous.permissionMode, workspace)
    assert.equal(f.run.warning, undefined)
    await assert.rejects(f.manager.retry({ id: f.run.id, jobId: previous.id, permissionMode: full }))
    await f.finish(previous.role)
    if (delegate) await f.finish('reviewer')
    assert.equal(f.run.phase, delegate ? 'reviewed' : 'completed')
  })
}

test('AB legacy needs-attention state gains a retry without launching or widening access', async (t) => {
  const f = await setup(t)
  await f.manager.approve({ id: f.run.id, revision: 1, delegate: false, review: false, permissionMode: workspace })
  const previous = f.run.jobs.at(-1)
  await f.finish('direct', { denials: ['pwsh: blocked'] })
  const saved = JSON.parse(await fs.readFile(path.join(f.dir, 'state.json'), 'utf8'))
  delete saved.config.permissionMode
  delete saved.runs[0].config.permissionMode
  delete saved.runs[0].retryJobId
  await fs.writeFile(path.join(f.dir, 'state.json'), JSON.stringify(saved))
  const count = f.calls.length
  const restored = await new AbManager({ dir: f.dir, runner: f.runner }).load()
  const run = restored.require(f.run.id)
  assert.equal(run.config.permissionMode, workspace)
  assert.equal(run.retryJobId, previous.id)
  assert.equal(f.calls.length, count)
  await assert.rejects(restored.retry({ id: run.id, jobId: previous.id, permissionMode: 'invalid' }))
  assert.equal(run.warning, f.run.warning)
  await restored.retry({ id: run.id, jobId: previous.id, permissionMode: full })
  assert.equal(f.calls.at(-1).permissionMode, full)
})

test('AB adapter uses selected full access only for the writable stage', async () => {
  const created = []
  const threads = Object.assign(new EventEmitter(), {
    create: async (input) => { created.push(input); return { id: `T${created.length}` } }, send: async () => {},
  })
  const runner = new AbRunner({ threads, agents: new EventEmitter() })
  for (const writable of [false, true]) {
    await runner.start({ runId: 'R', jobId: 'J', workspace: '/project', model: 'model', text: 'task', instructions: '', writable, permissionMode: full })
  }
  assert.equal(created[0].permissionMode, 'read-only')
  assert.equal(created[1].permissionMode, full)
})

test('AB records actual Windows provisioning failure even without an approval request', async (t) => {
  const f = await fixture(t)
  const runner = new AbRunner({ threads: f.manager, agents: new EventEmitter() })
  const handle = await runner.start({ runId: 'R', jobId: 'J', workspace: f.base, model: '["test","model"]',
    text: 'implement', instructions: 'test', writable: true, permissionMode: workspace })
  await f.started.promise
  const sessionId = f.manager.threads.get(handle.id).sessionId
  for (const [toolCallId, status, output] of [
    ['blocked', 'failed', 'SetNamedSecurityInfoW failed (Win32 5): grantWrite(project)'],
    ['ordinary', 'failed', 'test assertion failed'],
    ['quoted', 'completed', 'SetNamedSecurityInfoW failed (Win32 5): quoted documentation'],
  ]) {
    f.manager.onUpdate(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'pwsh', status,
      rawInput: { command: 'npm test' }, content: [{ type: 'content', content: { type: 'text', text: output } }] })
  }
  f.manager.onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cannot implement' } })
  const result = once(runner, 'finished')
  f.finish.resolve()
  const [event] = await result
  assert.equal(event.blockers.length, 1)
  assert.match(event.blockers[0], /grantWrite/)
  assert.deepEqual(event.denials, [])
})

test('AB provisioning blocker gets attention and retry even when the model reports completion', async (t) => {
  const f = await setup(t)
  await f.manager.approve({ id: f.run.id, revision: 1, delegate: false, review: false })
  await f.finish('direct', { blockers: ['SetNamedSecurityInfoW failed (Win32 5)'] })
  assert.equal(f.run.phase, 'needs-attention')
  assert.equal(f.run.retryJobId, f.run.jobs.at(-1).id)
  assert.match(f.run.warning, /権限エラー/)
  assert.match(f.run.jobs.at(-1).report, /実行環境の権限エラー/)
  await f.manager.retry({ id: f.run.id, jobId: f.run.retryJobId, permissionMode: full })
  assert.match(f.calls.at(-1).text, /previousBlockers/)
})
