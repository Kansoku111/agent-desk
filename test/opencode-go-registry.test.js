import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { mergeOpenCodeCatalog, openCodeModels } from '../server/opencode-go-catalog.js'
import { OpenCodeGoModels } from '../server/opencode-go-models.js'
import { OPENCODE_GO_REGISTRY_URL, OpenCodeGoRegistry, registryDefinitions } from '../server/opencode-go-registry.js'

const native = (id = 'known-model', api = 'openai-completions') => ({
  id, name: id, api, provider: 'opencode-go',
  baseUrl: api === 'anthropic-messages' ? 'https://opencode.ai/inference/go' : 'https://opencode.ai/inference/go/v1',
  input: ['text', 'image'], reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' },
  contextWindow: 100000, maxTokens: 10000, cost: { input: 1, output: 2 },
  compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
})
const base = { 'openai-completions': { 'known-model': native() } }
const metadata = (id, fields = {}) => ({
  id, name: id, tool_call: true, reasoning: true,
  reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
  modalities: { input: ['text', 'image', 'video'], output: ['text'] },
  limit: { context: 1000000, output: 100000 }, cost: { input: 0.15, output: 0.6, cache_read: 0.015 },
  ...fields,
})
const body = (...models) => ({ 'opencode-go': {
  id: 'opencode-go', npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/inference/go/openai/v1',
  models: Object.fromEntries(models.map((model) => [model.id, model])),
} })

async function fixture(t, response) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-go-registry-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const file = path.join(dir, 'definitions.json')
  const registry = await new OpenCodeGoRegistry({ file, base: async () => base,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response() },
  }).load()
  return { dir, registry, calls, file }
}

test('exact official ids can fill new or renamed models without a hardcoded alias', () => {
  const previous = { 'openai-completions': { 'new-family-free': native('new-family-free') } }
  const result = registryDefinitions(body(metadata('new-family')), ['new-family'], previous)
  const definition = result['openai-completions']['new-family']
  assert.equal(definition.id, 'new-family')
  assert.equal(definition.contextWindow, 1000000)
  assert.equal(definition.maxTokens, 100000)
  assert.deepEqual(definition.input, ['text', 'image'])
  assert.equal(definition.thinkingLevelMap.high, 'high')
  assert.equal(definition.thinkingLevelMap.medium, null)
  assert.equal(definition.cost.cacheRead, 0.015)
  assert.ok(openCodeModels(mergeOpenCodeCatalog(previous, result)).some((model) => model.id === 'new-family'))
  assert.deepEqual(registryDefinitions(body(metadata('new-family-free')), ['new-family'], previous), {})
})

test('explicit SDK/endpoint pairs select only installed protocols and destinations', () => {
  const routes = [
    ['openai-completions', '@ai-sdk/openai-compatible', 'https://opencode.ai/inference/go/openai/v1'],
    ['openai-responses', '@ai-sdk/openai', 'https://opencode.ai/inference/go/openai/v1'],
    ['anthropic-messages', '@ai-sdk/anthropic', 'https://opencode.ai/inference/go/anthropic/v1'],
    ['google-generative-ai', '@ai-sdk/google', 'https://opencode.ai/inference/go/google/v1beta'],
  ]
  for (const [api, npm, endpoint] of routes) {
    const installed = { [api]: { installed: native('installed', api) } }
    const result = registryDefinitions(body(metadata('new-model', { provider: { npm, api: endpoint } })), ['new-model'], installed)
    const model = result[api]['new-model']
    assert.equal(model.api, api)
    assert.equal(model.baseUrl, installed[api].installed.baseUrl)
  }
  const injected = metadata('injected', { description: 'instructions must not be copied', headers: { authorization: 'secret' }, provider: { api: 'https://evil.example/v1' } })
  assert.deepEqual(registryDefinitions(body(injected), [injected.id], base), {})
  const unknown = metadata('unknown', { provider: { npm: 'untrusted-sdk' } })
  assert.deepEqual(registryDefinitions(body(unknown), [unknown.id], base), {})
  const clean = registryDefinitions(body(metadata('safe', { description: 'untrusted text', headers: { authorization: 'secret' } })), ['safe'], base)
  assert.doesNotMatch(JSON.stringify(clean), /untrusted text|authorization|secret/)
})

test('partial, deprecated, non-agent and mismatched records never become selectable guesses', () => {
  const invalid = [
    metadata('deprecated', { status: 'deprecated' }), metadata('no-tools', { tool_call: false }),
    metadata('limits', { limit: { context: 10, output: 100 } }), metadata('missing-limit', { limit: {} }),
    metadata('no-text', { modalities: { input: ['image'], output: ['text'] } }),
    metadata('price', { cost: { input: -1, output: 1 } }), metadata('special', { type: 'decision' }),
  ]
  assert.deepEqual(registryDefinitions(body(...invalid), invalid.map((model) => model.id), base), {})
  const data = body(metadata('record-id'))
  data['opencode-go'].models['different-id'] = metadata('record-id')
  assert.deepEqual(registryDefinitions(data, ['different-id'], base), {})
  assert.throws(() => registryDefinitions({ data: [] }, ['new-model'], base), /no Go catalog/)
})

test('supplement downloads are anonymous, bounded, cached and forceable', async (t) => {
  const { registry, calls, file } = await fixture(t, () => Response.json(body(metadata('new-model'))))
  assert.equal(await registry.refresh(['known-model', 'new-model']), true)
  assert.equal(calls[0].url, OPENCODE_GO_REGISTRY_URL)
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers, undefined)
  assert.equal(calls[0].options.body, undefined)
  assert.equal(await registry.refresh(['known-model', 'new-model']), false)
  assert.equal(calls.length, 1)
  assert.equal(await registry.refresh(['known-model', 'new-model'], { force: true }), false)
  assert.equal(calls.length, 2)
  const reloaded = await new OpenCodeGoRegistry({ file, base: async () => base }).load()
  assert.ok(reloaded.groups['openai-completions']['new-model'])
  assert.equal(reloaded.lastAdded.models[0].id, 'new-model')
})

test('a new missing id triggers another catalog read even within the cache interval', async (t) => {
  const { registry, calls } = await fixture(t, () => Response.json(body(metadata('model-a'), metadata('model-b'))))
  await registry.refresh(['model-a'])
  assert.equal(registry.groups['openai-completions']['model-b'], undefined)
  await registry.refresh(['model-a', 'model-b'])
  assert.equal(calls.length, 2)
  assert.ok(registry.groups['openai-completions']['model-b'])
})

test('failed, oversized and malformed registry reads preserve last-known definitions on disk', async (t) => {
  let reply = () => Response.json(body(metadata('new-model')))
  const { registry, file } = await fixture(t, () => reply())
  await registry.refresh(['new-model'])
  const saved = await fs.readFile(file, 'utf8')
  for (const bad of [
    () => new Response('failed', { status: 500 }),
    () => Response.json(body(metadata('other')), { headers: { 'content-length': String(20 * 1024 * 1024) } }),
    () => Response.json({ unexpected: true }),
  ]) {
    reply = bad
    assert.equal(await registry.refresh(['new-model'], { force: true }), false)
    assert.equal(registry.failed, true)
    assert.ok(registry.groups['openai-completions']['new-model'])
    assert.equal(await fs.readFile(file, 'utf8'), saved)
  }
})

test('availability reconciliation fills renamed ids but retains visible gaps when metadata is absent', async (t) => {
  const { dir, registry } = await fixture(t, () => Response.json(body(metadata('renamed-model'))))
  const models = await new OpenCodeGoModels({
    file: path.join(dir, 'models.json'),
    installed: async () => new Map(openCodeModels(mergeOpenCodeCatalog(base, registry.groups)).map((model) => [model.id, model.name])),
    refreshDefinitions: (ids, options) => registry.refresh(ids, options),
    fetchImpl: async () => Response.json({ data: [{ id: 'known-model' }, { id: 'renamed-model' }, { id: 'still-unknown' }] }),
  }).load()
  await models.refresh('the-go-key-never-reaches-the-registry')
  assert.deepEqual(models.served, ['known-model', 'renamed-model'])
  assert.deepEqual(models.missing, ['still-unknown'])
  assert.equal(models.failed, false)
})

test('an entirely renamed inventory can be completed before the no-overlap guard runs', async (t) => {
  const { dir, registry, file } = await fixture(t, () => Response.json(body(metadata('all-new-model'))))
  const installed = async (source) => new Map(openCodeModels(mergeOpenCodeCatalog(base, source.groups)).map((model) => [model.id, model.name]))
  const modelFile = path.join(dir, 'models.json')
  const models = await new OpenCodeGoModels({
    file: modelFile, installed: () => installed(registry),
    refreshDefinitions: (ids, options) => registry.refresh(ids, options),
    fetchImpl: async () => Response.json({ data: [{ id: 'all-new-model' }] }),
  }).load()
  await models.refresh('key')
  assert.deepEqual(models.served, ['all-new-model'])
  assert.equal(models.failed, false)
  const restoredRegistry = await new OpenCodeGoRegistry({ file, base: async () => base }).load()
  const restoredModels = await new OpenCodeGoModels({ file: modelFile, installed: () => installed(restoredRegistry) }).load()
  assert.deepEqual(restoredModels.served, ['all-new-model'])
})

test('definition refreshes serialize and cannot roll a new registry snapshot back', async (t) => {
  const pending = []
  const { registry, calls, file } = await fixture(t, () => new Promise((resolve) => pending.push(resolve)))
  const first = registry.refresh(['new-model'], { force: true })
  const second = registry.refresh(['new-model'], { force: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1)
  pending[0](Response.json(body(metadata('new-model'))))
  await first
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2)
  pending[1](Response.json(body(metadata('new-model', { limit: { context: 2000000, output: 200000 } }))))
  await second
  assert.equal(registry.groups['openai-completions']['new-model'].contextWindow, 2000000)
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).groups['openai-completions']['new-model'].contextWindow, 2000000)
})

test('streaming responses cannot bypass the registry size limit by omitting content-length', async (t) => {
  let cancelled = false
  const { registry } = await fixture(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  })))
  assert.equal(await registry.refresh(['new-model']), false)
  assert.equal(registry.failed, true)
  assert.equal(cancelled, true)
  assert.equal(registry.checkedAt, null)
})

test('legacy live ids outside the curated Go catalog are not pending definitions', async (t) => {
  const { dir, registry, file } = await fixture(t, () => Response.json(body(
    metadata('new-model'), metadata('retired-model', { status: 'deprecated' }),
    metadata('unsupported-model', { provider: { npm: 'unsupported-sdk' } }),
  )))
  const ids = ['known-model', 'new-model', 'legacy-model', 'retired-model', 'unsupported-model']
  const models = await new OpenCodeGoModels({
    file: path.join(dir, 'models.json'),
    installed: async () => new Map(openCodeModels(mergeOpenCodeCatalog(base, registry.groups)).map((model) => [model.id, model.name])),
    refreshDefinitions: (ids, options) => registry.refresh(ids, options),
    unlisted: () => registry.unlisted,
    fetchImpl: async () => Response.json({ data: ids.map((id) => ({ id })) }),
  }).load()
  await models.refresh('key')
  assert.deepEqual(registry.unlisted, ['legacy-model', 'retired-model'])
  assert.deepEqual(models.missing, ['unsupported-model'])
  assert.deepEqual(models.served, ['known-model', 'new-model'])
  const restored = await new OpenCodeGoRegistry({ file, base: async () => base }).load()
  assert.deepEqual(restored.unlisted, registry.unlisted)
  assert.equal(await restored.refresh(ids), false)
  restored.fetchImpl = async () => { throw new Error('offline') }
  await restored.refresh(ids, { force: true })
  assert.equal(restored.failed, true)
  assert.deepEqual(restored.unlisted, registry.unlisted)
  registry.fetchImpl = async () => Response.json(body(metadata('new-model')))
  await models.refresh('key', { maxAgeMs: 0 })
  assert.deepEqual(models.missing, [], 'catalog exclusions alone do not imply pending definitions')
  // A later publication moves an id back to a real definition gap if its
  // metadata is present but its protocol is still unsupported.
  registry.fetchImpl = async () => Response.json(body(metadata('legacy-model', { provider: { npm: 'unsupported-sdk' } })))
  await models.refresh('key', { maxAgeMs: 0 })
  assert.ok(models.missing.includes('legacy-model'))
})

test('old registry caches recheck previously requested ids for catalog classification', async (t) => {
  const { file, calls } = await fixture(t, () => Response.json(body()))
  await fs.writeFile(file, JSON.stringify({ groups: {}, checkedAt: Date.now(), requested: ['legacy-model'] }))
  const registry = await new OpenCodeGoRegistry({ file, base: async () => base,
    fetchImpl: async () => { calls.push('refresh'); return Response.json(body()) },
  }).load()
  await registry.refresh(['legacy-model'])
  assert.equal(calls.length, 1)
  assert.deepEqual(registry.unlisted, ['legacy-model'])
})

test('a registry failure does not disguise a new live id as a fully synchronized inventory', async (t) => {
  const { dir, registry } = await fixture(t, () => { throw new Error('offline') })
  const models = await new OpenCodeGoModels({
    file: path.join(dir, 'models.json'), installed: async () => new Map([['known-model', 'Known']]),
    refreshDefinitions: (ids, options) => registry.refresh(ids, options),
    fetchImpl: async () => Response.json({ data: [{ id: 'known-model' }, { id: 'new-model' }] }),
  }).load()
  await models.refresh('key')
  assert.deepEqual(models.missing, ['new-model'])
  assert.equal(registry.failed, true)
  assert.deepEqual(models.served, ['known-model'])
})
