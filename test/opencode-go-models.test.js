import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch } from '../server/dsh-config.js'
import { installedModelIds, OpenCodeGoModels, parseModelIds } from '../server/opencode-go-models.js'

const list = (...ids) => Response.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) })

async function setup(t, reply) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocg-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const models = await new OpenCodeGoModels({
    file: path.join(dir, 'models.json'),
    installed: async () => new Set(['glm-5.3', 'kimi-k3', 'space-bunny']),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return reply() },
  }).load()
  return { models, calls, file: path.join(dir, 'models.json') }
}

test('the served list is the catalog models the service still lists', async (t) => {
  const { models, calls, file } = await setup(t, () => list('glm-5.3', 'kimi-k3', 'beam-free'))
  assert.equal(models.served, null)
  assert.equal(await models.refresh('oc-key'), true)
  assert.deepEqual(models.served, ['glm-5.3', 'kimi-k3'])
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
  assert.equal(await models.refresh('oc-key', { maxAgeMs: 0 }), false)
  assert.deepEqual(models.served, ['glm-5.3'])
  assert.equal(await models.refresh(null, { maxAgeMs: 0 }), false)
})

test('a list that shares nothing with the catalog serves the whole catalog', async (t) => {
  const { models } = await setup(t, () => list('something-else'))
  await models.refresh('oc-key')
  assert.equal(models.served, null)
  assert.equal(parseModelIds({ data: [] }), null)
  assert.equal(parseModelIds({}), null)
})

test('the saved list is used at start before any read', async (t) => {
  const { models, file } = await setup(t, () => list('kimi-k3'))
  await models.refresh('oc-key')
  const again = await new OpenCodeGoModels({ file, installed: async () => new Set(['kimi-k3', 'glm-5.3']) }).load()
  assert.deepEqual(again.served, ['kimi-k3'])
})

test('homePatch lists the served OpenCode Go models', () => {
  const route = (options) => YAML.parse(homePatch({ opencodeGo: true, ...options }))[0].config.providers['opencode-go']
  assert.deepEqual(route({ opencodeGoModels: ['glm-5.3'] }), { apiKeyEnv: 'OPENCODE_API_KEY', models: [{ id: 'glm-5.3' }] })
  assert.deepEqual(route({ opencodeGoModels: null }), { apiKeyEnv: 'OPENCODE_API_KEY' })
})

test('the installed catalog is readable', async () => {
  const ids = await installedModelIds()
  assert.ok(ids.has('glm-5.3'))
})
