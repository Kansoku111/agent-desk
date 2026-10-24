import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch } from '../server/dsh-config.js'
import { installedModels, OpenCodeGoModels, parseModelIds } from '../server/opencode-go-models.js'

const list = (...ids) => Response.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) })

async function setup(t, reply) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocg-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const models = await new OpenCodeGoModels({
    file: path.join(dir, 'models.json'),
    installed: async () => new Map([['glm-5.3', 'GLM-5.3'], ['kimi-k3', 'Kimi K3'], ['space-bunny', 'Space Bunny']]),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return reply() },
  }).load()
  return { models, calls, file: path.join(dir, 'models.json') }
}

test('the served list is the catalog models the service still lists', async (t) => {
  const { models, calls, file } = await setup(t, () => list('glm-5.3', 'kimi-k3', 'beam-free'))
  assert.equal(models.served, null)
  assert.equal(await models.refresh('oc-key'), true)
  assert.deepEqual(models.served, ['glm-5.3', 'kimi-k3'])
  assert.deepEqual(models.hidden, [{ id: 'space-bunny', name: 'Space Bunny' }])
  assert.equal(calls[0].options.headers.authorization, 'Bearer oc-key')
  assert.equal(calls[0].options.redirect, 'error')
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).ids, ['glm-5.3', 'kimi-k3', 'beam-free'])
})

test('a fresh list is not read again, and a failed read keeps the previous one', async (t) => {
  let reply = () => list('glm-5.3')
  const { models, calls } = await setup(t, () => reply())
  await models.refresh('oc-key')
  assert.equal(await models.refresh('oc-key'), false)
  assert.equal(calls.length, 1)
  reply = () => new Response('nope', { status: 500 })
  assert.equal(models.failed, false)
  assert.equal(await models.refresh('oc-key', { maxAgeMs: 0 }), false)
  assert.equal(models.failed, true)
  assert.deepEqual(models.served, ['glm-5.3'])
  assert.equal(await models.refresh(null, { maxAgeMs: 0 }), false)
})

test('a nonoverlapping response preserves the last verified list in memory and on disk', async (t) => {
  let reply = () => list('glm-5.3')
  const { models, file } = await setup(t, () => reply())
  await models.refresh('oc-key')
  const saved = await fs.readFile(file, 'utf8')
  reply = () => list('something-else')
  assert.equal(await models.refresh('oc-key', { maxAgeMs: 0 }), false)
  assert.deepEqual(models.served, ['glm-5.3'])
  assert.equal(models.failed, true)
  assert.equal(await fs.readFile(file, 'utf8'), saved)
  assert.equal(parseModelIds({ data: [] }), null)
  assert.equal(parseModelIds({}), null)
  assert.equal(parseModelIds({ data: [{ id: 'glm-5.3' }, {}] }), null)
})

test('an initial nonoverlapping response is an error and is not saved as a successful check', async (t) => {
  const { models } = await setup(t, () => list('something-else'))
  await models.refresh('oc-key')
  assert.equal(models.served, null)
  assert.equal(models.failed, true)
  assert.equal(models.checkedAt, null)
})

test('overlapping checks serialize their requests so an old result cannot overwrite a newer one', async (t) => {
  const pending = []
  const { models, calls, file } = await setup(t, () => new Promise((resolve) => pending.push(resolve)))
  const first = models.refresh('oc-key', { maxAgeMs: 0 })
  const second = models.refresh('oc-key', { maxAgeMs: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1)
  pending[0](list('glm-5.3', 'space-bunny'))
  await first
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2)
  pending[1](list('glm-5.3'))
  await second
  assert.deepEqual(models.served, ['glm-5.3'])
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).ids, ['glm-5.3'])
})

test('an invalid cached response is not treated as verified on startup', async (t) => {
  const { file } = await setup(t, () => list('glm-5.3'))
  await fs.writeFile(file, JSON.stringify({ ids: ['unknown'], fetchedAt: Date.now() }))
  const models = await new OpenCodeGoModels({ file, installed: async () => new Map([['glm-5.3', 'GLM']]) }).load()
  assert.equal(models.failed, true)
  assert.equal(models.checkedAt, null)
})

test('the saved list is used at start before any read', async (t) => {
  const { models, file } = await setup(t, () => list('kimi-k3'))
  await models.refresh('oc-key')
  const again = await new OpenCodeGoModels({ file, installed: async () => new Map([['kimi-k3', 'Kimi K3'], ['glm-5.3', 'GLM-5.3']]) }).load()
  assert.deepEqual(again.served, ['kimi-k3'])
})

test('fresh service ids are matched again when model definitions are updated', async (t) => {
  const { models, calls } = await setup(t, () => list('glm-5.3', 'beam-free'))
  await models.refresh('oc-key')
  assert.deepEqual(models.missing, ['beam-free'])
  models.installed = async () => new Map([['glm-5.3', 'GLM-5.3'], ['beam-free', 'Beam Free']])
  assert.equal(await models.refresh('oc-key'), true)
  assert.equal(calls.length, 1)
  assert.deepEqual(models.served, ['beam-free', 'glm-5.3'])
  assert.deepEqual(models.missing, [])
})

test('homePatch lists the served OpenCode Go models', () => {
  const route = (options) => YAML.parse(homePatch({ opencodeGo: true, ...options }))[0].config.providers['opencode-go']
  assert.deepEqual(route({ opencodeGoModels: ['glm-5.3'] }), { apiKeyEnv: 'OPENCODE_API_KEY', models: [{ id: 'glm-5.3' }] })
  assert.deepEqual(route({ opencodeGoModels: null }), { apiKeyEnv: 'OPENCODE_API_KEY' })
})

test('the installed catalog is readable', async () => {
  const models = await installedModels()
  assert.equal(models.get('glm-5.3'), 'GLM-5.3')
})

test('the shared model check also reads OpenCode Go', async () => {
  const { createModelHandlers } = await import('../server/rpc-handlers-models.js')
  const order = []
  const handlers = createModelHandlers({
    threads: { busy: false },
    updates: {},
    modelUpdater: { check: async () => order.push('pi-ai') },
    modelUpdateState: () => ({ opencodeGo: null }),
    refreshCodexModels: async () => order.push('codex'),
    checkOpenCodeGoModels: async () => order.push('opencode-go'),
  })
  await handlers['modelUpdate.check']()
  assert.deepEqual(order, ['codex', 'pi-ai', 'opencode-go'])
})