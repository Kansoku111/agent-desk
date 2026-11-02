import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { teamConfig } from '../server/team-config.js'
import * as workflowEffort from '../shared/workflow-effort.js'
import * as usageFallback from '../shared/usage-fallback.js'

// Exercise the actual start form's callbacks without launching a model.
const source = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source + '\nexport { LeaderSection, applyPatch }', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
const jsx = (type, props) => ({ type, props })
const field = function ModelField() {}
const groups = [
  { id: 'claude-code', heading: 'Claude Code', note: '', models: [{ value: 'claude:opus', name: 'Opus' }, { value: 'claude:haiku', name: 'Haiku' }] },
  ...[['openai-codex', 'gpt-6-luna'], ['anthropic', 'claude-haiku-5-5'], ['deepseek-official', 'deepseek-v4-flash'], ['opencode-go', 'glm-5.3'], ['local-llm', 'org/model:8b']].map(([id, model]) => ({
    id, heading: id, note: '', models: [{ value: JSON.stringify([id, model]), name: model }],
  })),
]
const modules = {
  react: {}, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'lucide-react': {},
  '../store': {}, '../model-selection': { isModelVisible: () => true },
  '../util': { parseModel: (value) => { try { const [provider, id] = JSON.parse(value); return { provider, id } } catch { return null } }, pickableEfforts: (efforts) => efforts },
  './Modal': {}, './Popover': {}, './Pickers': { byNewest: () => 0 },
  './TerminalPickers': { claudeModels: () => [], claudeModelName: (_server, model) => model, claudeEfforts: () => ['low', 'high'] },
  './ClaudeAuthConsent': {}, './TeamGuides': {}, './ModeSections': {}, './PtcToggle': {}, './FallbackSummary': {}, '../team-auth-consent': {},
  '../../../shared/usage-fallback.js': usageFallback,
  '../../../shared/workflow-effort.js': {},
  './WorkflowModelField': { ModelField: field, modelGroups: (server) => server.groups.map((group) => ({ ...group, models: [...group.models] })) },
}
const component = {}
new Function('require', 'exports', outputText)((name) => { assert.ok(name in modules, name); return modules[name] }, component)
const server = {
  groups, settings: { teamPolicies: [{ id: 'p1', name: '方針' }] }, accounts: { chatgpt: { signedIn: true } },
  catalog: { models: groups.flatMap((group) => group.models), effortsByModel: {}, fallbackEfforts: [{ value: 'low' }, { value: 'high' }] },
}
function nodes(node, match) {
  if (!node || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, match))]
}
function harness(saved) {
  let draft = teamConfig(saved)
  const render = () => component.LeaderSection({ server, config: draft, onChange: (patch) => { draft = component.applyPatch(draft, patch) } })
  return { get draft() { return draft }, tree: render, field: () => nodes(render(), (node) => node.type === field)[0].props }
}

test('one leader picker preserves old Claude and GPT settings and the policy', () => {
  const legacy = harness({ leaderProvider: 'gpt', gptLeader: { model: null, effort: 'high' }, gpt: { mid: { model: 'gpt-6-luna' } }, policy: 'p1' })
  assert.equal(legacy.field().value, JSON.stringify(['openai-codex', 'gpt-6-luna']))
  assert.equal(legacy.field().effort, 'high')
  assert.equal(legacy.field().allowClearUnavailableEffort, true)
  legacy.field().onChange(legacy.field().value)
  assert.equal(legacy.draft.gptLeader.model, null, 'reselecting the same model does not overwrite legacy fallback')
  assert.equal(legacy.draft.gptLeader.effort, 'high')
  assert.equal(nodes(legacy.tree(), (node) => node.type === 'select')[0].props.value, 'p1')
  const claude = harness({ leader: { model: null, effort: null } })
  assert.equal(claude.field().value, 'claude:')
  assert.ok(claude.field().groups.flatMap((group) => group.models).some((entry) => entry.name === 'Claude Code の既定'))
})

test('leader picker selects each provider and stores its own model and effort', () => {
  const h = harness({})
  for (const [provider, catalog, id] of [
    ['claudeApi', 'anthropic', 'claude-haiku-5-5'], ['deepseek', 'deepseek-official', 'deepseek-v4-flash'],
    ['opencodeGo', 'opencode-go', 'glm-5.3'], ['local', 'local-llm', 'org/model:8b'],
  ]) {
    const value = JSON.stringify([catalog, id])
    h.field().onChange(value)
    assert.equal(h.draft.leaderProvider, provider)
    assert.deepEqual(h.draft.dshLeader, { provider, model: id, effort: null })
    assert.equal(h.field().value, value)
    h.field().onEffort('low')
    assert.equal(h.draft.dshLeader.effort, 'low')
    h.field().onChange(value)
    assert.equal(h.draft.dshLeader.effort, 'low')
  }
  h.field().onChange('claude:haiku')
  assert.equal(h.draft.leaderProvider, 'claude')
  assert.deepEqual(h.draft.leader, { model: 'haiku', effort: null })
  h.field().onChange('claude:claude-haiku-5-5')
  assert.equal(h.draft.leaderProvider, 'claude')
  assert.deepEqual(teamConfig(h.draft).leader, { model: 'claude-haiku-5-5', effort: null })
  h.field().onChange(JSON.stringify(['openai-codex', 'gpt-6-luna']))
  assert.equal(h.draft.leaderProvider, 'gpt')
  assert.deepEqual(h.draft.gptLeader, { model: 'gpt-6-luna', effort: null })
})

test('existing team keeps its fallback snapshot while child settings are saved', async () => {
  const slots = []
  let cursor = 0
  const fallbackField = function FallbackSummary() {}
  const calls = []
  const current = JSON.stringify(['openai-codex', 'gpt-6-luna'])
  const target = JSON.stringify(['anthropic', 'claude-haiku-5-5'])
  const config = teamConfig({ leaderProvider: 'gpt', gptLeader: { model: 'gpt-6-luna' }, gpt: { enabled: true }, leaderFallback: target, fallbackEffort: 'low' })
  const team = { id: 'team', leaderId: 'leader', leaderKind: 'thread', children: [], config }
  const app = { ...server, catalog: { ...server.catalog, providers: {} }, settings: { ...server.settings, agentTeams: config }, threads: [{ id: 'leader', model: current }], terminals: [] }
  const dependencies = { ...modules,
    react: { useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] } },
    '../store': { useStore: (select) => select({ server: app }), act: async (name, args) => { calls.push({ name, args }); return { ok: true } } },
    '../team-auth-consent': { needsClaudeAuth: () => false },
    './FallbackSummary': { FallbackSummary: fallbackField },
    '../../../shared/workflow-effort.js': workflowEffort,
  }
  const exports = {}
  new Function('require', 'exports', outputText)((name) => dependencies[name], exports)
  const render = () => { cursor = 0; return exports.TeamConfigDialog({ team, onClose() {} }) }
  const field = () => nodes(render(), (node) => node.type === fallbackField)[0].props
  const save = () => nodes(render(), (node) => node.type === 'button' && node.props.children === '保存')[0].props
  assert.equal(field().value, target)
  assert.equal(field().frozen, true)
  assert.equal(field().onChange, undefined)
  await save().onClick()
  assert.equal(calls[0].name, 'team.update')
  assert.equal('leaderFallback' in calls[0].args.patch, false)
  assert.equal('leaderProvider' in calls[0].args.patch, false)
  team.sharedFallbackPolicy = true
  team.usageFallbackRoutes = [{ model: target, effort: 'low' }, { model: current, effort: 'low' }]
  assert.equal(field().value, target)
  app.threads[0].model = target
  assert.equal(field().value, current, 'the displayed target follows the actual source route')
  team.leaderFallbackUsed = true
  assert.equal(field().value, target, 'after switching, show the chosen target')
})

test('a previously selected but unavailable model remains visible without switching billing routes', () => {
  const h = harness({ leaderProvider: 'deepseek', dshLeader: { provider: 'deepseek', model: 'old-model', effort: 'low' } })
  const value = JSON.stringify(['deepseek-official', 'old-model'])
  assert.equal(h.field().value, value)
  assert.ok(h.field().groups.flatMap((group) => group.models).some((entry) => entry.value === value && entry.name === 'old-model'))
  assert.equal(h.draft.leaderProvider, 'deepseek')
})
