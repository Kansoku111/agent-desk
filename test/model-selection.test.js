import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isModelVisible, pickDefaultModel, visibleModels, executionModelSelection, executionChildChoice } from '../web/src/model-selection.ts'

const model = (provider, id) => ({ provider, id, value: JSON.stringify([provider, id]), name: id, description: null })
const sol = model('openai-codex', 'gpt-6.1-sol')
const terra = model('openai-codex', 'gpt-5.6-terra')
const claude = model('anthropic', 'claude-sonnet-5-5')
const custom = model('anthropic', 'my-custom-model')
const deepseek = model('deepseek-official', 'deepseek-chat')
const catalog = [sol, terra, claude, custom, deepseek]
function server(modelVisibility, defaultModel = null) {
  return {
    catalog: { models: catalog },
    settings: { modelVisibility, defaultModel },
    accounts: { chatgpt: { signedIn: true }, claude: { configured: true }, deepseek: { configured: false } },
  }
}

test('EX restores exact available choices and clears unavailable models without fallback', () => {
  const state = server({})
  const valid = executionModelSelection(state, 'claudeApi', sol.value, claude.id)
  assert.equal(valid.leader, sol.value)
  assert.equal(valid.model, claude.id)
  state.accounts.claude.configured = false
  const disconnected = executionModelSelection(state, 'claudeApi', claude.value, claude.id)
  assert.equal(disconnected.leader, '')
  assert.equal(disconnected.model, '')
  assert.equal(executionModelSelection(state, 'claude', 'claude:sonnet', 'haiku').model, 'haiku')
  assert.equal(executionModelSelection(state, 'claude', 'claude:missing', 'missing').leader, '')
  assert.equal(executionModelSelection(state, 'claude', 'claude:opus', 'missing').model, '')
})

test('EX rejects hidden, retired, removed and wrong-provider saved choices', () => {
  const state = server({ [sol.value]: false })
  assert.equal(executionModelSelection(state, 'gpt', sol.value, sol.id).leader, '')
  assert.equal(executionModelSelection(state, 'gpt', sol.value, sol.id).model, '')
  state.settings.modelVisibility[sol.value] = true
  state.catalog.models = [{ ...sol, retired: true }, claude]
  assert.equal(executionModelSelection(state, 'gpt', sol.value, sol.id).model, '')
  assert.equal(executionModelSelection(state, 'claudeApi', 'missing', sol.id).model, '')
  assert.equal(executionModelSelection(state, 'claudeApi', 'missing', claude.id).leader, '')
  assert.equal(executionModelSelection(state, 'claudeApi', 'missing', claude.id).model, claude.id)
})


test('Eco picker selections preserve the exact provider route and round-trip saved pairs', () => {
  const state = server({})
  const routes = { gpt: 'openai-codex', claudeApi: 'anthropic', deepseek: 'deepseek-official', opencodeGo: 'opencode-go', local: 'local-llm' }
  state.accounts.deepseek.configured = true
  state.accounts.opencodeGo = { configured: true }
  state.accounts.localLlm = { configured: true }
  // The same model id on different routes must never switch billing routes.
  state.catalog.models = Object.values(routes).map((provider) => model(provider, 'shared-id'))
  for (const [provider, route] of Object.entries(routes)) {
    const entry = model(route, 'shared-id')
    const choice = executionChildChoice(state, entry.value)
    assert.deepEqual(choice, { provider, model: entry.id })
    const restored = executionModelSelection(state, choice.provider, 'claude:opus', choice.model)
    assert.equal(restored.model, entry.id)
    assert.equal(restored.childModels.find((item) => item.id === restored.model)?.value, entry.value)
  }
  for (const name of ['opus', 'sonnet', 'haiku']) assert.deepEqual(executionChildChoice(state, `claude:${name}`), { provider: 'claude', model: name })
  assert.equal(executionModelSelection(state, 'claude', 'claude:haiku', 'haiku').leader, '')
  assert.equal(executionModelSelection(state, 'local', model('local-llm', 'shared-id').value, 'shared-id').leader, '')
})

test('Claude Code visibility is independent of API visibility in eco choices', () => {
  const state = server({ [claude.value]: false, 'claude:haiku': false })
  assert.equal(executionChildChoice(state, claude.value), null)
  assert.equal(executionChildChoice(state, 'claude:haiku'), null)
  assert.deepEqual(executionChildChoice(state, 'claude:sonnet'), { provider: 'claude', model: 'sonnet' })
  assert.equal(executionModelSelection(state, 'claude', 'claude:sonnet', 'haiku').model, '')
  state.settings.modelVisibility['claude:sonnet'] = false
  assert.equal(executionModelSelection(state, 'claude', 'claude:sonnet', 'opus').leader, '')
  state.settings.modelVisibility[claude.value] = true
  assert.deepEqual(executionChildChoice(state, claude.value), { provider: 'claudeApi', model: claude.id })
})

test('Eco restores named Claude Code models independently of the API route', () => {
  const state = server({ [claude.value]: false })
  state.accounts.claude.configured = false
  const value = `claude:${claude.id}`
  assert.deepEqual(executionChildChoice(state, value), { provider: 'claude', model: claude.id })
  assert.deepEqual([executionModelSelection(state, 'claude', value, claude.id).leader, executionModelSelection(state, 'claude', value, claude.id).model], [value, claude.id])
  state.settings.modelVisibility[value] = false
  assert.equal(executionChildChoice(state, value), null)
  assert.equal(executionModelSelection(state, 'claude', value, claude.id).model, '')
  assert.equal(executionModelSelection(state, 'claude', value, claude.id).leader, '')
})

test('Eco picker never maps hidden, retired, disconnected or missing choices to another model', () => {
  const state = server({ [sol.value]: false })
  assert.equal(executionChildChoice(state, sol.value), null)
  assert.equal(executionChildChoice(state, deepseek.value), null)
  assert.equal(executionChildChoice(state, 'claude:missing'), null)
  assert.equal(executionChildChoice(state, 'missing'), null)
  state.catalog.models = [{ ...sol, retired: true }]
  state.settings.modelVisibility[sol.value] = true
  assert.equal(executionChildChoice(state, sol.value), null)
})

test('older settings show every model; hiding Terra leaves the catalog intact and checking restores it', () => {
  assert.deepEqual(visibleModels(server(undefined)), catalog)
  const state = server({ [terra.value]: false })
  assert.deepEqual(visibleModels(state), [sol, claude, custom, deepseek])
  assert.deepEqual(state.catalog.models, catalog)
  state.settings.modelVisibility[terra.value] = true
  assert.deepEqual(visibleModels(state), catalog)
})

test('visibility covers custom models, uses the provider-qualified value, and tolerates absent models', () => {
  const other = model('openai-codex', custom.id)
  const state = server({ [custom.value]: false, [deepseek.value]: false, '["anthropic","removed"]': false })
  state.catalog = { models: [...catalog, other] }
  assert.deepEqual(visibleModels(state), [sol, terra, claude, other])
  state.catalog.models = [...state.catalog.models, model('anthropic', 'new-model')]
  assert.equal(visibleModels(state).at(-1).id, 'new-model')
})

test('new tasks retain visible choices, but skip hidden current and saved defaults', () => {
  assert.equal(pickDefaultModel(server({}), terra.value), terra.value)
  assert.equal(pickDefaultModel(server({}, terra.value), null), terra.value)
  const state = server({ [terra.value]: false }, terra.value)
  assert.equal(pickDefaultModel(state, terra.value), sol.value)
  state.settings.modelVisibility[sol.value] = false
  assert.equal(pickDefaultModel(state, null), claude.value)
  state.settings.modelVisibility[terra.value] = true
  assert.equal(pickDefaultModel(state, null), terra.value)
})

test('default selection requires a connected provider and never resurrects a hidden or stale choice', () => {
  const state = server(Object.fromEntries(catalog.map((entry) => [entry.value, false])), terra.value)
  assert.equal(pickDefaultModel(state, terra.value), null)
  state.settings.modelVisibility[deepseek.value] = true
  assert.equal(pickDefaultModel(state, terra.value), null)
  state.accounts.deepseek.configured = true
  assert.equal(pickDefaultModel(state, terra.value), deepseek.value)
  state.catalog.models = []
  assert.equal(pickDefaultModel(state, terra.value), null)
})

test('possibly retired models are hidden by default, including when no other model remains', () => {
  const old = { ...terra, retired: true }
  const state = server({})
  state.catalog = { models: [old, sol, claude] }
  assert.deepEqual(visibleModels(state), [sol, claude])
  assert.equal(pickDefaultModel(state, old.value), sol.value)
  state.settings.defaultModel = old.value
  assert.equal(pickDefaultModel(state, null), sol.value)
  state.catalog = { models: [old] }
  assert.equal(pickDefaultModel(state, null), null)
  state.settings.modelVisibility[old.value] = true
  assert.deepEqual(visibleModels(state), [old])
  assert.equal(pickDefaultModel(state, null), old.value)
})

test('default visibility follows retirement changes without overwriting explicit choices', () => {
  const old = { ...terra, retired: true }
  const state = server(undefined)
  assert.equal(isModelVisible(state, old), false)
  assert.equal(isModelVisible(state, terra), true)
  state.settings.modelVisibility = { [old.value]: true }
  assert.equal(isModelVisible(state, old), true)
  state.settings.modelVisibility[old.value] = false
  assert.equal(isModelVisible(state, old), false)
  assert.equal(isModelVisible(state, terra), false)
  assert.deepEqual(terra, catalog[1])
})
