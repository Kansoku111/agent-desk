import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const jsx = (type, props) => ({ type, props })
const nodes = (node, match) => !node || typeof node !== 'object' ? [] : [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, match))]
const text = (node) => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : [node.props?.children].flat(Infinity).map(text).join('')
const model = '["openai-codex","gpt-6-luna"]'
const baseTeam = { id: 'team', workspace: 'workspace', leaderId: 'leader', leaderKind: 'thread', children: [], approvals: [], asks: [], queue: [] }

async function load(file, modules) {
  const source = await fs.readFile(new URL(file, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
  const exports = {}
  new Function('require', 'exports', outputText)((name) => modules[name] ?? {}, exports)
  return exports
}

test('team panel always shows one observer for TM but not eco', async () => {
  const state = { teamPanel: true, route: { view: 'thread', id: 'leader' }, server: { threads: [], terminals: [], catalog: { models: [] } } }
  const panel = await load('../web/src/components/TeamPanel.tsx', { react: { memo: (fn) => fn, useState: (value) => [value, () => {}] }, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': {}, '../store': { useStore: (select) => select(state) } })
  for (const observer of [undefined, { id: 'saved', kind: 'thread' }]) {
    const tree = panel.TeamPanel({ team: { ...baseTeam, observer } })
    const entries = nodes(tree, (node) => node.type === 'button' && text(node) === '観測者')
    assert.equal(entries.length, 1)
    assert.equal(typeof entries[0].props.onClick, 'function')
  }
  const eco = panel.TeamPanel({ team: { ...baseTeam, execution: {} } })
  assert.equal(nodes(eco, (node) => node.type === 'button' && text(node) === '観測者').length, 0)
})

test('observer composer requires an available explicit model and saves selection globally', async () => {
  const calls = []
  let savedChoice = null
  let initialText = ''
  let stateIndex = 0
  let touch = false
  const state = { server: { settings: { observerModel: savedChoice }, catalog: {} }, turns: {}, agentTurns: {} }
  const modules = {
    react: { useState: (initial) => { const index = stateIndex++; let value = typeof initial === 'function' ? initial() : initial; if (index === 2) value = initialText; return [value, () => {}] }, useEffect() {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../store': { useStore: (select) => select(state), isTouch: () => touch, setState() {}, act: async (name, args) => { calls.push([name, args]); return {} } },
    '../../../shared/workflow-effort.js': { workflowLevels: () => ['low'] },
    './WorkflowModelField': { ModelField: 'ModelField', modelGroups: () => [{ id: 'gpt', models: [{ value: model, name: 'Luna' }] }] },
    './Modal': { Modal: 'Modal' }, './useConversationScroll': { useConversationScroll: () => ({ scroller: { current: null }, onScroll() {} }) }, './TurnView': { TurnView: 'TurnView' }, './ClaudeAuthConsent': { ClaudeAuthConsent: 'Consent' },
  }
  const { ObserverChat } = await load('../web/src/components/ObserverChat.tsx', modules)
  const render = () => { stateIndex = 0; state.server.settings.observerModel = savedChoice; return ObserverChat({ team: baseTeam, onClose() {} }) }
  initialText = '進捗は？'
  let tree = render()
  assert.equal(nodes(tree, (node) => node.type === 'button' && text(node) === '送信')[0].props.disabled, true)
  const picker = nodes(tree, (node) => node.type === 'ModelField')[0]
  picker.props.onChange(model)
  assert.deepEqual(calls[0], ['settings.update', { patch: { observerModel: { model, effort: null } } }])
  savedChoice = { model: 'unavailable', effort: null }
  tree = render()
  assert.equal(nodes(tree, (node) => node.type === 'button' && text(node) === '送信')[0].props.disabled, true)
  assert.match(text(tree), /選び直してください/)
  savedChoice = { model, effort: 'low' }
  tree = render()
  assert.equal(nodes(tree, (node) => node.type === 'button' && text(node) === '送信')[0].props.disabled, false)
  nodes(tree, (node) => node.type === 'button' && text(node) === '送信')[0].props.onClick()
  assert.equal(calls.at(-1)[0], 'team.observerMessage')
  assert.equal(calls.at(-1)[1].model, model)
  const onKeyDown = nodes(tree, (node) => node.type === 'textarea')[0].props.onKeyDown
  const press = (extra = {}) => {
    let prevented = false
    const before = calls.length
    onKeyDown({ key: 'Enter', shiftKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault: () => { prevented = true }, ...extra })
    return { prevented, sent: calls.length > before }
  }
  assert.deepEqual(press(), { prevented: true, sent: true })
  assert.deepEqual(press({ shiftKey: true }), { prevented: false, sent: false })
  assert.deepEqual(press({ nativeEvent: { isComposing: true } }), { prevented: false, sent: false })
  assert.deepEqual(press({ keyCode: 229 }), { prevented: false, sent: false })
  touch = true
  assert.deepEqual(press(), { prevented: false, sent: false })
  touch = false
  savedChoice = { model: 'unavailable', effort: null }
  tree = render()
  let prevented = false
  const before = calls.length
  nodes(tree, (node) => node.type === 'textarea')[0].props.onKeyDown({ key: 'Enter', shiftKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(calls.length, before)
})

test('observer accepts, previews, removes and sends images without text', async () => {
  const values = [], calls = [], notices = [], uploads = []
  let index = 0, resolveUpload
  const state = { server: { settings: { observerModel: { model, effort: null } }, catalog: {} }, turns: {}, agentTurns: {} }
  const modules = {
    react: {
      useState: (initial) => { const i = index++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], (next) => { values[i] = typeof next === 'function' ? next(values[i]) : next }] },
      useEffect() {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': {},
    '../store': {
      useStore: (select) => select(state), isTouch: () => false, setState() {},
      isImageAttachment: (image) => image.mimeType.startsWith('image/'),
      toast: (message) => notices.push(message),
      uploadAttachment: (file) => { uploads.push(file); return new Promise((resolve) => { resolveUpload = resolve }) },
      act: async (name, args) => { calls.push([name, args]); return name === 'team.observerTurns' ? { segments: [], running: false } : {} },
    },
    '../../../shared/workflow-effort.js': { workflowLevels: () => ['low'] },
    './WorkflowModelField': { ModelField: 'ModelField', modelGroups: () => [{ models: [{ value: model }] }] },
    './Modal': { Modal: 'Modal' }, './useConversationScroll': { useConversationScroll: () => ({ scroller: { current: null }, onScroll() {} }) }, './TurnView': { TurnView: 'TurnView' }, './ClaudeAuthConsent': { ClaudeAuthConsent: 'Consent' },
  }
  const { ObserverChat } = await load('../web/src/components/ObserverChat.tsx', modules)
  const render = () => { index = 0; return ObserverChat({ team: baseTeam, onClose() {} }) }
  const find = (tree, type, label) => nodes(tree, (node) => node.type === type && (!label || node.props['aria-label'] === label || text(node) === label))[0]
  const image = { name: 'image.png', type: 'image/png' }, other = { name: 'file.txt', type: 'text/plain' }
  const saved = { file: 'image.png', name: 'image.png', mimeType: 'image/png', previewUrl: '/preview' }
  let tree = render()
  assert.equal(find(tree, 'button', '送信').props.disabled, true)
  const input = find(tree, 'input')
  assert.equal(input.props.accept, 'image/png,image/jpeg,image/gif,image/webp')
  const target = { files: [image], value: 'chosen' }
  input.props.onChange({ target })
  assert.equal(target.value, '')
  assert.equal(find(render(), 'button', '送信').props.disabled, true)
  resolveUpload(saved)
  await new Promise((resolve) => setImmediate(resolve))
  tree = render()
  assert.equal(find(tree, 'img').props.src, '/preview')
  assert.equal(find(tree, 'button', '送信').props.disabled, false)
  find(tree, 'button', '添付を外す').props.onClick()
  assert.equal(find(render(), 'button', '送信').props.disabled, true)
  let prevented = false
  find(render(), 'textarea').props.onPaste({ clipboardData: { files: [other] }, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(notices.length, 1)
  assert.equal(uploads.length, 1)
  tree = render()
  const compose = nodes(tree, (node) => node.props?.className === 'observer-compose')[0]
  compose.props.onDrop({ dataTransfer: { files: [other, image] }, preventDefault() {} })
  assert.equal(notices.length, 2)
  resolveUpload(saved)
  await new Promise((resolve) => setImmediate(resolve))
  find(render(), 'button', '送信').props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const sent = calls.find(([name]) => name === 'team.observerMessage')[1]
  assert.equal(sent.text, '')
  assert.deepEqual(sent.images, [{ file: saved.file, name: saved.name, mimeType: saved.mimeType }])
  assert.equal(find(render(), 'img'), undefined)
  prevented = false
  find(render(), 'textarea').props.onPaste({ clipboardData: { files: [image] }, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  resolveUpload(saved)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(find(render(), 'img').props.alt, 'image.png')
})
