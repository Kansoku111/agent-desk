import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { CommandCodeModels, commandCodeRoutes, matchesCommandCodeEfforts, parseCommandCodeModels, COMMAND_CODE_MODELS_URL } from '../server/command-code.js'
import { homePatch } from '../server/dsh-config.js'
import { dshEnv } from '../server/dsh-env.js'
import { planSettingsUpdate, DEFAULT_SETTINGS } from '../server/settings.js'
import { mergeTeamConfig, teamConfig } from '../server/team-config.js'
import { normalizeExecutionModels } from '../server/execution.js'
import { describeError } from '../server/thread-utils.js'
import { Catalog, matchesCommandCodeCatalog } from '../server/catalog.js'

const apiList = { data: [
  { id: 'deepseek/flash', name: 'Flash', context_length: 1000000, supported_endpoints: ['/chat/completions', '/responses'] },
  { id: 'claude-test', name: 'Claude', context_length: 200000, supported_endpoints: ['/messages'] },
  { id: 'future', name: 'Future', context_length: 200000, supported_endpoints: ['/responses'] },
  { id: 'bad id', name: 'Invalid', context_length: 1000, supported_endpoints: ['/chat/completions'] },
] }

test('official inventory selects supported protocols without guessing plan or capabilities', () => {
  const result = parseCommandCodeModels(apiList)
  assert.equal(result.skipped, 2)
  assert.deepEqual(result.models.map(({ id, endpoint }) => [id, endpoint]), [['deepseek/flash', 'chat'], ['claude-test', 'messages']])
  assert.throws(() => parseCommandCodeModels({ data: [] }))
  assert.throws(() => parseCommandCodeModels({ data: [apiList.data[2]] }))
  const dup = parseCommandCodeModels({ data: [apiList.data[0], apiList.data[0]] })
  assert.equal(dup.models.length, 1)
  assert.equal(dup.skipped, 1)
})

test('the two official routes share a key and keep ZDR opt-in', () => {
  const models = parseCommandCodeModels(apiList).models
  const routes = commandCodeRoutes(models)
  assert.equal(routes['command-code'].baseURL, 'https://api.commandcode.ai/provider/v1')
  assert.equal(routes['command-code-claude'].baseURL, 'https://api.commandcode.ai/provider')
  assert.equal(routes['command-code'].api, 'openai-completions')
  assert.equal(routes['command-code-claude'].api, 'anthropic-messages')
  for (const route of Object.values(routes)) {
    assert.equal(route.apiKeyEnv, 'COMMAND_CODE_API_KEY')
    assert.equal(route.headers, undefined)
    assert.deepEqual(route.models[0].input, ['text'])
    assert.equal(route.models[0].reasoningEfforts, false)
  }
  for (const route of Object.values(commandCodeRoutes(models, { zdr: true }))) assert.deepEqual(route.headers, { 'x-cmd-zdr': '1' })
  const providers = YAML.parse(homePatch({ commandCodeRoutes: routes })).find((row) => row.id === 'llm-pi-ai').config.providers
  assert.deepEqual(providers['command-code'], routes['command-code'])
  assert.deepEqual(providers['command-code-claude'], routes['command-code-claude'])
  const env = dshEnv({ dshHome: 'home', fastMode: 'fast', credentials: 'creds' }, 'read-only', { COMMAND_CODE_API_KEY: 'unwanted' })
  assert.equal(env.COMMAND_CODE_API_KEY, undefined)
  assert.equal(planSettingsUpdate(structuredClone(DEFAULT_SETTINGS), { commandCodeZdr: true }, 0).effects.homePatch, true)
})

test('official model-specific effort levels use only Provider API-compatible values', () => {
  const models = [
    { id: 'deepseek/deepseek-v4.1-flash', endpoint: 'chat' },
    { id: 'Qwen/Qwen3.8-27B', endpoint: 'chat' },
    { id: 'z-ai/glm-5.3-flash', endpoint: 'chat' },
    { id: 'constructor', endpoint: 'chat' },
    { id: 'claude-sonnet-5-5', endpoint: 'messages' },
    { id: 'claude-sonnet-4-6', endpoint: 'messages' },
    { id: 'claude-haiku-4-5-20251001', endpoint: 'messages' },
  ].map((model) => ({ ...model, name: model.id, contextWindow: 200000 }))
  const routes = commandCodeRoutes(models)
  const efforts = Object.fromEntries(Object.values(routes).flatMap((route) => route.models.map((model) => [model.id, model.reasoningEfforts])))
  assert.deepEqual(efforts['deepseek/deepseek-v4.1-flash'], { low: 'low', high: 'high', max: 'max' })
  assert.deepEqual(efforts['Qwen/Qwen3.8-27B'], { low: 'low', medium: 'medium', xhigh: 'xhigh' })
  assert.deepEqual(efforts['z-ai/glm-5.3-flash'], { low: 'low', high: 'high', max: 'max' })
  assert.deepEqual(efforts['claude-sonnet-5-5'], { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
  assert.deepEqual(efforts['claude-sonnet-4-6'], { low: 'low', medium: 'medium', high: 'high', max: 'max' })
  assert.equal(efforts['claude-haiku-4-5-20251001'], false)
  assert.equal(efforts.constructor, false)
  assert.equal(routes['command-code'].compat.thinkingFormat, 'openai')
  assert.equal(routes['command-code'].compat.supportsReasoningEffort, true)
  assert.equal(routes['command-code-claude'].compat.forceAdaptiveThinking, true)
})

test('inventory is not applied until all known model efforts reach the picker', () => {
  const models = [
    { id: 'deepseek/deepseek-v4.1-flash', endpoint: 'chat' },
    { id: 'Qwen/Qwen3.8-27B', endpoint: 'chat' },
    { id: 'claude-sonnet-5-5', endpoint: 'messages' },
    { id: 'unknown', endpoint: 'chat' },
  ]
  const key = (provider, id) => JSON.stringify([provider, id])
  const efforts = (values) => ['', ...values].map((value) => ({ value }))
  const learned = {
    [key('command-code', models[0].id)]: efforts(['low', 'high', 'max']),
    [key('command-code', models[1].id)]: efforts(['low', 'medium', 'xhigh']),
  }
  assert.equal(matchesCommandCodeEfforts(models, learned), false)
  learned[key('command-code-claude', models[2].id)] = efforts(['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(matchesCommandCodeEfforts(models, learned), false) // unknown still needs its explicit empty state
  learned[key('command-code', models[3].id)] = []
  assert.equal(matchesCommandCodeEfforts(models, learned), true)
  learned[key('command-code', models[3].id)] = efforts(['low'])
  assert.equal(matchesCommandCodeEfforts(models, learned), false)
  learned[key('command-code', models[3].id)] = []
  learned[key('command-code', models[1].id)] = efforts(['low', 'medium'])
  assert.equal(matchesCommandCodeEfforts(models, learned), false)
  learned[key('command-code', models[1].id)] = [null]
  assert.equal(matchesCommandCodeEfforts(models, learned), false)
})

test('team choices preserve each protocol and slash-bearing model id', () => {
  const defaults = teamConfig({})
  assert.equal(defaults.commandCode.enabled, false)
  assert.equal(defaults.commandCodeClaude.enabled, false)
  const selected = mergeTeamConfig({}, {
    leaderProvider: 'commandCodeClaude', dshLeader: { provider: 'commandCodeClaude', model: 'claude-test', effort: null },
    commandCode: { enabled: true, low: { model: 'deepseek/flash' } },
    freeModels: [{ provider: 'commandCode', model: 'deepseek/flash', effort: null }, { provider: 'commandCodeClaude', model: 'claude-test', effort: null }],
  })
  assert.equal(selected.commandCode.low.model, 'deepseek/flash')
  assert.equal(selected.dshLeader.provider, 'commandCodeClaude')
  assert.equal(normalizeExecutionModels({ provider: 'commandCode', model: 'deepseek/flash', leader: 'claude:opus' }).model, 'deepseek/flash')
})

test('GOAT errors name the relevant plan or ZDR without changing other providers', () => {
  const thread = (provider) => ({ model: JSON.stringify([provider, 'test']) })
  assert.match(describeError(new Error('403 upgrade_required'), thread('command-code'), null).message, /Go プラン.*GOAT/)
  assert.match(describeError(new Error('422 cmd_zdr_no_providers'), thread('command-code-claude'), null).message, /ZDR/)
  assert.doesNotMatch(describeError(new Error('403 upgrade_required'), thread('anthropic'), null).message, /Go プラン/)
})

test('a dated official ID must be present before the inventory is applied', () => {
  const expected = [['messages', 'claude-model-20251001', 'Claude dated']]
  assert.equal(matchesCommandCodeCatalog(expected, []), false)
  assert.equal(matchesCommandCodeCatalog(expected, [{ provider: 'command-code-claude', id: 'claude-model-20251001', name: 'Claude dated' }]), true)
})

test('a stale runtime cannot replace either route and no effort is offered', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-command-catalog-'))
  t.after(async () => { assert.equal(path.dirname(home), os.tmpdir()); await fs.rm(home, { recursive: true, force: true }) })
  const catalog = await new Catalog(path.join(home, 'catalog.json'), JSON.stringify({ commandCode: [['chat', 'deepseek/flash', 'deepseek/flash'], ['messages', 'claude-test', 'claude-test']] })).load()
  const options = (groups) => [{ id: 'model', options: groups.map(([provider, id, name = id]) => ({ group: provider, options: [{ value: JSON.stringify([provider, id]), name }] })) }]
  catalog.learn(options([['command-code', 'deepseek/flash']]))
  assert.equal(catalog.stale, true)
  catalog.learn(options([['command-code', 'deepseek/flash'], ['command-code-claude', 'claude-test']]))
  assert.equal(catalog.stale, false)
  assert.deepEqual(catalog.data.effortsByModel['["command-code","deepseek/flash"]'], [])
  assert.deepEqual(catalog.data.effortsByModel['["command-code-claude","claude-test"]'], [])
  assert.equal(catalog.learn(options([['command-code', 'deepseek/flash']])), false)
  catalog.setSignature(JSON.stringify({ commandCode: [['chat', 'deepseek/flash', 'Renamed'], ['messages', 'claude-test', 'claude-test']] }))
  assert.equal(catalog.learn(options([['command-code', 'deepseek/flash'], ['command-code-claude', 'claude-test']])), false)
  assert.equal(catalog.stale, true)
  catalog.learn(options([['command-code', 'deepseek/flash', 'Renamed'], ['command-code-claude', 'claude-test']]))
  assert.equal(catalog.stale, false)
  assert.equal(catalog.data.models.find((entry) => entry.id === 'deepseek/flash').name, 'Renamed')
})

test('learning Command Code efforts preserves other models and resets only on a new signature', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-command-efforts-'))
  t.after(async () => {
    // Catalog writes are asynchronous; let the atomic writes settle before removing their directory.
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(path.dirname(home), os.tmpdir())
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const entries = [['command-code', 'deepseek/flash'], ['command-code', 'Qwen/test']]
  const signature = (version) => JSON.stringify({ commandCode: entries.map(([, id]) => ['chat', id, id]), commandCodeLearn: version })
  const catalog = await new Catalog(path.join(home, 'catalog.json'), signature(1)).load()
  const value = (i) => JSON.stringify(entries[i])
  const options = (i, levels) => [
    { id: 'model', currentValue: value(i), options: entries.map(([provider, id]) => ({ group: provider, options: [{ value: JSON.stringify([provider, id]), name: id }] })) },
    { id: 'reasoning_effort', currentValue: levels[0], options: levels.map((level) => ({ value: level, name: level })) },
  ]
  catalog.learn(options(0, ['low', 'high', 'max']))
  catalog.learn(options(1, ['low', 'medium', 'xhigh']))
  assert.deepEqual(catalog.data.effortsByModel[value(0)].map((entry) => entry.value), ['low', 'high', 'max'])
  assert.deepEqual(catalog.data.effortsByModel[value(1)].map((entry) => entry.value), ['low', 'medium', 'xhigh'])
  catalog.setSignature(signature(2))
  catalog.learn(options(0, ['low', 'high']))
  assert.deepEqual(catalog.data.effortsByModel[value(0)].map((entry) => entry.value), ['low', 'high'])
  assert.deepEqual(catalog.data.effortsByModel[value(1)], [])
  catalog.learn(options(1, ['medium']))
  assert.deepEqual(catalog.data.effortsByModel[value(0)].map((entry) => entry.value), ['low', 'high'])
  assert.deepEqual(catalog.data.effortsByModel[value(1)].map((entry) => entry.value), ['medium'])
})

test('refresh is anonymous and retains the last good inventory on failure', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-command-models-'))
  t.after(async () => { assert.equal(path.dirname(home), os.tmpdir()); await fs.rm(home, { recursive: true, force: true }) })
  const file = path.join(home, 'models.json')
  let broken = false, calls = 0
  const fetchImpl = async (url, options) => {
    assert.equal(url, COMMAND_CODE_MODELS_URL)
    assert.equal(options.headers, undefined)
    assert.equal(options.redirect, 'error')
    calls++
    return broken ? new Response('bad', { status: 500 }) : Response.json(apiList)
  }
  const inventory = await new CommandCodeModels({ file, fetchImpl }).load()
  assert.equal(await inventory.refresh({ maxAgeMs: 0 }), true)
  assert.equal(inventory.failed, false)
  assert.equal(inventory.models.length, 2)
  const saved = inventory.models
  const reloaded = await new CommandCodeModels({ file, fetchImpl }).load()
  assert.deepEqual(reloaded.models, saved)
  broken = true
  assert.equal(await inventory.refresh({ maxAgeMs: 0 }), false)
  assert.equal(inventory.failed, true)
  assert.deepEqual(inventory.models, saved)
  assert.deepEqual((await new CommandCodeModels({ file, fetchImpl }).load()).models, saved)
  broken = false
  assert.equal(await inventory.refresh({ maxAgeMs: 0 }), false)
  assert.equal(inventory.failed, false)
  assert.equal(calls, 3)
})
