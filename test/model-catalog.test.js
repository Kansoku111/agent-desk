import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCatalogAdditions, isModelId } from '../server/model-catalog.js'

const base = {
  'anthropic-messages': {
    'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', api: 'anthropic-messages', contextWindow: 1000000 },
  },
}

test('bundled models join the catalog once and carry a marker', () => {
  const first = applyCatalogAdditions(base, 'anthropic')
  assert.ok(first.added.includes('claude-sonnet-5-5'))
  assert.equal(first.data['anthropic-messages']['claude-sonnet-5-5'].agentDeskAdded, 'bundled')
  const second = applyCatalogAdditions(first.data, 'anthropic')
  assert.deepEqual(second.data, first.data)
  assert.equal(base['anthropic-messages']['claude-sonnet-5-5'], undefined)
})

test('a bundled model the installed catalog already ships is left alone', () => {
  const shipped = structuredClone(base)
  shipped['anthropic-messages']['claude-sonnet-5-5'] = { id: 'claude-sonnet-5-5', name: 'Shipped' }
  const result = applyCatalogAdditions(shipped, 'anthropic')
  assert.ok(!result.added.includes('claude-sonnet-5-5'))
  assert.equal(result.data['anthropic-messages']['claude-sonnet-5-5'].name, 'Shipped')
})

test('custom models clone their template and disappear when removed', () => {
  const custom = [{ provider: 'anthropic', id: 'claude-sonnet-6', template: 'claude-sonnet-5', name: 'Claude Sonnet 6' }]
  const added = applyCatalogAdditions(base, 'anthropic', custom)
  const model = added.data['anthropic-messages']['claude-sonnet-6']
  assert.equal(model.id, 'claude-sonnet-6')
  assert.equal(model.name, 'Claude Sonnet 6')
  assert.equal(model.contextWindow, 1000000)
  assert.equal(model.agentDeskAdded, 'custom')

  const removed = applyCatalogAdditions(added.data, 'anthropic', [])
  assert.equal(removed.data['anthropic-messages']['claude-sonnet-6'], undefined)

  const missing = applyCatalogAdditions(base, 'anthropic', [{ provider: 'anthropic', id: 'x-1', template: 'nope' }])
  assert.deepEqual(missing.skipped, [{ id: 'x-1', reason: 'template-missing' }])
})

test('isModelId accepts catalog-style ids only', () => {
  assert.equal(isModelId('gpt-6.1-sol'), true)
  assert.equal(isModelId('claude-haiku-5-5'), true)
  assert.equal(isModelId('../evil'), false)
  assert.equal(isModelId('a b'), false)
})

const codex = {
  'openai-codex-responses': {
    'gpt-6.1-sol': { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', api: 'openai-codex-responses', contextWindow: 272000 },
  },
}

test('models the ChatGPT account offers are cloned from its best known model and vanish with the list', () => {
  const offered = [
    { provider: 'openai-codex', id: 'gpt-7-nova', name: 'GPT-7 Nova', templates: ['gpt-7-nova', 'gpt-6.1-sol'], source: 'account' },
    { provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', templates: ['gpt-6.1-sol'], source: 'account' },
    { provider: 'openai-codex', id: 'gpt-9', name: 'GPT-9', templates: ['gpt-9-none'], source: 'account' },
  ]
  const added = applyCatalogAdditions(codex, 'openai-codex', offered)
  const model = added.data['openai-responses']['gpt-7-nova']
  assert.equal(model.name, 'GPT-7 Nova')
  assert.equal(model.contextWindow, 272000)
  assert.equal(model.agentDeskAdded, 'account')
  assert.deepEqual(added.models.filter((entry) => entry.source === 'account').map((entry) => entry.id), ['gpt-7-nova'])
  // A model the catalog has, or one with no template to clone, is not an error.
  assert.deepEqual(added.skipped, [])
  assert.equal(added.data['openai-responses']['gpt-6.1-sol'].agentDeskAdded, undefined)
  assert.equal(added.data['openai-responses']['gpt-9'], undefined)

  const gone = applyCatalogAdditions(added.data, 'openai-codex', [])
  assert.equal(gone.data['openai-responses']['gpt-7-nova'], undefined)
})

test('pi-ai 1.x keeps typed keys, existing definitions and non-chat models', () => {
  const original = { 'anthropic-messages': {
    'chat:claude-sonnet-5': { ...base['anthropic-messages']['claude-sonnet-5'], type: 'chat' },
    'embedding:vector': { id: 'vector', type: 'embedding', name: 'Vector' },
  } }
  const custom = [{ provider: 'anthropic', id: 'claude-custom', template: 'claude-sonnet-5' }]
  const first = applyCatalogAdditions(original, 'anthropic', custom)
  const group = first.data['anthropic-messages']
  assert.equal(group['chat:claude-sonnet-5'].agentDeskAdded, undefined)
  assert.equal(group['chat:claude-sonnet-5-5'].type, 'chat')
  assert.equal(group['chat:claude-custom'].id, 'claude-custom')
  assert.deepEqual(group['embedding:vector'], original['anthropic-messages']['embedding:vector'])
  assert.equal(group['claude-sonnet-5-5'], undefined)
  assert.deepEqual(applyCatalogAdditions(first.data, 'anthropic', custom).data, first.data)
  assert.equal(applyCatalogAdditions(first.data, 'anthropic').data['anthropic-messages']['chat:claude-custom'], undefined)
})
