import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await fs.readFile(new URL('../web/src/components/TeamPanel.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
const jsx = (type, props) => ({ type, props })
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, predicate)
    if (found) return found
  }
}

for (const mode of ['TM', 'eco']) test(mode + ': delete button asks for confirmation and sends the child id', async () => {
  const child = { id: 'child', name: '子A', kind: 'thread', taskId: 'task', state: 'running', createdAt: 1 }
  const team = { id: 'team', leaderId: 'leader', leaderKind: 'thread', children: [child], approvals: [], asks: [], queue: [], ...(mode === 'eco' ? { execution: {} } : {}) }
  const state = { route: { view: 'thread', id: 'leader' }, server: { threads: [], catalog: { models: [] } } }
  const values = []
  let index = 0
  const calls = []
  function ConfirmDialog() {}
  const modules = {
    react: { memo: (fn) => fn, useState: (initial) => { const n = index++; if (!(n in values)) values[n] = initial; return [values[n], (value) => { values[n] = value }] } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../store': { useStore: (select) => select(state), act: async (...args) => { calls.push(args); return { removed: true } } },
    './Modal': { ConfirmDialog },
  }
  const panel = {}
  new Function('require', 'exports', outputText)((name) => modules[name] ?? {}, panel)
  const render = () => { index = 0; return panel.TeamPanel({ team }) }
  const button = find(render(), (node) => node.props?.['aria-label'] === '子Aを削除')
  button.props.onClick()
  const dialog = find(render(), (node) => node.type === ConfirmDialog)
  assert.match(dialog.props.body, /ファイルは残ります/)
  assert.equal(calls.length, 0)
  dialog.props.onConfirm()
  await Promise.resolve()
  assert.deepEqual(calls, [['team.removeChild', { teamId: 'team', childId: 'child' }]])
})
