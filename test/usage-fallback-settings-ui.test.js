import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import * as usageFallback from '../shared/usage-fallback.js'
import * as workflowEffort from '../shared/workflow-effort.js'

const source = await fs.readFile(new URL('../web/src/components/settings/UsageFallbackSettings.tsx', import.meta.url), 'utf8')
const jsx = (type, props, key) => ({ type, props: { ...props, ...(key === undefined ? {} : { key }) } })
const field = function ModelField() {}
const auth = function ClaudeAuthConsent() {}
const gpt = '["openai-codex","luna"]'
const claude = 'claude:haiku'
const groups = [
  { id: 'openai-codex', models: [{ value: gpt, name: 'Luna' }] },
  { id: 'claude-code', models: [{ value: claude, name: 'Haiku' }] },
]
function mount(initial = null) {
  const server = { app: { myPc: 'C:\\project' }, settings: { usageFallbackRoutes: initial }, catalog: { effortsByModel: { [gpt]: [{ value: 'low' }] } } }
  const slots = [], calls = []
  let cursor = 0, tree
  const react = { useState(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
  } }
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../store': { act: async (name, args) => {
      calls.push({ name, args })
      if (name === 'fallback.confirmClaude') return { confirmed: true }
      server.settings.usageFallbackRoutes = structuredClone(args.patch.usageFallbackRoutes)
      return { settings: server.settings }
    } },
    '../WorkflowModelField': { ModelField: field, modelGroups: () => groups }, '../ClaudeAuthConsent': { ClaudeAuthConsent: auth },
    '../../../../shared/usage-fallback.js': usageFallback, '../../../../shared/workflow-effort.js': workflowEffort,
  }
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } })
  const exports = {}
  new Function('require', 'exports', outputText)((name) => { assert.ok(name in modules, name); return modules[name] }, exports)
  const render = () => { cursor = 0; tree = exports.UsageFallbackSettings({ server }); return tree }
  const walk = (node, predicate) => {
    if (Array.isArray(node)) return node.flatMap((child) => walk(child, predicate))
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)]
  }
  render()
  return { server, calls, render, find: (predicate) => walk(tree, predicate),
    button: (text) => walk(tree, (node) => node.type === 'button' && (node.props.children === text || node.props['aria-label'] === text))[0],
    fields: () => walk(tree, (node) => node.type === field).map((node) => node.props) }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('collapsed summary shows the effective state and keeps safety details optional', () => {
  const legacy = mount()
  const disclosures = legacy.find((node) => node.type === 'details')
  assert.equal(disclosures.length, 2)
  assert.equal(disclosures[0].props.open, undefined)
  assert.equal(disclosures[1].props.open, undefined)
  assert.ok(legacy.find((node) => node.type === 'small' && node.props.children[0] === 'モード別の従来設定を使用中').length)
  assert.ok(legacy.find((node) => node.props?.children === '候補がありません。空のまま保存すると自動切り替えはオフになります。').length)
  const disabled = mount([])
  assert.ok(disabled.find((node) => node.type === 'small' && node.props.children[0] === '自動切り替えオフ').length)
  const configured = mount([{ model: gpt, effort: 'low' }])
  assert.ok(configured.find((node) => node.type === 'small' && node.props.children[0] === '候補 1 件').length)
})

test('shared settings save ordered provider models only after explicit confirmation', async () => {
  const ui = mount()
  ui.button('候補を追加').props.onClick(); ui.render()
  assert.equal(ui.button('保存').props.disabled, true)
  ui.fields()[0].onChange(gpt); ui.render()
  ui.button('候補を追加').props.onClick(); ui.render()
  ui.fields()[1].onChange(claude); ui.render()
  ui.button('優先 2 を上へ').props.onClick(); ui.render()
  assert.deepEqual(ui.fields().map((field) => field.value), [claude, gpt])
  assert.equal(ui.calls.length, 0)
  assert.equal(ui.button('保存').props.disabled, true)
  ui.find((node) => node.type === auth)[0].props.onChange({ ready: true, confirmation: { challenge: 'consent' } }); ui.render()
  ui.button('保存').props.onClick(); await flush(); ui.render()
  assert.equal(ui.calls[0].name, 'fallback.confirmClaude')
  assert.equal(ui.calls[0].args.confirmation.challenge, 'consent')
  assert.deepEqual(ui.calls[1].args.patch, { usageFallbackRoutes: [{ model: claude, effort: 'medium' }, { model: gpt, effort: 'low' }], usageFallbackRoutesBase: null })
})

test('saving an empty list explicitly disables legacy per-mode defaults', async () => {
  const ui = mount()
  assert.equal(ui.button('保存').props.disabled, false)
  ui.button('保存').props.onClick(); await flush(); ui.render()
  assert.deepEqual(ui.calls[0].args.patch, { usageFallbackRoutes: [], usageFallbackRoutesBase: null })
})

test('duplicate routes and unavailable models cannot be silently saved', () => {
  const ui = mount([{ model: gpt, effort: 'low' }])
  ui.button('候補を追加').props.onClick(); ui.render()
  ui.fields()[1].onChange(gpt); ui.render()
  assert.equal(ui.button('保存').props.disabled, true)
  assert.ok(ui.find((node) => node.props?.children === '同じ接続先は1つだけ選べます。').length)
  const unavailable = mount([{ model: '["unknown","hidden"]', effort: 'low' }])
  assert.equal(unavailable.button('保存').props.disabled, true)
  assert.ok(unavailable.find((node) => node.type === 'code' && node.props.children === '["unknown","hidden"]').length)
})

test('stale editors cannot overwrite the other window and can reload', () => {
  const ui = mount([{ model: gpt, effort: 'low' }])
  ui.server.settings.usageFallbackRoutes = [{ model: claude, effort: 'low' }]
  ui.render()
  assert.equal(ui.button('保存').props.disabled, true)
  assert.equal(ui.find((node) => node.props?.role === 'alert').length, 1)
  ui.button('最新の設定を読み直す').props.onClick(); ui.render()
  assert.equal(ui.fields()[0].value, claude)
  assert.equal(ui.button('保存').props.disabled, true)
  ui.find((node) => node.type === auth)[0].props.onChange({ ready: true }); ui.render()
  assert.equal(ui.button('保存').props.disabled, false)
})
