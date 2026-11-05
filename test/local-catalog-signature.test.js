import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Catalog } from '../server/catalog.js'

const sig = (ids) => JSON.stringify({ local: { baseURL: ids.length ? 'http://localhost:8080/v1' : null, models: ids.map(id => ({ id })) } })
const options = (ids) => [{ id: 'model', options: [
  { group: 'openai-codex', options: [{ value: '["openai-codex","gpt-6-luna"]', name: 'Luna' }] },
  ...ids.map(id => ({ group: 'local-llm', options: [{ value: JSON.stringify(['local-llm', id]), name: id }] })),
] }]

test('local catalog rejects old runtime after switching servers and repairs an incorrectly signed cache', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-local-catalog-'))
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 30)); await fs.rm(home, { recursive: true, force: true }) })
  const catalog = await new Catalog(path.join(home, 'catalog.json'), sig(['old'])).load()
  catalog.learn(options(['old']))
  catalog.setSignature(sig(['gyro-gyro-s']))
  catalog.learn(options(['old']))
  assert.equal(catalog.stale, true)
  assert.ok(catalog.data.models.some(model => model.id === 'old'))
  catalog.data.signature = sig(['gyro-gyro-s'])
  assert.equal(catalog.stale, true, 'wrongly signed saved catalog must be refreshed on startup')
  catalog.learn(options(['gyro-gyro-s']))
  assert.equal(catalog.stale, false)
  assert.ok(catalog.data.models.some(model => model.id === 'gyro-gyro-s'))
  assert.ok(!catalog.data.models.some(model => model.id === 'old'))
  catalog.learn(options(['old']))
  assert.equal(catalog.stale, false)
  assert.ok(catalog.data.models.some(model => model.id === 'gyro-gyro-s'))
  catalog.setSignature(sig([]))
  catalog.learn(options([]))
  assert.equal(catalog.stale, false)
})
