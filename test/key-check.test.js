import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch, isWorkspaceId } from '../server/dsh-config.js'
import { anthropicKeyProblem, checkAnthropicKey, checkDeepSeekKey, checkOpenCodeGoKey } from '../server/key-check.js'

test('anthropicKeyProblem flags ids and other credential kinds', () => {
  assert.match(anthropicKeyProblem('apikey_01AbCdEf'), /ID/)
  assert.match(anthropicKeyProblem('wrkspc_01AbCdEf'), /ワークスペース ID/)
  assert.match(anthropicKeyProblem('sk-ant-oat01-xyz'), /OAuth/)
  assert.match(anthropicKeyProblem('sk-ant-admin01-xyz'), /Admin/)
  assert.match(anthropicKeyProblem('sk-ant-api03-abc def'), /空白/)
  assert.equal(anthropicKeyProblem('sk-ant-api03-abcdef'), null)
})

test('key validation probes reject redirects before forwarding credentials', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options })
    return Response.json({ data: [] })
  })

  assert.equal((await checkAnthropicKey('sk-ant-api03-test')).status, 'valid')
  assert.equal((await checkDeepSeekKey('ds-test')).status, 'valid')
  assert.equal((await checkOpenCodeGoKey('oc-test')).status, 'valid')
  assert.equal(requests.length, 3)
  assert.ok(requests.every(({ options }) => options.redirect === 'error'))
  assert.equal(requests[0].options.headers['x-api-key'], 'sk-ant-api03-test')
  assert.equal(requests[1].options.headers.authorization, 'Bearer ds-test')
  assert.equal(requests[2].url, 'https://opencode.ai/inference/go/v1/models')
  assert.equal(requests[2].options.headers.authorization, 'Bearer oc-test')
})

test('an OpenCode Go key the service refuses is invalid', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { type: 'server_error', message: 'Invalid credential' } }, { status: 401 }))
  assert.deepEqual(await checkOpenCodeGoKey('oc-wrong'), { status: 'invalid', httpStatus: 401, message: 'Invalid credential' })
})

test('homePatch adds the OpenCode Go route only while its key is saved', () => {
  assert.equal(YAML.parse(homePatch())[0].config.providers['opencode-go'], undefined)
  // pi-ai's catalog route: no models, protocol or URL of Agent Desk's own.
  assert.deepEqual(YAML.parse(homePatch({ opencodeGo: true }))[0].config.providers['opencode-go'], { apiKeyEnv: 'OPENCODE_API_KEY' })
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
  assert.equal(YAML.parse(homePatch()).length, 4)

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
  const tools = rows.find((row) => row.insert?.some((entry) => entry.id === 'agent-desk-subagent-claude')).insert
  assert.deepEqual(tools.map((row) => row.config), [
    { provider: 'spawn', toolName: 'subagent_claude', backgroundMode: 'continuable', agentOptions: { provider: 'anthropic', model: 'claude-haiku-5-5' } },
    { provider: 'spawn', toolName: 'subagent_gpt', backgroundMode: 'continuable', agentOptions: { provider: 'openai-codex', model: 'gpt-5.5' } },
  ])
  const prompt = rows.find((row) => row.id === 'system-prompt').config
  assert.equal(prompt.personaPrefix, persona.personaPrefix)
  assert.ok(prompt.personaSuffix.startsWith(persona.personaSuffix))
  assert.match(prompt.personaSuffix, /- `subagent_claude`: Claude Haiku 5\.5; /)
  assert.match(prompt.personaSuffix, /- `subagent_gpt`: gpt-5\.5; /)
})

test('the subagent guidance sends each model family to its own pinned tool, in no more text than before', async () => {
  const claude = { provider: 'anthropic', model: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }
  const gpt = { provider: 'openai-codex', model: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }
  const guidance = (subagents) => {
    const { personaSuffix } = YAML.parse(homePatch({ persona: { personaPrefix: '', personaSuffix: '' }, subagents }))
      .find((row) => row.id === 'system-prompt').config
    return personaSuffix.slice(0, personaSuffix.indexOf('Subagents do not get')).trim()
  }

  // Without this a GPT model other than the pinned one picks the plain `subagent`, which runs on itself.
  const both = guidance([claude, gpt])
  assert.match(both, /Delegate with your own family's tool \(`subagent_claude` for Claude, `subagent_gpt` for GPT\), else `subagent`/)
  assert.match(both, /`subagent` and `subagent_fork` run on your own model; use `subagent_fork` only when the child must see this conversation/)
  // The paragraph this one replaced was 510 characters for the same two tools.
  assert.ok(both.length <= 510, `${both.length} characters`)

  // A tool that is not pinned does not exist, so the model is not pointed at it.
  const gptOnly = guidance([gpt])
  assert.match(gptOnly, /\(`subagent_gpt` for GPT\)/)
  assert.doesNotMatch(gptOnly, /subagent_claude/)
})
