import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { catalogDataDirs } from '../server/model-catalog.js'
import { mergeOpenCodeCatalog, openCodeModels } from '../server/opencode-go-catalog.js'
import { isOpenCodeCatalog } from '../server/opencode-catalog-hook.js'

const base = {
  'openai-completions': { 'chat:glm-5.3': {
    type: 'chat', id: 'glm-5.3', name: 'GLM-5.3', provider: 'opencode-go', api: 'openai-completions',
    baseUrl: 'https://opencode.ai/inference/go/v1', input: ['text'], reasoning: true,
    cost: { input: 1, output: 2 }, contextWindow: 200000, maxTokens: 32000,
  } },
}
const extra = (id, fields = {}) => ({ ...base['openai-completions']['chat:glm-5.3'], id, name: id, ...fields })

test('OpenCode overlay preserves protocols, layouts and shipped models without mutating its input', () => {
  const additions = { 'openai-completions': {
    'beam-free': extra('beam-free'),
    'glm-5.3': extra('glm-5.3', { name: 'must not overwrite' }),
  } }
  const merged = mergeOpenCodeCatalog(base, additions)
  assert.equal(merged['openai-completions']['chat:beam-free'].api, 'openai-completions')
  assert.equal(merged['openai-completions']['chat:glm-5.3'].name, 'GLM-5.3')
  assert.equal(base['openai-completions']['chat:beam-free'], undefined)
  assert.equal(openCodeModels(merged).length, 2)
  const untyped = { 'openai-completions': { 'glm-5.3': { ...extra('glm-5.3'), type: undefined } } }
  assert.ok(mergeOpenCodeCatalog(untyped, additions)['openai-completions']['beam-free'])
})

test('OpenCode overlay refuses unsupported protocols, URLs, model types and incomplete definitions', () => {
  const invalid = {
    evil: extra('evil', { baseUrl: 'https://evil.example' }),
    wrong: extra('wrong', { provider: 'openai' }),
    image: extra('image', { type: 'image' }),
    broken: extra('broken', { contextWindow: -1 }),
    api: extra('api', { api: 'openai-responses' }),
    input: extra('input', { input: ['audio'] }),
  }
  assert.deepEqual(mergeOpenCodeCatalog(base, {
    'openai-completions': invalid,
    'new-api': { new: extra('new', { api: 'new-api' }) },
  }), base)
})

test('the JSON loader targets only OpenCode catalog data', () => {
  assert.equal(isOpenCodeCatalog('file:///x/@earendil-works/pi-ai/dist/providers/data/opencode-go.json'), true)
  assert.equal(isOpenCodeCatalog('file:///x/@earendil-works/pi-ai/dist/providers/data/anthropic.json'), false)
  assert.equal(isOpenCodeCatalog('https://example.com/@earendil-works/pi-ai/dist/providers/data/opencode-go.json'), false)
})

test('the real nested pi-ai sees new definitions without any installed file changes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-opencode-overlay-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const [dataDir] = catalogDataDirs()
  const originalFile = path.join(dataDir, 'opencode-go.json')
  const original = await fs.readFile(originalFile, 'utf8')
  const template = openCodeModels(JSON.parse(original)).find((model) => model.api === 'openai-completions')
  const overlay = path.join(dir, 'overlay.json')
  await fs.writeFile(overlay, JSON.stringify({ 'openai-completions': {
    'test-new-model': { ...template, id: 'test-new-model', name: 'Test New Model' },
  } }))
  const moduleUrl = pathToFileURL(path.join(dataDir, '..', 'opencode-go.models.js')).href
  const hookUrl = new URL('../server/opencode-catalog-hook.js', import.meta.url).href
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', hookUrl, '--input-type=module', '-e', `
    const { OPENCODE_GO_MODELS } = await import(${JSON.stringify(moduleUrl)});
    const model = Object.values(OPENCODE_GO_MODELS).find(model => model.id === 'test-new-model');
    console.log(JSON.stringify(model));
  `], { env: { ...process.env, AGENT_DESK_OPENCODE_CATALOG: overlay }, timeout: 15000 })
  const loaded = JSON.parse(stdout)
  assert.equal(loaded.id, 'test-new-model')
  assert.equal(loaded.api, template.api)
  assert.equal(loaded.baseUrl, template.baseUrl)
  assert.equal(await fs.readFile(originalFile, 'utf8'), original)
})
