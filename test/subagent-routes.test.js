import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { dshChildPatch, homePatch } from '../server/dsh-config.js'
import { defaultRoutes, dshModelParts, mergeRoutes, routePlan, savedRoutes, validateRoute } from '../server/subagent-routes.js'

const luna = JSON.stringify(['openai-codex', 'gpt-6-luna'])

test('a kind of task sends its subagents to itself until told otherwise', () => {
  assert.deepEqual(defaultRoutes(), {
    dsh: { target: 'dsh', model: null, effort: null },
    cl: { target: 'cl', model: null, effort: null },
    gp: { target: 'gp', model: null, effort: null },
  })
  for (const parent of ['dsh', 'cl', 'gp']) assert.equal(routePlan(parent, defaultRoutes()[parent]).mode, parent === 'gp' ? 'bridge' : 'native')
})

test('DSH models can be any provider with a subagent tool, but not an unknown one or a bad id', () => {
  assert.deepEqual(dshModelParts(luna), { provider: 'openai-codex', model: 'gpt-6-luna' })
  for (const provider of ['anthropic', 'deepseek-official', 'opencode-go', 'command-code', 'local-llm']) {
    assert.ok(dshModelParts(JSON.stringify([provider, 'some-model'])), provider)
  }
  for (const value of ['', 'gpt-6-luna', '[]', '["x","y"]', JSON.stringify(['anthropic', 'bad id\nx']), JSON.stringify(['anthropic', 3])]) {
    assert.equal(dshModelParts(value), null, value)
  }
})

test('a model must belong to the kind the route points at', () => {
  assert.deepEqual(validateRoute({ target: 'dsh', model: luna, effort: 'low' }), { target: 'dsh', model: luna, effort: 'low' })
  assert.deepEqual(validateRoute({ target: 'cl', model: 'claude:haiku', effort: 'low' }), { target: 'cl', model: 'claude:haiku', effort: 'low' })
  assert.deepEqual(validateRoute({ target: 'gp', model: 'codex:gpt-6-luna' }), { target: 'gp', model: 'codex:gpt-6-luna', effort: null })
  // A level without a model means nothing, so it is dropped.
  assert.equal(validateRoute({ target: 'gp', effort: 'low' }).effort, null)
  for (const route of [null, [], 'dsh', {}, { target: 'x' }, { target: 'dsh', model: 'claude:haiku' }, { target: 'cl', model: luna },
    { target: 'gp', model: 'claude:haiku' }, { target: 'cl', model: 'claude:' }, { target: 'cl', model: 'claude:two words' }, { target: 'dsh', model: 5 },
    { target: 'dsh', model: luna, effort: 3 }]) {
    assert.throws(() => validateRoute(route), /サブエージェント|モデル|推論/, JSON.stringify(route))
  }
})

test('moving a route to another kind clears the model that belonged to the old one', () => {
  const current = { ...defaultRoutes(), dsh: { target: 'dsh', model: luna, effort: 'high' } }
  const moved = mergeRoutes(current, { dsh: { target: 'cl' } })
  assert.deepEqual(moved.dsh, { target: 'cl', model: null, effort: null })
  assert.deepEqual(mergeRoutes(current, { dsh: { target: 'cl', model: 'claude:haiku', effort: 'low' } }).dsh, { target: 'cl', model: 'claude:haiku', effort: 'low' })
  assert.deepEqual(mergeRoutes(current, { dsh: { effort: 'low' } }).dsh, { target: 'dsh', model: luna, effort: 'low' })
  assert.deepEqual(mergeRoutes(current, { cl: { model: 'claude:haiku' } }).dsh, current.dsh)
  assert.notEqual(mergeRoutes(current, {}), current)
  assert.throws(() => mergeRoutes(current, []), /オブジェクト/)
})

test('routes saved before the per-provider models were replaced keep working, and a damaged route falls back', () => {
  assert.deepEqual(savedRoutes({}), defaultRoutes())
  const legacy = savedRoutes({ subagentModels: { 'openai-codex': 'gpt-6-luna', anthropic: 'claude-haiku-5-5' }, subagentEfforts: { 'openai-codex': 'low' } })
  assert.deepEqual(legacy.dsh, { target: 'dsh', model: luna, effort: 'low' })
  // Claude Code only ever ran the GPT route.
  assert.deepEqual(legacy.cl, legacy.dsh)
  const claudeOnly = savedRoutes({ subagentModels: { 'openai-codex': null, anthropic: 'claude-haiku-5-5' } })
  assert.equal(claudeOnly.dsh.model, JSON.stringify(['anthropic', 'claude-haiku-5-5']))
  assert.deepEqual(claudeOnly.cl, defaultRoutes().cl)
  assert.deepEqual(savedRoutes({ subagentModels: { anthropic: 'bad id' } }), defaultRoutes())
  const damaged = savedRoutes({ subagentRoutes: { dsh: { target: 'gp', model: 'claude:x' }, cl: 7, gp: { target: 'cl', model: 'claude:haiku' } } })
  assert.deepEqual(damaged.dsh, defaultRoutes().dsh)
  assert.deepEqual(damaged.cl, defaultRoutes().cl)
  assert.deepEqual(damaged.gp, { target: 'cl', model: 'claude:haiku', effort: null })
})

test('the plan keeps a kind\'s own tools unless the route needs the bridge', () => {
  const route = (target, model = null, effort = null) => ({ target, model, effort })
  // Same kind, no model: nothing to change. Codex has no tools of its own, so it always bridges.
  assert.deepEqual(routePlan('dsh', route('dsh')), { mode: 'native' })
  assert.deepEqual(routePlan('cl', route('cl')), { mode: 'native' })
  assert.deepEqual(routePlan('gp', route('gp')), { mode: 'bridge', target: 'gp', model: null, effort: null })
  // Same kind with a model: the native tool runs on it.
  assert.deepEqual(routePlan('dsh', route('dsh', luna, 'low')), { mode: 'native', pinned: { provider: 'openai-codex', model: 'gpt-6-luna', effort: 'low' } })
  assert.deepEqual(routePlan('cl', route('cl', 'claude:haiku', 'low')), { mode: 'native', claudeModel: 'haiku', effort: 'low' })
  assert.deepEqual(routePlan('cl', route('cl', 'claude:haiku')), { mode: 'native', claudeModel: 'haiku', effort: null })
  // Another kind: the bridge, and only once a model is chosen, so a drag alone cannot leave a task without subagents.
  assert.deepEqual(routePlan('dsh', route('cl')), { mode: 'native' })
  assert.deepEqual(routePlan('gp', route('cl')), { mode: 'native' })
  assert.deepEqual(routePlan('dsh', route('cl', 'claude:haiku', 'low')), { mode: 'bridge', target: 'cl', model: 'claude:haiku', effort: 'low' })
  assert.deepEqual(routePlan('cl', route('dsh', luna)), { mode: 'bridge', target: 'dsh', model: luna, effort: null })
  assert.deepEqual(routePlan('gp', route('gp', 'codex:gpt-6-luna', 'low')), { mode: 'bridge', target: 'gp', model: 'codex:gpt-6-luna', effort: 'low' })
})

test('the DSH child runs the chosen model without delegation tools or their guidance', () => {
  const subagents = [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'openai-codex', model: 'gpt-6.1-sol' }]
  const persona = { personaPrefix: 'You are a coding agent.', personaSuffix: 'Your working directory is {{cwd}}.' }
  const child = { provider: 'deepseek-official', model: 'deepseek-v4-flash', effort: 'high' }
  const rows = YAML.parse(dshChildPatch({ child, subagents, persona }))
  assert.deepEqual(rows[0], { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } })
  assert.deepEqual(rows.find((row) => row.id === 'credentials'), { id: 'credentials', disabled: false })
  // Headless callers consume only the result, so no model call goes to an unused session title.
  assert.deepEqual(rows.find((row) => row.id === 'session-title-llm'), { id: 'session-title-llm', disabled: true })
  const added = YAML.parse(homePatch({ subagents, persona })).flatMap((row) => row.insert ?? []).map((row) => row.id)
  for (const id of ['tool-subagent', 'tool-subagent-fork', ...added.filter((entry) => entry.startsWith('agent-desk-subagent-'))]) {
    assert.ok(rows.some((row) => row.id === id && row.disabled), id)
  }
  assert.deepEqual(rows.find((row) => row.id === 'system-prompt'), { id: 'system-prompt', config: persona })
  assert.equal(YAML.parse(dshChildPatch({ child: { provider: 'openai-codex', model: 'gpt-6-luna' } }))[0].config.reasoningEffort, undefined)
  for (const bad of [null, { provider: 'nowhere', model: 'x' }, { provider: 'anthropic', model: 'bad id' }]) assert.equal(dshChildPatch({ child: bad }), null)
})

test('a task whose subagents go to the bridge has none of dsh\'s own delegation tools', () => {
  const disabled = (options) => YAML.parse(homePatch(options)).filter((row) => row.disabled).map((row) => row.id)
  const subagents = [{ provider: 'openai-codex', model: 'gpt-6-luna' }]
  const base = ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents']
  assert.deepEqual(base.filter((id) => disabled({ subagents }).includes(id)), [])
  const off = homePatch({ subagents, nativeSubagents: false })
  for (const id of base) assert.ok(disabled({ subagents, nativeSubagents: false }).includes(id), id)
  // The pinned tool and its guidance go too: the bridge tool is the only way to delegate.
  assert.equal(YAML.parse(off).flatMap((row) => row.insert ?? []).some((row) => row.config?.toolName === 'subagent_gpt'), false)
  assert.doesNotMatch(off, /Subagents on a fixed model/)
})
