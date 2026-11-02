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
  const state = { server: { settings: { observerModel: savedChoice }, catalog: {} }, turns: {}, agentTurns: {} }
  const modules = {
    react: { useState: (initial) => { const index = stateIndex++; let value = typeof initial === 'function' ? initial() : initial; if (index === 2) value = initialText; return [value, () => {}] }, useEffect() {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../store': { useStore: (select) => select(state), setState() {}, act: async (name, args) => { calls.push([name, args]); return {} } },
    '../../../shared/workflow-effort.js': { workflowLevels: () => ['low'] },
    './WorkflowModelField': { ModelField: 'ModelField', modelGroups: () => [{ id: 'gpt', models: [{ value: model, name: 'Luna' }] }] },
    './Modal': { Modal: 'Modal' }, './TurnView': { TurnView: 'TurnView' }, './ClaudeAuthConsent': { ClaudeAuthConsent: 'Consent' },
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
})
