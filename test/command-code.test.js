import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { CommandCodeModels, commandCodeRoutes, parseCommandCodeModels, COMMAND_CODE_MODELS_URL } from '../server/command-code.js'
import { homePatch } from '../server/dsh-config.js'
import { dshEnv } from '../server/dsh-env.js'
import { planSettingsUpdate, DEFAULT_SETTINGS } from '../server/settings.js'
import { mergeTeamConfig, teamConfig } from '../server/team-config.js'
import { normalizeExecutionModels } from '../server/execution.js'
import { describeError } from '../server/thread-utils.js'
import { Catalog } from '../server/catalog.js'

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
