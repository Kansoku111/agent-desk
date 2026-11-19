import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import * as modelSelection from '../web/src/model-selection.ts'
import * as teamLimits from '../shared/team-limits.js'

const { MAX_TEAM_MODELS } = teamLimits

const source = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source + '\nexport { FreeModels }', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
const jsx = (type, props) => ({ type, props })
const ModelField = () => {}, Dropdown = () => {}, MenuItem = () => {}
const choices = Array.from({ length: MAX_TEAM_MODELS + 3 }, (_, i) => ({ value: JSON.stringify(['openai-codex', 'model-' + i]), name: 'Model ' + i }))
const claude = [{ value: 'claude:haiku', name: 'Haiku' }]
const openscale = [{ value: JSON.stringify(['openscale', 'z-ai/glm-5.3-flash']), name: 'GLM OpenScale' }]
const api = [{ value: JSON.stringify(['anthropic', 'haiku']), name: 'Haiku' }]
const server = { catalog: { models: choices, effortsByModel: {}, fallbackEfforts: ['low', 'medium', 'high', 'max'].map((value) => ({ value })) } }
const nodes = (node, match) => !node || typeof node !== 'object' ? []
  : [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, match))]

function harness(initial = []) {
  let config = { freeModels: initial }
  const modules = {
    react: { useState: () => [null, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../util': { parseModel: (value) => { try { const [provider, id] = JSON.parse(value); return { provider, id } } catch { return null } }, pickableEfforts: (items) => items },
    './WorkflowModelField': { ModelField, modelGroups: () => [{ id: 'openai-codex', heading: 'GPT', note: '', models: choices }, { id: 'claude-code', heading: 'Claude Code', note: '', models: claude }, { id: 'anthropic', heading: 'Claude（API）', note: '', models: api }, { id: 'openscale', heading: 'OpenScale', note: '', models: openscale }] },
    './Popover': { Dropdown, MenuItem },
    './TerminalPickers': { claudeEfforts: () => ['low', 'medium', 'high'], claudeModelName: (_, id) => id },
    '../model-selection': modelSelection,
    '../../../shared/team-limits.js': teamLimits,
  }
  const component = {}
  new Function('require', 'exports', outputText)((name) => modules[name] ?? {}, component)
  const render = () => component.FreeModels({ server, config, onChange: (patch) => { config = { ...config, ...patch } } })
  const menu = () => nodes(render(), (node) => node.type === Dropdown)[0].props.children(() => assert.fail('selection must not close menu'))
  return {
    get config() { return config },
    fields: () => nodes(render(), (node) => node.type === ModelField).map((node) => node.props),
    warnings: () => nodes(render(), (node) => node.props?.className === 'team-warning').map((node) => node.props.children),
    items: () => nodes(menu(), (node) => node.type === MenuItem).map((node) => node.props),
    select: (label) => nodes(menu(), (node) => node.type === MenuItem && node.props.label === label)[0].props.onSelect(),
    duplicateButton: (index) => nodes(render(), (node) => node.type === ModelField)[index].props.labelAction.props,
    duplicate: (index) => nodes(render(), (node) => node.type === ModelField)[index].props.labelAction.props.onClick(),
    remove: (index) => nodes(render(), (node) => node.type === 'button' && node.props?.['aria-label'] === 'モデル ' + (index + 1) + 'を削除')[0].props.onClick(),
  }
}

test('check several models and uncheck them without closing the picker', () => {
  const h = harness()
  h.select('Model 0'); h.select('Model 1'); h.select('Model 2')
  assert.deepEqual(h.config.freeModels.map((entry) => entry.model), ['model-0', 'model-1', 'model-2'])
  assert.ok(h.items().filter((item) => item.label.startsWith('Model ')).slice(0, 3).every((item) => item.selected && item.checkable))
  h.fields()[1].onEffort('low')
  h.select('Model 0')
  assert.deepEqual(h.config.freeModels.map((entry) => [entry.model, entry.effort]), [['model-1', 'low'], ['model-2', null]])
  h.select('Model 0')
  assert.deepEqual(h.config.freeModels.map((entry) => entry.model), ['model-1', 'model-2', 'model-0'])
})

test('enforces the model limit without disabling checked entries', () => {
  const h = harness()
  const next = 'Model ' + MAX_TEAM_MODELS
  for (let i = 0; i < MAX_TEAM_MODELS; i++) h.select('Model ' + i)
  assert.equal(h.items().find((item) => item.label === next).disabled, true)
  assert.equal(h.items().find((item) => item.label === 'Model 0').disabled, false)
  h.select(next)
  assert.equal(h.config.freeModels.length, MAX_TEAM_MODELS)
  h.select('Model 0')
  assert.equal(h.items().find((item) => item.label === next).disabled, false)
  h.select(next)
  assert.equal(h.config.freeModels.length, MAX_TEAM_MODELS)
})

test('keeps saved unavailable choices, supports per-row changes and avoids duplicates', () => {
  const h = harness([{ provider: 'gpt', model: 'unavailable', effort: 'high' }, { provider: 'gpt', model: 'model-1', effort: 'low' }])
  assert.equal(h.items().find((item) => item.label === 'unavailable').selected, true)
  assert.equal(h.fields()[0].value, JSON.stringify(['openai-codex', 'unavailable']))
  const removed = harness(h.config.freeModels)
  removed.select('unavailable')
  assert.deepEqual(removed.config.freeModels, [{ provider: 'gpt', model: 'model-1', effort: 'low' }])
  h.fields()[0].onChange(choices[0].value)
  assert.deepEqual(h.config.freeModels[0], { provider: 'gpt', model: 'model-0', effort: null })
  h.fields()[0].onChange(choices[1].value)
  assert.equal(h.config.freeModels[0].model, 'model-0')
  assert.equal(h.config.freeModels[1].effort, 'low')
  h.remove(0)
  assert.equal(h.config.freeModels[0].model, 'model-1')
})

test('duplicates a model beside its row with the next unused effort', () => {
  const h = harness([{ provider: 'gpt', model: 'model-0', effort: 'medium' }, { provider: 'gpt', model: 'model-1', effort: 'low' }])
  assert.equal(h.duplicateButton(0)['aria-label'], 'モデル 1を別の推論レベルで追加')
  assert.equal(h.duplicateButton(0).disabled, false)
  h.duplicate(0)
  assert.deepEqual(h.config.freeModels.map(({ model, effort }) => [model, effort]), [['model-0', 'medium'], ['model-0', 'high'], ['model-1', 'low']])
  h.duplicate(1)
  assert.deepEqual(h.config.freeModels.map(({ model, effort }) => [model, effort]), [['model-0', 'medium'], ['model-0', 'high'], ['model-0', 'max'], ['model-1', 'low']])
  h.fields()[0].onEffort('low')
  assert.equal(h.config.freeModels[0].effort, 'low')
  assert.deepEqual(h.fields()[0].unavailableEfforts, ['high', 'max'])
  h.fields()[0].onEffort('high')
  assert.equal(h.config.freeModels[0].effort, 'low', 'an already used effort cannot be selected')
  h.remove(1)
  assert.deepEqual(h.config.freeModels.map(({ model, effort }) => [model, effort]), [['model-0', 'low'], ['model-0', 'max'], ['model-1', 'low']])
  h.select('Model 0')
  assert.deepEqual(h.config.freeModels.map(({ model }) => model), ['model-1'], 'unchecking removes every level of that model')
})

test('disables duplication when levels or the model limit are exhausted', () => {
  server.catalog.effortsByModel[choices[0].value] = []
  const noLevels = harness([{ provider: 'gpt', model: 'model-0', effort: null }])
  assert.equal(noLevels.duplicateButton(0).disabled, true)
  noLevels.duplicate(0)
  assert.equal(noLevels.config.freeModels.length, 1)
  delete server.catalog.effortsByModel[choices[0].value]
  const h = harness(['low', 'medium', 'high', 'max'].map((effort) => ({ provider: 'gpt', model: 'model-0', effort })))
  assert.equal(h.duplicateButton(0).disabled, true)
  h.duplicate(0)
  assert.equal(h.config.freeModels.length, 4)
  h.remove(1)
  assert.equal(h.duplicateButton(0).disabled, false)
  h.duplicate(0)
  assert.equal(h.config.freeModels[1].effort, 'medium')
  for (let i = 1; i <= MAX_TEAM_MODELS - 4; i++) h.select('Model ' + i)
  assert.equal(h.config.freeModels.length, MAX_TEAM_MODELS)
  assert.equal(h.duplicateButton(4).disabled, true)
  h.duplicate(4)
  assert.equal(h.config.freeModels.length, MAX_TEAM_MODELS)
})

test('keeps default and missing models distinct without duplicated menu entries', () => {
  const h = harness([{ provider: 'gpt', model: 'unavailable', effort: null }])
  h.duplicate(0)
  assert.deepEqual(h.config.freeModels.map(({ effort }) => effort), [null, 'low'])
  assert.deepEqual(h.fields()[1].unavailableEfforts, [''])
  h.fields()[1].onEffort('')
  assert.equal(h.config.freeModels[1].effort, 'low')
  assert.equal(h.items().filter((item) => item.label === 'unavailable').length, 1)
  h.remove(0)
  assert.deepEqual(h.fields()[0].unavailableEfforts, [])
  h.fields()[0].onEffort('')
  assert.equal(h.config.freeModels[0].effort, null)
})

test('Claude Code and Claude API remain separate selections', () => {
  const h = harness()
  const items = h.items().filter((item) => item.label === 'Haiku')
  items[0].onSelect()
  h.items().filter((item) => item.label === 'Haiku')[1].onSelect()
  assert.deepEqual(h.config.freeModels.map((entry) => entry.provider), ['claude', 'claudeApi'])
  h.duplicate(0)
  assert.deepEqual(h.config.freeModels.map(({ provider, effort }) => [provider, effort]), [['claude', null], ['claude', 'low'], ['claudeApi', null]])
  h.duplicate(2)
  assert.deepEqual(h.config.freeModels.map(({ provider, effort }) => [provider, effort]), [['claude', null], ['claude', 'low'], ['claudeApi', null], ['claudeApi', 'low']])
})

test('OpenScale is no longer offered as a free-mode child', () => {
  // The server still lists its group; the menu offers only the providers the app knows.
  const h = harness()
  assert.equal(h.items().some((item) => item.label === 'GLM OpenScale'), false)
})

test('a saved OpenScale child stays visible as retired; only the user removes or replaces it', () => {
  const h = harness([{ provider: 'openscale', model: 'z-ai/glm-5.3-flash', effort: null }])
  assert.equal(h.fields()[0].value, JSON.stringify(['openscale', 'z-ai/glm-5.3-flash']))
  assert.ok(h.fields()[0].groups.flatMap((group) => group.models).some((model) => model.name === 'OpenScale / z-ai/glm-5.3-flash（廃止）'))
  assert.equal(h.warnings().length, 1)
  h.select('Model 0')
  assert.deepEqual(h.config.freeModels.map((entry) => entry.provider), ['openscale', 'gpt'], 'adding another child does not change it')
  h.fields()[0].onChange(choices[2].value)
  assert.deepEqual(h.config.freeModels[0], { provider: 'gpt', model: 'model-2', effort: null }, 'the user picks its replacement')
  assert.equal(h.warnings().length, 0)
  const removed = harness([{ provider: 'openscale', model: 'z-ai/glm-5.3-flash', effort: null }])
  removed.remove(0)
  assert.deepEqual(removed.config.freeModels, [])
})
