import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { teamConfig } from '../server/team-config.js'
import * as workflowEffort from '../shared/workflow-effort.js'
import * as usageFallback from '../shared/usage-fallback.js'
import * as modelSelection from '../web/src/model-selection.ts'

// Exercise the actual start form's callbacks without launching a model.
const source = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source + '\nexport { LeaderSection, applyPatch }', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
const jsx = (type, props) => ({ type, props })
const field = function ModelField() {}
const groups = [
  { id: 'claude-code', heading: 'Claude Code', note: '', models: [{ value: 'claude:opus', name: 'Opus' }, { value: 'claude:haiku', name: 'Haiku' }] },
  ...[['openai-codex', 'gpt-6-luna'], ['anthropic', 'claude-haiku-5-5'], ['deepseek-official', 'deepseek-v4-flash'], ['opencode-go', 'glm-5.3'], ['openscale', 'deepseek/deepseek-v4.1-flash'], ['local-llm', 'org/model:8b']].map(([id, model]) => ({
    id, heading: id, note: '', models: [{ value: JSON.stringify([id, model]), name: model }],
  })),
]
const modules = {
  react: {}, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'lucide-react': {},
  '../store': {}, '../model-selection': { ...modelSelection, isModelVisible: () => true }, '../subagent-routes': {},
  '../util': { parseModel: (value) => { try { const [provider, id] = JSON.parse(value); return { provider, id } } catch { return null } }, pickableEfforts: (efforts) => efforts },
  './Modal': {}, './Popover': {}, './Pickers': { byNewest: () => 0 },
  './TerminalPickers': { claudeModels: () => [], claudeModelName: (_server, model) => model, claudeEfforts: () => ['low', 'high'] },
  './ClaudeAuthConsent': {}, './TeamHarness': {}, './ModeSections': {}, './PtcToggle': {}, './FallbackSummary': {}, '../team-auth-consent': {},
  '../../../shared/usage-fallback.js': usageFallback,
  '../../../shared/workflow-effort.js': {},
  './WorkflowModelField': { ModelField: field, modelGroups: (server) => server.groups.map((group) => ({ ...group, models: [...group.models] })) },
}
const component = {}
new Function('require', 'exports', outputText)((name) => { assert.ok(name in modules, name); return modules[name] }, component)
const server = {
  groups, settings: {}, accounts: { chatgpt: { signedIn: true } },
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

test('one leader picker preserves old Claude and GPT settings', () => {
  const legacy = harness({ leaderProvider: 'gpt', gptLeader: { model: null, effort: 'high' }, gpt: { mid: { model: 'gpt-6-luna' } } })
  assert.equal(legacy.field().value, JSON.stringify(['openai-codex', 'gpt-6-luna']))
  assert.equal(legacy.field().effort, 'high')
  assert.equal(legacy.field().allowClearUnavailableEffort, true)
  legacy.field().onChange(legacy.field().value)
  assert.equal(legacy.draft.gptLeader.model, null, 'reselecting the same model does not overwrite legacy fallback')
  assert.equal(legacy.draft.gptLeader.effort, 'high')
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
  // The server still lists OpenScale in the groups, but the picker offers only the providers it knows.
  assert.equal(h.field().groups.flatMap((group) => group.models).some((entry) => entry.value === JSON.stringify(['openscale', 'deepseek/deepseek-v4.1-flash'])), false)
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
  assert.equal('openscale' in calls[0].args.patch, false, 'a removed provider is not sent back')
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

test('a running team switches its leader before saving the other settings', async () => {
  const slots = []
  let cursor = 0
  const calls = []
  const current = JSON.stringify(['openai-codex', 'gpt-6-luna'])
  const config = teamConfig({ leaderProvider: 'gpt', gptLeader: { model: 'gpt-6-luna' }, gpt: { enabled: true } })
  const team = { id: 'team', leaderId: 'leader', leaderKind: 'thread', children: [], config }
  const app = { ...server, catalog: { ...server.catalog, providers: {} }, settings: { ...server.settings, agentTeams: config }, threads: [{ id: 'leader', model: current, effort: 'high' }], terminals: [] }
  const confirmation = { challenge: 'c' }
  const consent = function ClaudeAuthConsent() {}
  const dependencies = { ...modules,
    react: { useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] } },
    '../store': { useStore: (select) => select({ server: app }), act: async (name, args) => { calls.push({ name, args }); return { ok: true } } },
    '../team-auth-consent': { needsClaudeAuth: () => false },
    './ClaudeAuthConsent': { ClaudeAuthConsent: consent },
    '../../../shared/workflow-effort.js': workflowEffort,
  }
  const exports = {}
  new Function('require', 'exports', outputText)((name) => dependencies[name], exports)
  const render = () => { cursor = 0; return exports.TeamConfigDialog({ team, onClose() {} }) }
  const leader = () => nodes(render(), (node) => node.type?.name === 'TeamLeaderField')[0].props
  const save = () => nodes(render(), (node) => node.type === 'button' && node.props.children === '保存')[0].props
  assert.equal(leader().value, current)
  assert.equal(leader().effort, 'high')
  assert.equal(nodes(render(), (node) => node.type === consent).length, 0)
  leader().onChange('claude:haiku', '')
  nodes(render(), (node) => node.type === consent)[0].props.onChange({ ready: true, confirmation })
  await save().onClick()
  assert.deepEqual(calls.map((call) => call.name), ['team.changeLeader', 'team.update'])
  assert.deepEqual(calls[0].args, { teamId: 'team', model: 'claude:haiku', effort: '', authConfirmation: confirmation })
  assert.equal(calls[1].args.authConfirmation, undefined, 'a confirmation authorizes one action')
  team.leaderKind = 'codex'
  assert.equal(nodes(render(), (node) => node.type?.name === 'TeamLeaderField').length, 0)
})

test('a saved OpenScale leader stays as chosen: marked retired and not switched to another route', () => {
  const h = harness({ leaderProvider: 'openscale', dshLeader: { provider: 'openscale', model: 'deepseek/deepseek-v4.1-flash', effort: 'low' } })
  assert.equal(h.draft.leaderProvider, 'openscale')
  assert.equal(h.draft.dshLeader.provider, 'openscale')
  assert.equal(h.field().value, JSON.stringify(['openscale', 'deepseek/deepseek-v4.1-flash']))
  assert.ok(h.field().groups.flatMap((group) => group.models).some((entry) => entry.name === 'OpenScale / deepseek/deepseek-v4.1-flash（廃止）'))
  assert.equal(nodes(h.tree(), (node) => node.props?.className === 'team-warning').length, 1)
})

test('a removed provider still on, a retired leader or a free-mode retired child blocks starting; turning the provider off unblocks it', () => {
  const dialog = (agentTeams) => {
    const slots = []
    let cursor = 0
    const app = { ...server, app: { myPc: 'PC' }, settings: { ...server.settings, agentTeams } }
    const dependencies = { ...modules,
      react: { useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] } },
      '../store': { useStore: (select) => select({ server: app }), act: async () => ({ ok: true }), setState() {}, startTeam: async () => true },
      '../team-auth-consent': { needsClaudeAuth: () => false },
      '../util': { ...modules['../util'], workspaceLabel: () => 'フォルダ' },
      '../../../shared/workflow-effort.js': workflowEffort,
    }
    const exports = {}
    new Function('require', 'exports', outputText)((name) => dependencies[name], exports)
    const render = () => { cursor = 0; return exports.TeamStartDialog({ workspace: 'C:/work' }) }
    return {
      start: () => nodes(render(), (node) => node.type === 'button' && node.props.children === '始める')[0].props,
      turnOff: () => {
        const panel = nodes(render(), (node) => node.type?.name === 'RetiredOn')[0]
        nodes(panel.type(panel.props), (node) => node.type === 'button')[0].props.onClick()
      },
    }
  }
  const gptOn = { enabled: true, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } }
  const gptLeader = { leaderProvider: 'gpt', gptLeader: { model: 'gpt-6-luna', effort: null }, gpt: gptOn }
  assert.equal(dialog({ leaderProvider: 'openscale', dshLeader: { provider: 'openscale', model: 'deepseek/deepseek-v4.1-flash', effort: null }, gpt: gptOn }).start().disabled, true)
  assert.equal(dialog(gptLeader).start().disabled, false)
  // Tier mode does not use the free-mode list: a saved retired child neither blocks the start nor shows.
  const retiredChild = [{ provider: 'openscale', model: 'z-ai/glm-5.3-flash', effort: null }]
  // The start dialog takes its mode from the saved default mode.
  assert.equal(dialog({ ...gptLeader, defaultModelMode: 'tiers', freeModels: retiredChild }).start().disabled, false)
  assert.equal(dialog({ ...gptLeader, defaultModelMode: 'free', freeModels: retiredChild }).start().disabled, true)
  // A removed provider that the saved settings still turn on blocks the start until the user turns it off.
  const on = dialog({ ...gptLeader, retiredProviders: ['openscale'] })
  assert.equal(on.start().disabled, true)
  on.turnOff()
  assert.equal(on.start().disabled, false)
})

/** A running team's settings dialog on a saved config, with the leader's thread on `leaderModel`. */
function teamPanel(config, leaderModel, calls = []) {
  const slots = []
  let cursor = 0
  const team = { id: 'team', leaderId: 'leader', leaderKind: 'thread', children: [], config }
  const app = { ...server, catalog: { ...server.catalog, providers: {} }, settings: { ...server.settings, agentTeams: config }, threads: [{ id: 'leader', model: leaderModel, effort: 'high' }], terminals: [] }
  const dependencies = { ...modules,
    react: { useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] } },
    '../store': { useStore: (select) => select({ server: app }), act: async (name, args) => { calls.push({ name, args }); return { ok: true } } },
    '../team-auth-consent': { needsClaudeAuth: () => false },
    '../../../shared/workflow-effort.js': workflowEffort,
  }
  const exports = {}
  new Function('require', 'exports', outputText)((name) => dependencies[name], exports)
  const render = () => { cursor = 0; return exports.TeamConfigDialog({ team, onClose() {} }) }
  return {
    render,
    save: () => nodes(render(), (node) => node.type === 'button' && node.props.children === '保存')[0].props,
    turnOff: () => {
      const panel = nodes(render(), (node) => node.type?.name === 'RetiredOn')[0]
      nodes(panel.type(panel.props), (node) => node.type === 'button')[0].props.onClick()
    },
  }
}

test('saving waits until the removed settings are cleared; tier-mode rows do not hold it back', () => {
  const save = (config) => teamPanel(teamConfig(config), JSON.stringify(['openai-codex', 'gpt-6-luna'])).save()
  const retired = [{ provider: 'openscale', model: 'z-ai/glm-5.3-flash', effort: null }]
  assert.equal(save({ modelMode: 'free', freeModels: retired, gpt: { enabled: true } }).disabled, true)
  assert.equal(save({ modelMode: 'tiers', freeModels: retired, gpt: { enabled: true } }).disabled, false)
  assert.equal(save({ modelMode: 'free', freeModels: [{ provider: 'gpt', model: 'gpt-6-luna', effort: null }], gpt: { enabled: true } }).disabled, false)
  assert.equal(save({ retiredProviders: ['openscale'], gpt: { enabled: true } }).disabled, true)
})

test('a running team on a removed leader can switch its leader to another model, and the field says so', async () => {
  const calls = []
  const openscale = JSON.stringify(['openscale', 'deepseek/deepseek-v4.1-flash'])
  const gpt = JSON.stringify(['openai-codex', 'gpt-6-luna'])
  const panel = teamPanel(teamConfig({ gpt: { enabled: true } }), openscale, calls)
  // TeamLeaderField's picker sits inside the component: expand it to reach the model field and its warning.
  const leaderSection = () => {
    const element = nodes(panel.render(), (node) => node.type?.name === 'TeamLeaderField')[0]
    return element.type(element.props)
  }
  const leader = () => nodes(leaderSection(), (node) => node.type === field)[0].props
  assert.equal(leader().value, openscale)
  assert.ok(leader().groups.flatMap((group) => group.models).some((entry) => entry.name === 'OpenScale / deepseek/deepseek-v4.1-flash（廃止）'))
  assert.equal(nodes(leaderSection(), (node) => node.props?.className === 'team-warning' && String(node.props.children).includes('選び直')).length, 1)
  leader().onChange(gpt)
  await panel.save().onClick()
  assert.deepEqual(calls.map((call) => call.name), ['team.changeLeader', 'team.update'])
  assert.equal(calls[0].args.model, gpt)
})

test('turning off a removed provider that is still on is saved with the team settings', async () => {
  const calls = []
  const panel = teamPanel(teamConfig({ gpt: { enabled: true }, retiredProviders: ['openscale'] }), JSON.stringify(['openai-codex', 'gpt-6-luna']), calls)
  assert.equal(nodes(panel.render(), (node) => node.type?.name === 'RetiredOn').length, 1)
  panel.turnOff()
  await panel.save().onClick()
  assert.equal(calls[0].name, 'team.update')
  assert.deepEqual(calls[0].args.patch.retiredProviders, [])
})
