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
const config = { a: 'A', b: 'B', leader: 'L', implementer: 'I' }
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

test('AB has no permission setting: stale saved values are dropped', () => {
  assert.equal('permissionMode' in abConfig(), false)
  assert.equal('permissionMode' in abConfig({ permissionMode: 'workspace-write' }), false)
})

test('AB implementation runs in the unsandboxed runtime, consultation never does', () => {
  const pool = new RuntimePool({ paths: { abLeanPatch: 'lean', abResearchPatch: 'research', abWritePatch: 'write' }, onUpdate: () => {}, onPermission: async () => ({}) })
  assert.equal(runtimeKey({ ab: { writable: true }, permissionMode: full }), 'ab:write')
  assert.equal(runtimeKey({ ab: { writable: false, lean: true }, permissionMode: full }), 'ab:lean')
  assert.equal(pool.runtimes.get('ab:write').mode, full)
  assert.deepEqual(pool.runtimes.get('ab:write').patches, ['write'])
  assert.equal(pool.runtimes.get('ab:lean').mode, 'read-only')
  assert.equal(pool.runtimes.get('ab:research').mode, 'read-only')
})

for (const delegate of [false, true]) {
  test(`AB implementation alone is full access (delegate=${delegate})`, async (t) => {
    const f = await setup(t)
    assert.ok(f.calls.every((call) => call.permissionMode === 'read-only'))
    await f.manager.approve({ id: f.run.id, revision: 1, delegate, review: true })
    if (delegate) {
      assert.equal(f.calls.at(-1).permissionMode, 'read-only')
      await f.finish('instructions')
    }
    assert.equal(f.calls.at(-1).permissionMode, full)
    await f.finish(delegate ? 'implementer' : 'direct')
    if (delegate) {
      assert.equal(f.calls.at(-1).permissionMode, 'read-only')
      await f.finish('reviewer')
    }
    assert.equal(f.run.phase, delegate ? 'reviewed' : 'completed')
  })
}

test('AB blocked implementation retries in place, still full access, without replaying consultation', async (t) => {
  const f = await setup(t)
  await f.manager.approve({ id: f.run.id, revision: 1, delegate: false, review: false })
  const previous = f.run.jobs.at(-1)
  await f.finish('direct', { denials: ['pwsh: repair'] })
  assert.equal(f.run.phase, 'needs-attention')
  assert.equal(f.run.retryJobId, previous.id)
  const count = f.calls.length
  await f.manager.retry({ id: f.run.id, jobId: previous.id })
  assert.equal(f.calls.length, count + 1)
  assert.equal(f.calls.at(-1).permissionMode, full)
  assert.match(f.calls.at(-1).text, /repair/)
  assert.equal(f.run.warning, undefined)
  await assert.rejects(f.manager.retry({ id: f.run.id, jobId: previous.id }))
})

test('AB legacy needs-attention state gains a retry and drops the old permission setting on load', async (t) => {
  const f = await setup(t)
  await f.manager.approve({ id: f.run.id, revision: 1, delegate: false, review: false })
  const previous = f.run.jobs.at(-1)
  await f.finish('direct', { denials: ['pwsh: blocked'] })
  const saved = JSON.parse(await fs.readFile(path.join(f.dir, 'state.json'), 'utf8'))
  saved.runs[0].config.permissionMode = 'workspace-write'
  delete saved.runs[0].retryJobId
  await fs.writeFile(path.join(f.dir, 'state.json'), JSON.stringify(saved))
  const count = f.calls.length
  const restored = await new AbManager({ dir: f.dir, runner: f.runner }).load()
  const run = restored.require(f.run.id)
  assert.equal('permissionMode' in run.config, false)
  assert.equal(run.retryJobId, previous.id)
  assert.equal(f.calls.length, count)
  await restored.retry({ id: run.id, jobId: previous.id })
  assert.equal(f.calls.at(-1).permissionMode, full)
})

test('AB adapter creates the implementation session unsandboxed and consultation read-only', async () => {
  const created = []
  const threads = Object.assign(new EventEmitter(), {
    create: async (input) => { created.push(input); return { id: `T${created.length}` } }, send: async () => {},
  })
  const runner = new AbRunner({ threads, agents: new EventEmitter() })
  for (const writable of [false, true]) {
    await runner.start({ runId: 'R', jobId: 'J', workspace: '/project', model: 'model', text: 'task', instructions: '', writable })
  }
  assert.equal(created[0].permissionMode, 'read-only')
  assert.equal(created[1].permissionMode, full)
})

test('AB records actual Windows provisioning failure even without an approval request', async (t) => {
  const f = await fixture(t)
  const runner = new AbRunner({ threads: f.manager, agents: new EventEmitter() })
  const handle = await runner.start({ runId: 'R', jobId: 'J', workspace: f.base, model: '["test","model"]',
    text: 'implement', instructions: 'test', writable: true })
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

test('AB provisioning blocker gets attention and a retry even when the model reports completion', async (t) => {
  const f = await setup(t)
  await f.manager.approve({ id: f.run.id, revision: 1, delegate: false, review: false })
  await f.finish('direct', { blockers: ['SetNamedSecurityInfoW failed (Win32 5)'] })
  assert.equal(f.run.phase, 'needs-attention')
  assert.equal(f.run.retryJobId, f.run.jobs.at(-1).id)
  assert.match(f.run.jobs.at(-1).report, /実行環境の権限エラー/)
  await f.manager.retry({ id: f.run.id, jobId: f.run.retryJobId })
  assert.match(f.calls.at(-1).text, /previousBlockers/)
})
