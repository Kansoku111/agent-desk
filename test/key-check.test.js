import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch, isWorkspaceId } from '../server/dsh-config.js'
import { anthropicKeyProblem } from '../server/key-check.js'

test('anthropicKeyProblem flags ids and other credential kinds', () => {
  assert.match(anthropicKeyProblem('apikey_01AbCdEf'), /ID/)
  assert.match(anthropicKeyProblem('wrkspc_01AbCdEf'), /ワークスペース ID/)
  assert.match(anthropicKeyProblem('sk-ant-oat01-xyz'), /OAuth/)
  assert.match(anthropicKeyProblem('sk-ant-admin01-xyz'), /Admin/)
  assert.match(anthropicKeyProblem('sk-ant-api03-abc def'), /空白/)
  assert.equal(anthropicKeyProblem('sk-ant-api03-abcdef'), null)
})

test('homePatch adds the workspace header only for a valid id', () => {
  const plain = YAML.parse(homePatch())
  assert.deepEqual(plain[0].config.providers.anthropic, { apiKeyEnv: 'ANTHROPIC_API_KEY' })

  const scoped = YAML.parse(homePatch({ anthropicWorkspaceId: 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ' }))
  assert.deepEqual(scoped[0].config.providers.anthropic, {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    headers: { 'anthropic-workspace-id': 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ' },
  })

  const injected = YAML.parse(homePatch({ anthropicWorkspaceId: 'wrkspc_x\n      evil: 1' }))
  assert.deepEqual(injected[0].config.providers.anthropic, { apiKeyEnv: 'ANTHROPIC_API_KEY' })
  assert.equal(isWorkspaceId('wrkspc_abc'), true)
  assert.equal(isWorkspaceId('apikey_abc'), false)
})

test('contextOverrides caps larger models and shrinks their reply budget', async () => {
  const { contextOverrides, homePatch } = await import('../server/dsh-config.js')
  const models = {
    anthropic: {
      'claude-sonnet-5-5': { contextWindow: 1_000_000, maxTokens: 128_000 },
      'claude-haiku-4-5': { contextWindow: 200_000, maxTokens: 64_000 },
    },
    'openai-codex': { 'gpt-6.1-sol': { contextWindow: 272_000, maxTokens: 128_000 } },
  }
  const overrides = contextOverrides({ anthropic: 200_000, 'openai-codex': null }, models)
  assert.deepEqual(overrides, { anthropic: { 'claude-sonnet-5-5': { contextWindow: 200_000, maxTokens: 40_000 } } })
  assert.equal(contextOverrides({ anthropic: 64_000 }, models).anthropic['claude-haiku-4-5'].maxTokens, 12_800)

  const patch = YAML.parse(homePatch({ modelOverrides: overrides }))
  assert.deepEqual(patch[0].config.providers.anthropic.modelOverrides, overrides.anthropic)
  assert.equal(patch[0].config.providers['openai-codex'].modelOverrides, undefined)
})

test('contextOverrides raises a window up to the model ceiling', async () => {
  const { contextOverrides } = await import('../server/dsh-config.js')
  const models = {
    'openai-codex': {
      'gpt-6.1-sol': { contextWindow: 272_000, maxTokens: 128_000, maxContextWindow: 872_000 },
      'gpt-5.5': { contextWindow: 272_000, maxTokens: 128_000, maxContextWindow: 272_000 },
    },
  }
  assert.deepEqual(contextOverrides({ 'openai-codex': 1_000_000 }, models), {
    'openai-codex': { 'gpt-6.1-sol': { contextWindow: 872_000 } },
  })
  assert.deepEqual(contextOverrides({ 'openai-codex': 400_000 }, models), {
    'openai-codex': { 'gpt-6.1-sol': { contextWindow: 400_000 } },
  })
})

test('homePatch adds fixed-model subagent tools and tells the agent about them', async () => {
  const { shippedPersona } = await import('../server/dsh-config.js')
  assert.equal(YAML.parse(homePatch()).length, 3)

  const persona = await shippedPersona()
  assert.match(persona.personaPrefix, /\{\{model\}\}/)
  const rows = YAML.parse(homePatch({
    persona,
    subagents: [
      { provider: 'anthropic', model: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
      { provider: 'openai-codex', model: 'gpt-5.5', name: null },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      { provider: 'anthropic', model: 'bad\nid: 1' },
    ],
  }))
  const tools = rows.find((row) => row.insert).insert
  assert.deepEqual(tools.map((row) => row.config), [
    { provider: 'spawn', toolName: 'subagent_claude', backgroundMode: 'continuable', agentOptions: { provider: 'anthropic', model: 'claude-haiku-5-5' } },
    { provider: 'spawn', toolName: 'subagent_gpt', backgroundMode: 'continuable', agentOptions: { provider: 'openai-codex', model: 'gpt-5.5' } },
  ])
  const prompt = rows.find((row) => row.id === 'system-prompt').config
  assert.equal(prompt.personaPrefix, persona.personaPrefix)
  assert.ok(prompt.personaSuffix.startsWith(persona.personaSuffix))
  assert.match(prompt.personaSuffix, /`subagent_claude` runs each child on Claude Haiku 5\.5 \(anthropic\/claude-haiku-5-5\)/)
  assert.match(prompt.personaSuffix, /`subagent_gpt` runs each child on gpt-5\.5/)
})
