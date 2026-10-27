import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source + '\nexport { FreeModels }', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
})
const jsx = (type, props) => ({ type, props })
const ModelField = () => {}
const choices = Array.from({ length: 15 }, (_, i) => ({ value: JSON.stringify(['openai-codex', 'model-' + i]), name: 'Model ' + i }))
const server = { catalog: { models: choices, effortsByModel: {}, fallbackEfforts: [{ value: 'low' }] } }
const nodes = (node, match) => !node || typeof node !== 'object' ? []
  : [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, match))]

function harness() {
  let pending = []
  let config = { freeModels: [] }
  const modules = {
    react: { useState: () => [pending, (value) => { pending = typeof value === 'function' ? value(pending) : value }] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../util': { parseModel: (value) => { try { const [provider, id] = JSON.parse(value); return { provider, id } } catch { return null } }, pickableEfforts: (items) => items },
    './WorkflowModelField': { ModelField, modelGroups: () => [{ id: 'openai-codex', heading: 'GPT', note: '', models: choices }] },
    './TerminalPickers': { claudeEfforts: () => [], claudeModelName: (_, id) => id },
  }
  const component = {}
  new Function('require', 'exports', outputText)((name) => modules[name] ?? {}, component)
  const render = () => component.FreeModels({ server, config, onChange: (patch) => { config = { ...config, ...patch } } })
  return {
    get config() { return config },
    fields: () => nodes(render(), (node) => node.type === ModelField).map((node) => node.props),
    add: () => nodes(render(), (node) => node.type === 'button' && node.props?.className === 'button ghost')[0].props,
    remove: (index) => nodes(render(), (node) => node.type === 'button' && node.props?.['aria-label'] === 'モデル ' + (index + 1) + 'を削除')[0].props.onClick(),
  }
}

test('add repeatedly, select models, and remove empty or selected rows', () => {
  const h = harness()
  for (let i = 0; i < 3; i++) { assert.equal(h.add().disabled, false); h.add().onClick() }
  assert.equal(h.fields().length, 3)
  assert.deepEqual(h.config.freeModels, [], 'empty rows are not saved')
  h.fields()[1].onChange(choices[0].value)
  assert.equal(h.fields().length, 3)
  assert.equal(h.config.freeModels[0].model, 'model-0')
  assert.equal(h.fields()[0].value, '')
  assert.equal(h.fields()[1].value, choices[0].value)
  assert.ok(!h.fields()[0].groups.flatMap((g) => g.models).some((m) => m.value === choices[0].value))
  h.fields()[2].onChange(choices[1].value)
  assert.deepEqual(h.config.freeModels.map((m) => m.model), ['model-0', 'model-1'])
  h.fields()[1].onEffort('low')
  assert.equal(h.config.freeModels[0].effort, 'low')
  h.fields()[1].onChange(choices[0].value)
  assert.equal(h.config.freeModels[0].effort, 'low')
  h.remove(0)
  assert.equal(h.fields().length, 2)
  h.remove(0)
  assert.deepEqual(h.config.freeModels.map((m) => m.model), ['model-1'])
  assert.equal(h.add().disabled, false)
})

test('out-of-order selection stays on its row and saves in visible order', () => {
  const h = harness()
  for (let i = 0; i < 3; i++) h.add().onClick()
  h.fields()[2].onChange(choices[2].value)
  h.fields()[0].onChange(choices[0].value)
  assert.deepEqual(h.fields().map((field) => field.value), [choices[0].value, '', choices[2].value])
  h.fields()[1].onChange(choices[1].value)
  assert.deepEqual(h.config.freeModels.map((model) => model.model), ['model-0', 'model-1', 'model-2'])
})

test('selected and empty rows together cannot exceed twelve', () => {
  const h = harness()
  for (let i = 0; i < 12; i++) h.add().onClick()
  assert.equal(h.fields().length, 12)
  assert.equal(h.add().disabled, true)
  h.fields()[0].onChange(choices[0].value)
  assert.equal(h.fields().length, 12)
  assert.equal(h.add().disabled, true)
  h.remove(11)
  assert.equal(h.add().disabled, false)
  h.add().onClick()
  assert.equal(h.fields().length, 12)
})
