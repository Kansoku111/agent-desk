import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import * as workflowEffort from '../shared/workflow-effort.js'
import * as presetModels from '../shared/task-preset-models.js'

const jsx = (type, props) => ({ type, props })
const nodes = (node, match) => !node || typeof node !== 'object' ? [] : [
  ...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, match)),
]
const GPT = JSON.stringify(['openai-codex', 'fixture'])
const groups = [
  { id: 'claude-code', heading: 'Claude Code', note: '', models: [{ value: 'claude:haiku', name: 'Haiku' }] },
  { id: 'openai-codex', heading: 'ChatGPT', note: '', models: [{ value: GPT, name: 'GPT' }] },
]
const sourceCode = await fs.readFile(new URL('../web/src/components/TaskPresets.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(sourceCode, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText

function mount(kind, settings = {}) {
  const source = { kind: 'thread', id: 'parent' }
  const server = { settings: { taskPresets: { delegate: { model: GPT, effort: 'low' }, review: { model: null, effort: null }, ...settings } },
    catalog: { effortsByModel: { [GPT]: [{ value: 'low' }, { value: 'high' }] } } }
  let slots = [], cursor = 0, pendingEffects = [], failSave = false
  const calls = []
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useEffect(fn) { const i = cursor++; if (!(i in slots)) { slots[i] = true; pendingEffects.push(fn) } },
  }
  const store = {
    useStore: fn => fn({ server, presetStart: { source, kind }, presetRun: null }),
    request: async (type, params) => { calls.push({ type, params })
      if (type === 'preset.inspect') return { workspace: 'project', checks: [] }
      if (type === 'settings.update') {
        if (failSave) throw new Error('保存に失敗しました')
        Object.assign(server.settings.taskPresets, params.patch.taskPresets)
        return {}
      }
      if (type === 'preset.create') return { run: { id: 'run' } }
      throw new Error('unexpected request: ' + type)
    },
    setState() {}, navigate() {},
  }
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    '../store': store, '../util': { effortLabel: value => value },
    '../../../shared/workflow-effort.js': workflowEffort,
    '../../../shared/task-preset-models.js': presetModels,
    './WorkflowModelField': { ModelField: 'ModelField', modelGroups: () => groups },
    './Modal': { Modal: 'Modal' }, './ClaudeAuthConsent': { ClaudeAuthConsent: 'ClaudeAuthConsent' },
  }
  const exports = {}
  new Function('require', 'exports', compiled)(name => modules[name] ?? {}, exports)
  function render() {
    cursor = 0
    const dialog = nodes(exports.TaskPresetDialogs(), n => typeof n.type === 'function')[0]
    const tree = dialog.type(dialog.props)
    const picker = nodes(tree, n => typeof n.type === 'function' && n.type.name === 'PresetModelPicker')[0]
    const field = picker.type(picker.props)
    return { tree, field }
  }
  async function init() { render(); for (const effect of pendingEffects.splice(0)) effect(); await Promise.resolve(); return render() }
  return { server, calls, render, init, reopen() { slots = []; pendingEffects = []; return this.init() }, fail(value) { failSave = value } }
}

test('delegate picker saves model and effort immediately, even after reopening', async () => {
  const ui = mount('delegate')
  let { field } = await ui.init()
  assert.deepEqual(field.props.groups, groups)
  field.props.onChange('claude:haiku')
  await Promise.resolve(); await Promise.resolve()
  field = ui.render().field
  assert.equal(field.props.value, 'claude:haiku')
  field.props.onEffort('high')
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(ui.server.settings.taskPresets.delegate, { model: 'claude:haiku', effort: 'high' })
  field = (await ui.reopen()).field
  assert.equal(field.props.value, 'claude:haiku')
  assert.equal(field.props.effort, 'high')
})

test('review picker crosses harnesses and preserves its last selection independently', async () => {
  const ui = mount('review', { reviewClaude: { model: 'claude:haiku', effort: 'low' } })
  let { field, tree } = await ui.init()
  assert.equal(field.props.value, 'claude:haiku')
  assert.equal(nodes(tree, n => n.type === 'input' && n.props.name === 'review-harness').length, 0)
  field.props.onChange(GPT)
  await Promise.resolve(); await Promise.resolve()
  field = ui.render().field
  field.props.onEffort('high')
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(ui.server.settings.taskPresets.reviewSelected, { model: GPT, effort: 'high' })
  assert.equal(ui.server.settings.taskPresets.delegate.effort, 'low')
  ;({ field, tree } = await ui.reopen())
  assert.equal(field.props.value, GPT)
  assert.equal(field.props.effort, 'high')
  const start = nodes(tree, n => n.type === 'button' && n.props.className === 'button primary')[0]
  assert.equal(start.props.disabled, false)
  start.props.onClick()
  await Promise.resolve(); await Promise.resolve()
  const request = ui.calls.find(call => call.type === 'preset.create')
  assert.equal(request.params.expectedModel, GPT)
  assert.equal(request.params.expectedEffort, 'high')
  assert.equal(request.params.harness, undefined)
})

test('failed saves keep the previous choice and show the error', async () => {
  const ui = mount('delegate')
  const { field } = await ui.init()
  ui.fail(true)
  field.props.onChange('claude:haiku')
  await Promise.resolve(); await Promise.resolve()
  const result = ui.render()
  assert.equal(result.field.props.value, GPT)
  assert.equal(nodes(result.tree, n => n.props?.role === 'alert')[0].props.children, '保存に失敗しました')
  assert.equal(ui.server.settings.taskPresets.delegate.model, GPT)
})

test('DSH review fixes can explicitly select full access; opinion remains read-only', async () => {
  const ui = mount('review', { reviewSelected: { model: GPT, effort: 'low' } })
  let { tree } = await ui.init()
  assert.equal(nodes(tree, n => n.type === 'select').length, 0)
  nodes(tree, n => n.type === 'input' && n.props.value === 'fix')[0].props.onChange()
  tree = ui.render().tree
  const permission = nodes(tree, n => n.type === 'select')[0]
  assert.equal(permission.props.value, 'workspace-write')
  permission.props.onChange({ target: { value: 'danger-full-access' } })
  tree = ui.render().tree
  nodes(tree, n => n.type === 'button' && n.props.className === 'button primary')[0].props.onClick()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(ui.calls.find(c => c.type === 'preset.create').params.permissionMode, 'danger-full-access')

  const opinion = mount('review', { reviewSelected: { model: GPT, effort: 'low' } })
  ;({ tree } = await opinion.init())
  nodes(tree, n => n.type === 'input' && n.props.value === 'fix')[0].props.onChange()
  tree = opinion.render().tree
  nodes(tree, n => n.type === 'select')[0].props.onChange({ target: { value: 'danger-full-access' } })
  tree = opinion.render().tree
  nodes(tree, n => n.type === 'input' && n.props.value === 'opinion')[0].props.onChange()
  tree = opinion.render().tree
  assert.equal(nodes(tree, n => n.type === 'select').length, 0)
  nodes(tree, n => n.type === 'button' && n.props.className === 'button primary')[0].props.onClick()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(opinion.calls.find(c => c.type === 'preset.create').params.permissionMode, 'workspace-write')
})

test('legacy review choice starts without choosing a different harness', async () => {
  const ui = mount('review', { reviewClaude: { model: 'claude:haiku', effort: 'low' } })
  let { tree } = await ui.init()
  const auth = nodes(tree, n => n.type === 'ClaudeAuthConsent')[0]
  auth.props.onChange({ ready: true, confirmation: 'confirmed' })
  tree = ui.render().tree
  nodes(tree, n => n.type === 'button' && n.props.className === 'button primary')[0].props.onClick()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(ui.server.settings.taskPresets.reviewSelected, undefined)
  assert.deepEqual(ui.calls.filter(c => c.type !== 'preset.inspect').map(c => c.type), ['preset.create'])
  assert.equal(ui.calls.find(c => c.type === 'preset.create').params.harness, 'claude')
})
