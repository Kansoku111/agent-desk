import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localRoute, parseModelList } from '../server/local-llm.js'
import { DEFAULT_SETTINGS, planSettingsUpdate } from '../server/settings.js'

test('local output metadata is validated, persisted, and used by the route', () => {
  const discovered = parseModelList({ data: [
    { id: 'known', context_length: 1000000, max_output_tokens: 128000 },
    { id: 'alternate', context_length: 200000, max_output_tokens: -1, limit: { output: 64000 } },
    { id: 'invalid', context_length: 100000, max_output_tokens: 200000 },
    { id: 'unknown' },
  ] })
  assert.deepEqual(discovered, [
    { id: 'known', contextWindow: 1000000, maxTokens: 128000 },
    { id: 'alternate', contextWindow: 200000, maxTokens: 64000 },
    { id: 'invalid', contextWindow: 100000 },
    { id: 'unknown' },
  ])
  const { settings } = planSettingsUpdate(structuredClone(DEFAULT_SETTINGS), { localLlm: { baseURL: 'http://localhost:1234/v1', models: discovered } }, 0)
  assert.deepEqual(settings.localLlm.models, discovered)
  const route = localRoute(settings.localLlm)
  assert.equal(route.models[0].maxTokens, 128000)
  assert.equal(route.models[1].maxTokens, 64000)
  assert.equal(route.models[2].maxTokens, 8192)
  assert.equal(route.models[3].maxTokens, undefined)
  assert.throws(() => planSettingsUpdate(structuredClone(DEFAULT_SETTINGS), { localLlm: { baseURL: 'http://localhost:1234/v1', models: [{ id: 'bad', contextWindow: 1000, maxTokens: 1001 }] } }, 0), /maxTokens/)
})
