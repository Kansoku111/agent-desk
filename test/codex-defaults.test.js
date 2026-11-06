import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexRunner } from '../server/codex-runner.js'
import { createCodexHandlers } from '../server/rpc-handlers-codex.js'
import { createSettingsService, DEFAULT_SETTINGS, migrateSettings } from '../server/settings.js'
import { readJson, writeJson } from '../server/json-file.js'

const models = [
  { model: 'alpha', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
  { model: 'beta', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
]
class FakeWorkServer extends EventEmitter {
  constructor(available = models) { super(); this.available = available }
  async use(fn) { return fn() }
  async rawRequest(method) {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'test@example.test' } }
    if (method === 'model/list') return { data: this.available }
    throw new Error(`Unexpected model execution: ${method}`)
  }
  async stop() {}
}
const choice = task => ({ model: task.model, effort: task.effort, permissionMode: task.permissionMode })
const dsh = settings => ({ model: settings.defaultModel, effort: settings.defaultEffort, permissionMode: settings.defaultPermissionMode })

async function setup(t, saved = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-defaults-'))
  const file = path.join(dir, 'settings.json')
  await writeJson(file, saved)
  const runners = []
  t.after(async () => {
    for (const runner of runners) await runner.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  })
  async function client(available = models) {
    let live = migrateSettings(await readJson(file, {}))
    const publications = []
    const service = createSettingsService({
      getSettings: () => live,
      saveSettings: candidate => writeJson(file, candidate),
      publishSettings: candidate => { live = candidate; publications.push(structuredClone(candidate)) },
    })
    const runner = await new CodexRunner({ home: dir, attachmentsDir: dir, server: new FakeWorkServer(available) }).load()
    runners.push(runner)
    const handlers = createCodexHandlers({ codex: runner, teams: { guardExecution() {} }, paths: { myPc: 'not-this-workspace' }, getSettings: () => live, mutateSettings: service.mutate })
    return { runner, handlers, settings: () => live, publications }
  }
  return { dir, file, client, disk: async () => migrateSettings(await readJson(file, {})) }
}
const create = (client, workspace, extra = {}) => client.handlers['codex.task.create']({ workspace, ...extra }).then(result => result.task)
const update = (client, task, extra) => client.handlers['codex.task.update']({ taskId: task.id, ...extra }).then(result => result.task)

test('legacy settings seed actual choices and persist updates across separate service, runner and RPC clients', async t => {
  const env = await setup(t, { defaultModel: 'dsh-model', defaultEffort: 'high', defaultPermissionMode: 'read-only' })
  const a = await env.client()
  assert.equal(DEFAULT_SETTINGS.codexDefaults, null)
  assert.equal(a.settings().codexDefaults, null)
  const first = await create(a, env.dir)
  assert.deepEqual(choice(first), { model: 'alpha', effort: 'low', permissionMode: 'workspace-write' })
  assert.deepEqual(a.settings().codexDefaults, choice(first))
  await update(a, first, { model: 'beta', effort: 'high', permissionMode: 'danger-full-access' })
  const expected = { model: 'beta', effort: 'high', permissionMode: 'danger-full-access' }
  assert.deepEqual((await env.disk()).codexDefaults, expected)
  assert.deepEqual(dsh(a.settings()), { model: 'dsh-model', effort: 'high', permissionMode: 'read-only' })
  assert.ok(a.publications.some(settings => settings.codexDefaults?.model === 'beta'))
  const phone = await env.client()
  assert.deepEqual(choice(await create(phone, env.dir)), expected)
  await update(phone, first, { permissionMode: 'read-only' })
  const restarted = await env.client()
  assert.deepEqual(choice(await create(restarted, env.dir)), { ...expected, permissionMode: 'read-only' })
  assert.deepEqual(dsh(await env.disk()), { model: 'dsh-model', effort: 'high', permissionMode: 'read-only' })
})

test('explicit create stores only chosen fields and model changes use the new model default effort', async t => {
  const env = await setup(t)
  const c = await env.client()
  const original = await create(c, env.dir, { model: 'alpha', effort: 'high', permissionMode: 'read-only' })
  assert.deepEqual(choice(original), { model: 'alpha', effort: 'high', permissionMode: 'read-only' })
  const changed = await create(c, env.dir, { model: 'beta' })
  assert.deepEqual(choice(changed), { model: 'beta', effort: 'medium', permissionMode: 'read-only' })
  assert.deepEqual((await env.disk()).codexDefaults, choice(changed))
  const updated = await update(c, changed, { model: 'alpha', effort: 'low' })
  assert.deepEqual(choice(updated), { model: 'alpha', effort: 'low', permissionMode: 'read-only' })
  assert.deepEqual((await env.disk()).codexDefaults, choice(updated))
  await create(c, env.dir, { permissionMode: 'danger-full-access' })
  assert.deepEqual((await env.disk()).codexDefaults, { model: 'alpha', effort: 'low', permissionMode: 'danger-full-access' })
})

test('metadata and AB/team selections cannot contaminate normal defaults', async t => {
  const env = await setup(t)
  const c = await env.client()
  const task = await create(c, env.dir, { model: 'alpha', effort: 'low', permissionMode: 'read-only' })
  const expected = choice(task)
  const commits = c.publications.length
  await update(c, task, { title: 'renamed', pinned: true, archived: true })
  assert.equal(c.publications.length, commits)
  const leader = await c.runner.create({ workspace: env.dir, model: 'beta', effort: 'high', permissionMode: 'danger-full-access', team: { id: 'team', role: 'leader' } })
  const child = await c.runner.create({ workspace: env.dir, model: 'alpha', effort: 'high', permissionMode: 'danger-full-access', team: { id: 'team', childId: 'child' } })
  const ab = await c.runner.create({ workspace: env.dir, model: 'beta', effort: 'high', permissionMode: 'danger-full-access', ab: { side: 'a' } })
  await update(c, leader, { title: 'team', pinned: true })
  for (const item of [leader, child, ab]) await assert.rejects(update(c, item, { effort: 'low', permissionMode: 'read-only' }))
  assert.deepEqual((await env.disk()).codexDefaults, expected)
  assert.deepEqual(choice(await create(await env.client(), env.dir)), expected)
})

test('unavailable saved model fails validation without switching or overwriting defaults', async t => {
  const env = await setup(t, { codexDefaults: { model: 'beta', effort: 'high', permissionMode: 'danger-full-access' } })
  const c = await env.client([models[0]])
  await assert.rejects(create(c, env.dir), /モデル/)
  assert.deepEqual((await env.disk()).codexDefaults, { model: 'beta', effort: 'high', permissionMode: 'danger-full-access' })
})

test('an in-flight inherited create does not overwrite a newer explicit selection', async t => {
  const env = await setup(t)
  const c = await env.client()
  const first = await create(c, env.dir)
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const realCreate = c.runner.create.bind(c.runner)
  c.runner.create = async options => { const task = await realCreate(options); entered(); await gate; return task }
  const pending = create(c, env.dir)
  try {
    await started
    await update(c, first, { model: 'beta', effort: 'high', permissionMode: 'danger-full-access' })
  } finally { release() }
  await pending
  assert.deepEqual((await env.disk()).codexDefaults, { model: 'beta', effort: 'high', permissionMode: 'danger-full-access' })
})

test('single-field updates persist the resolved pair without taking unrelated stale values', async t => {
  const env = await setup(t)
  const c = await env.client()
  const old = await create(c, env.dir, { model: 'alpha', effort: 'low', permissionMode: 'read-only' })
  await create(c, env.dir, { model: 'beta', effort: 'medium', permissionMode: 'danger-full-access' })
  await update(c, old, { effort: 'high' })
  const expected = { model: 'alpha', effort: 'high', permissionMode: 'danger-full-access' }
  assert.deepEqual((await env.disk()).codexDefaults, expected)
  await assert.rejects(update(c, old, { effort: 'medium' }), /推論レベル/)
  assert.deepEqual((await env.disk()).codexDefaults, expected)
  await update(c, old, { permissionMode: 'read-only' })
  assert.deepEqual((await env.disk()).codexDefaults, { ...expected, permissionMode: 'read-only' })
})
