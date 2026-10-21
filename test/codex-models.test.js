import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import {
  accountModelAdditions, markRetired, modelDisplayName, parseCodexAvailability, parseCodexModels, retiredModels, withCodexModelLimits,
} from '../server/codex-models.js'
import { CONTEXT_CHOICES, contextOverrides, homePatch } from '../server/dsh-config.js'

test('parseCodexModels keeps default and maximum windows', () => {
  assert.deepEqual(parseCodexModels({
    models: [
      { slug: 'gpt-6.1-sol', context_window: 500000, max_context_window: 872000 },
      { slug: 'gpt-5.5', context_window: 272000 },
      { slug: 'broken' },
    ],
  }), {
    'gpt-6.1-sol': { contextWindow: 500000, maxContextWindow: 872000 },
    'gpt-5.5': { contextWindow: 272000, maxContextWindow: 272000 },
  })
})

const catalog = {
  'openai-codex': {
    'gpt-6.1-sol': { contextWindow: 272_000, maxTokens: 128_000 },
    'gpt-5.5': { contextWindow: 272_000, maxTokens: 128_000 },
    'custom-gpt': { contextWindow: 128_000, maxTokens: 32_000 },
  },
  anthropic: { 'claude-sonnet-5-5': { contextWindow: 1_000_000, maxTokens: 128_000 } },
}
const backend = {
  'gpt-6.1-sol': { contextWindow: 500_000, maxContextWindow: 872_000 },
  'gpt-5.5': { contextWindow: 272_000, maxContextWindow: 272_000 },
}
const defaultOverride = { 'openai-codex': { 'gpt-6.1-sol': { contextWindow: 500_000 } } }

test('parseCodexModels resolves a missing default from the maximum and ignores invalid sizes', () => {
  assert.deepEqual(parseCodexModels({ models: [
    { slug: 'max-only', max_context_window: 872_000 },
    { slug: 'bad-default', context_window: -1, max_context_window: 500_000 },
    { slug: 'bad-max', context_window: 500_000, max_context_window: 0 },
    { slug: 'small-max', context_window: 500_000, max_context_window: 272_000 },
    { slug: 'invalid', context_window: 0, max_context_window: 1.5 },
    { slug: 'unsafe', context_window: Number.MAX_SAFE_INTEGER + 1 },
    { slug: 'fast-only', service_tiers: [{ id: 'priority' }] },
    null,
  ] }), {
    'max-only': { contextWindow: 872_000, maxContextWindow: 872_000 },
    'bad-default': { contextWindow: 500_000, maxContextWindow: 500_000 },
    'bad-max': { contextWindow: 500_000, maxContextWindow: 500_000 },
    'small-max': { contextWindow: 272_000, maxContextWindow: 272_000 },
    'fast-only': { contextWindow: null, maxContextWindow: null, fast: '' },
  })
  assert.deepEqual(parseCodexModels(null), {})
  assert.deepEqual(parseCodexModels({ models: {} }), {})
})

test('backend limits preserve the original catalog and only affect known Codex models', () => {
  const before = structuredClone(catalog)
  const models = withCodexModelLimits(catalog, backend)
  assert.deepEqual(catalog, before)
  assert.deepEqual(models['openai-codex']['gpt-6.1-sol'], {
    contextWindow: 272_000, maxTokens: 128_000, defaultContextWindow: 500_000, maxContextWindow: 872_000,
  })
  assert.deepEqual(models.anthropic, catalog.anthropic)
  assert.deepEqual(models['openai-codex']['custom-gpt'], catalog['openai-codex']['custom-gpt'])
})

test('automatic context size overrides an outdated catalog with the backend default, not its maximum', () => {
  const models = withCodexModelLimits(catalog, backend)
  assert.deepEqual(contextOverrides({ 'openai-codex': null, anthropic: null }, models), defaultOverride)
  assert.deepEqual(contextOverrides(undefined, models), defaultOverride)
  const patch = YAML.parse(homePatch({ modelOverrides: contextOverrides({}, models) }))
  assert.deepEqual(patch[0].config.providers['openai-codex'].modelOverrides, defaultOverride['openai-codex'])
  assert.equal(patch[0].config.providers.anthropic.modelOverrides, undefined)
})

test('500K is selectable, while smaller choices and model ceilings are honored', () => {
  assert.ok(CONTEXT_CHOICES.includes(500_000))
  const models = withCodexModelLimits(catalog, backend)
  assert.deepEqual(contextOverrides({ 'openai-codex': 500_000 }, models), defaultOverride)
  assert.deepEqual(contextOverrides({ 'openai-codex': 400_000 }, models), {
    'openai-codex': { 'gpt-6.1-sol': { contextWindow: 400_000, maxTokens: 80_000 } },
  })
  // A choice equal to the old catalog window still needs the reduced reply budget.
  assert.deepEqual(contextOverrides({ 'openai-codex': 272_000 }, models), {
    'openai-codex': { 'gpt-6.1-sol': { contextWindow: 272_000, maxTokens: 54_400 } },
  })
  assert.deepEqual(contextOverrides({ 'openai-codex': 1_000_000 }, models), {
    'openai-codex': { 'gpt-6.1-sol': { contextWindow: 872_000 } },
  })
  assert.deepEqual(contextOverrides({ 'openai-codex': 64_000 }, models)['openai-codex']['gpt-6.1-sol'], {
    contextWindow: 64_000, maxTokens: 12_800,
  })
  assert.deepEqual(contextOverrides({ 'openai-codex': -1 }, models), {})
})

test('a newer catalog needs no default override and a lower backend ceiling remains authoritative', () => {
  const current = structuredClone(catalog)
  current['openai-codex']['gpt-6.1-sol'].contextWindow = 500_000
  assert.deepEqual(contextOverrides({}, withCodexModelLimits(current, backend)), {})

  current['openai-codex']['gpt-5.5'].contextWindow = 1_000_000
  const overrides = contextOverrides({ 'openai-codex': 500_000 }, withCodexModelLimits(current, backend))
  assert.deepEqual(overrides['openai-codex']['gpt-5.5'], { contextWindow: 272_000, maxTokens: 54_400 })
})

test('missing or invalid backend limits fall back to the catalog instead of assigning every model 500K', () => {
  assert.deepEqual(contextOverrides({}, withCodexModelLimits(catalog)), {})
  assert.deepEqual(contextOverrides({}, withCodexModelLimits(catalog, {
    'gpt-6.1-sol': { contextWindow: -1, maxContextWindow: 0 },
    'gpt-5.5': { contextWindow: null, maxContextWindow: null, fast: '' },
  })), {})
})

test('inconsistent cached defaults never raise the backend maximum', () => {
  const models = withCodexModelLimits(catalog, {
    'gpt-6.1-sol': { contextWindow: 500_000, maxContextWindow: 272_000 },
  })
  assert.equal(models['openai-codex']['gpt-6.1-sol'].defaultContextWindow, 272_000)
  assert.equal(models['openai-codex']['gpt-6.1-sol'].maxContextWindow, 272_000)
  assert.deepEqual(contextOverrides({ 'openai-codex': 1_000_000 }, models), {})
  assert.deepEqual(contextOverrides({}, { 'openai-codex': {
    'gpt-6.1-sol': { contextWindow: 272_000, defaultContextWindow: 500_000, maxContextWindow: 272_000, maxTokens: 128_000 },
  } })['openai-codex']['gpt-6.1-sol'], { contextWindow: 272_000, maxTokens: 54_400 })
})

test('context size choices in the settings screen match server validation', async () => {
  const source = await fs.readFile(new URL('../web/src/components/Settings.tsx', import.meta.url), 'utf8')
  const options = /const CONTEXT_OPTIONS = \[([^\]]+)\]/.exec(source)
  assert.ok(options)
  const values = options[1].split(',').map((value) => Number(value.trim().replaceAll('_', '')))
  assert.deepEqual(values.sort((a, b) => a - b), CONTEXT_CHOICES)
})

const listing = { models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', context_window: 500_000 },
  { slug: 'gpt-7-nova', display_name: 'GPT-7-Nova', visibility: 'list' },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
  { slug: '../evil', visibility: 'list' },
] }

test('the account list tells offered models from hidden ones, and names them like pi-ai', () => {
  assert.deepEqual(parseCodexAvailability(listing), {
    offered: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }, { id: 'gpt-7-nova', name: 'GPT-7 Nova' }],
    known: ['gpt-6.1-sol', 'gpt-7-nova', 'gpt-reserve'],
  })
  assert.equal(modelDisplayName({ slug: 'codex-auto-review', display_name: 'Codex Auto Review' }), 'Codex Auto Review')
  assert.equal(modelDisplayName({ slug: 'gpt-5.3-codex-spark' }), 'gpt-5.3-codex-spark')
})

test('models missing from the account list are retired; hidden ones still work; an unknown list retires nothing', () => {
  const models = [
    { provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', value: 'sol' },
    { provider: 'openai-codex', id: 'gpt-reserve', name: 'GPT Reserve', value: 'reserve' },
    { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5', value: 'old' },
    { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude', value: 'claude' },
  ]
  const availability = parseCodexAvailability(listing)
  assert.deepEqual(retiredModels(models, availability).map((model) => model.id), ['gpt-5.5'])
  assert.deepEqual(retiredModels(models, { offered: [], known: [] }), [])
  assert.deepEqual(retiredModels(models, null), [])
  const snapshot = { providers: {}, models }
  assert.deepEqual(markRetired(snapshot, availability).models.map((model) => model.retired), [undefined, undefined, true, undefined])
  assert.equal(markRetired(snapshot, availability, false), snapshot)
})

test('account additions list every offered model, best first, as clone sources for each other', () => {
  const additions = accountModelAdditions(parseCodexAvailability(listing))
  assert.deepEqual(additions.map((entry) => entry.id), ['gpt-6.1-sol', 'gpt-7-nova'])
  assert.deepEqual(additions[1].templates, ['gpt-6.1-sol', 'gpt-7-nova'])
  assert.ok(additions.every((entry) => entry.source === 'account' && entry.provider === 'openai-codex'))
  assert.deepEqual(accountModelAdditions(null), [])
})

test('homePatch keeps the legacy default unless the account list excludes it', () => {
  const acpConfig = (options) => YAML.parse(homePatch(options)).find((row) => row.id === 'acp')?.config
  const legacy = { provider: 'openai-codex', model: 'gpt-6.1-sol' }
  assert.deepEqual(acpConfig(), legacy)
  assert.equal(homePatch({ catalogModels: { 'openai-codex': [] } }), homePatch())
  assert.deepEqual(acpConfig({ catalogModels: { 'openai-codex': [{ id: 'gpt-6.1-sol' }] } }), legacy)

  const acpModel = (options) => acpConfig(options)?.model
  assert.equal(acpModel({ catalogModels: { 'openai-codex': [
    { id: 'gpt-6.1-sol', visibility: 'hide' },
    { id: 'gpt-5.5', visibility: 'list' },
  ] } }), 'gpt-5.5')
  assert.equal(acpModel({ catalogModels: { 'openai-codex': [
    { id: 'gpt-hidden', visibility: 'hide' },
    { id: 'gpt-7-nova', visibility: 'list' },
    { id: 'gpt-5.5', visibility: 'list' },
  ] } }), 'gpt-5.5')
  assert.equal(acpModel({ catalogModels: { 'openai-codex': [
    { id: 'gpt-hidden', visibility: 'hide' },
    { id: 'gpt-7-nova', visibility: 'list' },
    { id: 'gpt-6.2-nova', visibility: 'list' },
  ] } }), 'gpt-7-nova')
  assert.equal(acpModel({ catalogModels: { 'openai-codex': [{ id: 'gpt-hidden', visibility: 'hide' }] } }), undefined)
})
