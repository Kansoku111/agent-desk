import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { workflowEffort, workflowEffortSupported, workflowLevels, workflowOptions } from '../shared/workflow-effort.js'
import { AbManager } from '../server/ab.js'
import { fixture } from './helpers/thread-manager.js'
import { Catalog } from '../server/catalog.js'

const catalog = { effortsByModel: { medium: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }], low: [{ value: 'low' }], high: [{ value: 'high' }], no: [] } }
test('workflow defaults distinguish known levels, no reasoning and unknown capabilities', () => {
  for (const [model, expected] of [['medium', 'medium'], ['low', 'low'], ['high', 'high'], ['no', ''], ['unknown', 'medium'], ['claude:opus', 'medium']]) {
    const levels = workflowLevels(catalog, model)
    const resolved = workflowEffort('', levels)
    assert.equal(resolved, expected)
    assert.ok(!resolved || workflowOptions(resolved, levels).includes(resolved))
  }
  assert.equal(workflowEffort('high', ['low', 'medium', 'high']), 'high')
  assert.equal(workflowEffort('max', ['low', 'medium']), 'max', 'do not rewrite saved explicit preferences')
  assert.equal(workflowEffort('max', ['low', 'medium'], true), 'medium', 'model change uses the nearest supported choice')
  assert.deepEqual(workflowOptions('', []), [])
  assert.deepEqual(workflowOptions('medium', undefined), ['medium'])
})

test('workflowEffortSupported allows saved efforts only where a strict run can apply them', () => {
  assert.equal(workflowEffortSupported('high', undefined), true, 'unknown capabilities never block')
  assert.equal(workflowEffortSupported('high', []), false, 'a known level-less model refuses an explicit effort')
  assert.equal(workflowEffortSupported('', []), true, 'level-less models start with no effort')
  assert.equal(workflowEffortSupported('', ['low', 'medium']), false, 'a model with levels needs an explicit choice')
  assert.equal(workflowEffortSupported('high', ['low', 'medium']), false)
  assert.equal(workflowEffortSupported('medium', ['low', 'medium']), true)
})

test('AB new runs materialize defaults without rewriting preferences or old runs and retry jobs', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-effort-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const runner = Object.assign(new EventEmitter(), { async start(input) { calls.push(input); return { id: input.jobId } }, async stop() {} })
  const options = { dir, runner, catalog: () => catalog }
  const manager = await new AbManager(options).load()
  const config = { a: 'medium', b: 'low', leader: 'no', implementer: 'claude:sonnet', efforts: { a: '', b: '', leader: '', implementer: 'high' } }
  await manager.configure(config)
  const { run } = await manager.create({ workspace: dir, text: 'new', config })
  assert.deepEqual(run.config.efforts, { a: 'medium', b: 'low', leader: '', implementer: 'high' })
  assert.deepEqual(calls.map(({ effort }) => effort), ['medium', 'low'])
  assert.ok(calls.every(({ strictEffort }) => strictEffort))
  assert.deepEqual(manager.config.efforts, config.efforts)
  assert.deepEqual(config.efforts, { a: '', b: '', leader: '', implementer: 'high' })
  // Simulate a legacy interrupted writer with an unspecified effort.
  const old = { ...run, id: 'old', phase: 'error', strictEffort: undefined, config: { ...config, delegate: false }, approvedPlan: 'approved', approvedRevision: 0, revision: 0,
    retryJobId: 'writer', jobs: [{ id: 'writer', role: 'direct', model: 'medium', effort: '', text: 'original', instructions: 'original', writable: true, status: 'error' }] }
  manager.runs.set(old.id, old)
  await manager.save()
  const restored = await new AbManager(options).load()
  assert.deepEqual(restored.require('old').config.efforts, config.efforts)
  assert.equal(restored.require('old').jobs[0].effort, '')
  await restored.retry({ id: 'old', jobId: 'writer' })
  assert.equal(calls.at(-1).effort, '')
  assert.equal(calls.at(-1).strictEffort, false)
})

for (const mode of ['ab', 'eco']) for (const scenario of ['medium', 'unsupported', 'unacknowledged', 'no-reasoning']) {
  test(`${mode} runtime validates exact resolved effort before prompt: ${scenario}`, async (t) => {
    const f = await fixture(t)
    const model = '["test","model"]'
    const efforts = scenario === 'unsupported' ? ['low'] : scenario === 'no-reasoning' ? [] : ['low', 'medium', 'high']
    const options = [{ id: 'model', currentValue: model, options: [{ value: model }] }, { id: 'reasoning_effort', currentValue: 'low', options: efforts.map((value) => ({ value })) }]
    const original = f.runtime.newSession.bind(f.runtime)
    f.runtime.newSession = async () => ({ ...await original(), configOptions: options })
    const applied = []
    f.runtime.setOption = async (_id, key, value) => {
      applied.push({ key, value })
      if (scenario !== 'unacknowledged') options.find((entry) => entry.id === key).currentValue = value
      return options
    }
    const effort = scenario === 'no-reasoning' ? '' : 'medium'
    const metadata = mode === 'ab' ? { ab: { strictEffort: true } } : { team: { id: 'eco', strictEffort: true } }
    const thread = await f.manager.create({ workspace: f.base, model, effort, ...metadata })
    const done = once(f.manager, 'turn-finished')
    await f.manager.send(thread.id, { text: 'request' })
    const succeeds = ['medium', 'no-reasoning'].includes(scenario)
    if (succeeds) { await f.started.promise; f.finish.resolve() }
    assert.equal((await done)[0].status, succeeds ? 'done' : 'error')
    assert.equal(f.calls.prompts.length, succeeds ? 1 : 0)
    assert.deepEqual(applied, ['medium', 'unacknowledged'].includes(scenario) ? [{ key: 'reasoning_effort', value: 'medium' }] : [])
    assert.equal(f.manager.threads.get(thread.id).effort, effort)
  })
}

test('catalog remembers empty live capabilities instead of retaining stale reasoning levels', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-catalog-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const value = '["local-llm","test"]'
  const cache = new Catalog(path.join(dir, 'catalog.json'))
  const model = { id: 'model', currentValue: value, options: [{ value }] }
  cache.learn([model, { id: 'reasoning_effort', options: [{ value: 'medium' }] }])
  cache.learn([model])
  assert.deepEqual(cache.snapshot().effortsByModel[value], [])
  assert.equal(workflowEffort('', workflowLevels(cache.snapshot(), value)), '')
  // Let the catalog's async writes settle before temporary-directory cleanup.
  await new Promise((resolve) => setTimeout(resolve, 50))
})
