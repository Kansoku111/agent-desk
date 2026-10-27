import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source + '\nexport { FreeModels }', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
const jsx = (type, props) => ({ type, props })
const ModelField = () => {}, Dropdown = () => {}, MenuItem = () => {}
const choices = Array.from({ length: 15 }, (_, i) => ({ value: JSON.stringify(['openai-codex', 'model-' + i]), name: 'Model ' + i }))
const claude = [{ value: 'claude:haiku', name: 'Haiku' }]
const api = [{ value: JSON.stringify(['anthropic', 'haiku']), name: 'Haiku' }]
const server = { catalog: { models: choices, effortsByModel: {}, fallbackEfforts: [{ value: 'low' }] } }
const nodes = (node, match) => !node || typeof node !== 'object' ? []
  : [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, match))]

function harness(initial = []) {
  let config = { freeModels: initial }
  const modules = {
    react: { useState: () => [null, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../util': { parseModel: (value) => { try { const [provider, id] = JSON.parse(value); return { provider, id } } catch { return null } }, pickableEfforts: (items) => items },
    './WorkflowModelField': { ModelField, modelGroups: () => [{ id: 'openai-codex', heading: 'GPT', note: '', models: choices }, { id: 'claude-code', heading: 'Claude Code', note: '', models: claude }, { id: 'anthropic', heading: 'Claude（API）', note: '', models: api }] },
    './Popover': { Dropdown, MenuItem },
    './TerminalPickers': { claudeEfforts: () => [], claudeModelName: (_, id) => id },
  }
  const component = {}
  new Function('require', 'exports', outputText)((name) => modules[name] ?? {}, component)
  const render = () => component.FreeModels({ server, config, onChange: (patch) => { config = { ...config, ...patch } } })
  const menu = () => nodes(render(), (node) => node.type === Dropdown)[0].props.children(() => assert.fail('selection must not close menu'))
  return {
    get config() { return config },
    fields: () => nodes(render(), (node) => node.type === ModelField).map((node) => node.props),
    items: () => nodes(menu(), (node) => node.type === MenuItem).map((node) => node.props),
    select: (label) => nodes(menu(), (node) => node.type === MenuItem && node.props.label === label)[0].props.onSelect(),
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

test('enforces twelve models without disabling checked entries', () => {
  const h = harness()
  for (let i = 0; i < 12; i++) h.select('Model ' + i)
  assert.equal(h.items().find((item) => item.label === 'Model 12').disabled, true)
  assert.equal(h.items().find((item) => item.label === 'Model 0').disabled, false)
  h.select('Model 12')
  assert.equal(h.config.freeModels.length, 12)
  h.select('Model 0')
  assert.equal(h.items().find((item) => item.label === 'Model 12').disabled, false)
  h.select('Model 12')
  assert.equal(h.config.freeModels.length, 12)
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

test('Claude Code and Claude API remain separate selections', () => {
  const h = harness()
  const items = h.items().filter((item) => item.label === 'Haiku')
  items[0].onSelect()
  h.items().filter((item) => item.label === 'Haiku')[1].onSelect()
  assert.deepEqual(h.config.freeModels.map((entry) => entry.provider), ['claude', 'claudeApi'])
})
