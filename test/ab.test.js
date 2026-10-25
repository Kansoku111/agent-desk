import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AbManager, abConfig } from '../server/ab.js'
import { createAbHandlers } from '../server/rpc-handlers-ab.js'

async function setup(t, config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-ab-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const runner = new EventEmitter()
  runner.calls = []
  runner.start = async (input) => { runner.calls.push(input); return input.jobId }
  runner.stop = async () => {}
  const manager = await new AbManager({ dir, runner, validateModel: (value) => { if (!value) throw new Error('missing model') } }).load()
  const { run } = await manager.create({ workspace: dir, text: ' 生の相談\nそのまま ', config: { a: 'A', b: 'B', leader: 'L', implementer: 'I', ...config } })
  const finish = async (role, text = `${role} report`, status = 'completed') => {
    const job = manager.require(run.id).jobs.filter((entry) => entry.role === role).at(-1)
    await manager.lock(run.id, () => manager.finished({ runId: run.id, jobId: job.id, status, text }))
  }
  return { dir, runner, manager, id: run.id, finish }
}

test('AB totals every stage and failed attempt once, including after restart', async (t) => {
  const { dir, runner, manager, id } = await setup(t)
  const finishScore = async (role, points, status = 'completed') => {
    const job = manager.require(id).jobs.findLast((entry) => entry.role === role)
    await manager.lock(id, () => manager.finished({ runId: id, jobId: job.id, status, text: `${role} report`,
      score: { points, priced: 1, unpriced: 0 } }))
    return job
  }
  await finishScore('a', 1); await finishScore('b', 2); await finishScore('leader', 3)
  await manager.approve({ id, revision: 1, delegate: true, review: true })
  await finishScore('instructions', 4)
  const failed = await finishScore('implementer', 5, 'error')
  await manager.retry({ id, jobId: failed.id })
  await finishScore('implementer', 6)
  const review = await finishScore('reviewer', 7)
  assert.equal(manager.summary(manager.require(id)).score.points, 28)
  await manager.finished({ runId: id, jobId: review.id, status: 'completed', text: 'duplicate', score: review.score })
  assert.equal(manager.summary(manager.require(id)).score.points, 28)
  const restored = await new AbManager({ dir, runner }).load()
  assert.equal(restored.summary(restored.require(id)).score.points, 28)
  assert.equal(restored.require(id).phase, 'reviewed')
})

test('AB keeps late consumption after stop without restarting a stage', async (t) => {
  const { manager, id, runner } = await setup(t)
  await manager.stop({ id })
  const job = manager.require(id).jobs[0]
  await manager.finished({ runId: id, jobId: job.id, status: 'completed', text: 'late', score: { points: 2, priced: 1, unpriced: 0 } })
  const view = manager.summary(manager.require(id))
  assert.deepEqual(view.score, { points: 2, priced: 1, unpriced: 1 })
  assert.equal(view.phase, 'stopped')
  assert.equal(runner.calls.length, 2)
})

test('AB sends exact original independently and waits for BOTH reports', async (t) => {
  const { runner, manager, id, finish } = await setup(t)
  assert.equal(runner.calls.length, 2)
  assert.equal(runner.calls[0].text, ' 生の相談\nそのまま ')
  assert.equal(runner.calls[0].text, runner.calls[1].text)
  assert.ok(runner.calls.every((call) => !call.writable))
  await finish('b')
  assert.equal(runner.calls.length, 2)
  await finish('a')
  assert.equal(runner.calls.length, 3)
  assert.equal(runner.calls[2].model, 'L')
  assert.match(runner.calls[2].text, /a report/)
  assert.match(runner.calls[2].text, /b report/)
  await finish('leader', 'plan')
  assert.equal(manager.require(id).phase, 'awaiting-approval')
  assert.equal(runner.calls.length, 3)
})

test('AB approval is revision-bound and duplicate approval never launches twice', async (t) => {
  const { runner, manager, id, finish } = await setup(t)
  await finish('a'); await finish('b'); await finish('leader')
  await assert.rejects(manager.approve({ id, revision: 0, delegate: true, review: true }))
  await manager.approve({ id, revision: 1, delegate: true, review: true })
  assert.equal(runner.calls.at(-1).writable, false)
  assert.equal(runner.calls.at(-1).model, 'L')
  await assert.rejects(manager.approve({ id, revision: 1, delegate: true, review: true }))
  await finish('instructions', 'bounded implementation instructions')
  assert.equal(runner.calls.at(-1).model, 'I')
  assert.equal(runner.calls.at(-1).writable, true)
  assert.equal(runner.calls.at(-1).text, 'bounded implementation instructions')
  await finish('implementer')
  assert.equal(runner.calls.at(-1).model, 'L')
  assert.equal(runner.calls.at(-1).writable, false)
  await finish('reviewer')
  assert.equal(manager.require(id).phase, 'reviewed')
})

test('AB review OFF never wakes leader after implementation', async (t) => {
  const { runner, manager, id, finish } = await setup(t)
  await finish('a'); await finish('b'); await finish('leader')
  await manager.approve({ id, revision: 1, delegate: true, review: false })
  await finish('instructions')
  const count = runner.calls.length
  await finish('implementer')
  assert.equal(runner.calls.length, count)
  assert.equal(manager.require(id).phase, 'completed')
})

test('AB direct implementation uses leader model without delegation or extra review', async (t) => {
  const { runner, manager, id, finish } = await setup(t, { delegate: false, implementer: '' })
  await finish('a'); await finish('b'); await finish('leader')
  await manager.approve({ id, revision: 1, delegate: false, review: true })
  assert.equal(runner.calls.at(-1).model, 'L')
  assert.equal(runner.calls.at(-1).writable, true)
  await finish('direct')
  assert.equal(runner.calls.length, 4)
  assert.equal(manager.require(id).phase, 'completed')
})

test('AB revisions cannot implement until approved again', async (t) => {
  const { manager, id, finish } = await setup(t)
  await finish('a'); await finish('b'); await finish('leader')
  await manager.revise({ id, text: 'change constraint' })
  await assert.rejects(manager.approve({ id, revision: 1, delegate: true, review: true }))
  await finish('leader', 'revised plan')
  assert.equal(manager.require(id).revision, 2)
  await assert.rejects(manager.approve({ id, revision: 1, delegate: true, review: true }))
})

test('AB failed or stopped consultation cannot be mistaken for two successful reports', async (t) => {
  const { runner, manager, id, finish } = await setup(t)
  await finish('a', '', 'error')
  await finish('b')
  assert.equal(runner.calls.length, 2)
  assert.equal(manager.require(id).phase, 'error')
  await assert.rejects(manager.approve({ id, revision: 0, delegate: true, review: true }))
  await manager.stop({ id })
  assert.equal(manager.require(id).phase, 'stopped')
})

test('AB restart never resumes interrupted implementation automatically', async (t) => {
  const { dir, runner, manager, id, finish } = await setup(t)
  await finish('a'); await finish('b'); await finish('leader')
  await manager.approve({ id, revision: 1, delegate: false, review: false })
  const restored = await new AbManager({ dir, runner }).load()
  assert.equal(restored.require(id).phase, 'interrupted')
  assert.equal(restored.require(id).jobs.at(-1).status, 'interrupted')
  assert.equal(runner.calls.length, 4)
})

test('AB RPC uses runId rather than transport id and rejects duplicate approvals', async (t) => {
  const { manager, id, finish } = await setup(t)
  await finish('a'); await finish('b'); await finish('leader')
  const handlers = createAbHandlers(manager)
  await handlers['ab.approve']({ id: 42, runId: id, revision: 1, delegate: false, review: false })
  assert.equal(manager.require(id).phase, 'implementing')
  await assert.rejects(handlers['ab.approve']({ id: 43, runId: id, revision: 1, delegate: false, review: false }))
})

test('AB stopped reports cannot start judgment and deletion removes owned sessions only', async (t) => {
  const { runner, manager, id, finish } = await setup(t)
  const removed = []
  runner.remove = async (handle) => removed.push(handle)
  await manager.stop({ id })
  await finish('a'); await finish('b')
  assert.equal(runner.calls.length, 2)
  await manager.remove({ id })
  assert.equal(manager.list().length, 0)
  assert.equal(removed.length, 2)
})

test('AB settings and pending approval persist without waking models', async (t) => {
  const { dir, runner, manager, id, finish } = await setup(t)
  await manager.configure({ a: 'saved-A', b: 'saved-B', lean: false, review: false })
  await finish('a'); await finish('b'); await finish('leader')
  const count = runner.calls.length
  const restored = await new AbManager({ dir, runner }).load()
  assert.equal(restored.config.a, 'saved-A')
  assert.equal(restored.config.lean, false)
  assert.equal(restored.require(id).phase, 'awaiting-approval')
  assert.equal(runner.calls.length, count)
})

test('AB config validates boolean switches', () => {
  assert.throws(() => abConfig({ lean: 'false' }))
  assert.throws(() => abConfig({ leader: {} }))
  assert.equal(abConfig().lean, true)
})
