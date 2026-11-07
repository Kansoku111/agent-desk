import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { effortLabel, parseModel } from '../web/src/util.ts'

const jsx = (type, props) => ({ type, props })
const nodes = (node, match) => !node || typeof node !== 'object' ? [] : [
  ...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, match)),
]
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join('')
const model = JSON.stringify(['openai-codex', 'fixture-model'])
const runs = [
  { id: 'one', source: { kind: 'thread', id: 'parent' }, kind: 'delegate', title: '依頼', model, effort: 'low', phase: 'running' },
  { id: 'two', source: { kind: 'thread', id: 'parent' }, kind: 'review', title: 'レビュー', model: 'claude:haiku', effort: 'low', phase: 'completed' },
  { id: 'other', source: { kind: 'terminal', id: 'parent' }, kind: 'review', title: '別タスク', model, effort: '', phase: 'stopped' },
  { id: 'gp-run', source: { kind: 'codex', id: 'gp-parent' }, kind: 'delegate', title: 'GPの依頼', model, effort: 'low', phase: 'running' },
]
const server = { taskPresets: runs, threads: [{ id: 'parent', title: '元の会話' }], terminals: [], codexTasks: [{ id: 'gp-parent', title: 'GPの会話' }], catalog: { providers: { 'openai-codex': 'ChatGPT' }, models: [{ value: model, name: '実装モデル' }] } }
let state
const source = await fs.readFile(new URL('../web/src/components/TaskPresets.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } })
const modules = { 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') }, '../store': { useStore: fn => fn({ server, route: { view: 'preset', id: 'two' } }), setState: patch => { state = patch }, navigate: route => { state = route } }, '../util': { effortLabel, parseModel } }
const result = {}
new Function('require', 'exports', outputText)(name => modules[name] ?? {}, result)

test('preset panel shows the parent and each worker, and opens the worker view', () => {
  const panel = result.TaskPresetRuns({ source: { kind: 'thread', id: 'parent' }, onClose() {} })
  const aside = nodes(panel, node => node.type === 'aside')[0]
  assert.equal(aside.props['aria-label'], '委託とレビュー')
  const cards = nodes(aside, node => node.type === 'button' && node.props.className?.includes('subagent-card'))
  assert.equal(cards.length, 3)
  assert.match(text(cards[0]), /親.*元の会話/)
  assert.match(text(cards[1]), /子に委託.*作業中.*ChatGPT \/ 実装モデル.*低/)
  assert.match(text(cards[2]), /独立レビュー.*完了.*Claude Code \/ haiku.*低/)
  assert.equal(cards[2].props['aria-current'], 'page')
  assert.equal(cards[1].props['aria-current'], undefined)
  cards[2].props.onClick()
  assert.deepEqual(state, { view: 'preset', id: 'two' })
  cards[0].props.onClick()
  assert.deepEqual(state, { view: 'thread', id: 'parent' })
  const terminal = result.TaskPresetRuns({ source: { kind: 'terminal', id: 'parent' }, onClose() {} })
  assert.match(text(terminal), /別タスク/)
  assert.doesNotMatch(text(terminal), /レビュー完了/)
  const gp = result.TaskPresetRuns({ source: { kind: 'codex', id: 'gp-parent' }, onClose() {} })
  const gpCards = nodes(gp, node => node.type === 'button' && node.props.className?.includes('subagent-card'))
  assert.match(text(gpCards[0]), /親.*GPの会話/)
  assert.match(text(gpCards[1]), /子に委託.*GPの依頼/)
  gpCards[0].props.onClick()
  assert.deepEqual(state, { view: 'codex', id: 'gp-parent' })
})

test('preset panel toggle is hidden without runs and closes via backdrop', () => {
  assert.equal(result.TaskPresetToggle({ source: { kind: 'thread', id: 'missing' }, open: false, onToggle() {} }), null)
  let closed = false
  const panel = result.TaskPresetRuns({ source: { kind: 'thread', id: 'parent' }, onClose: () => { closed = true } })
  nodes(panel, node => node.props?.className === 'subagent-backdrop')[0].props.onClick()
  assert.equal(closed, true)
  const toggle = result.TaskPresetToggle({ source: { kind: 'thread', id: 'parent' }, open: false, onToggle() {} })
  assert.equal(toggle.props['aria-label'], '委託のパネルを開く')
  assert.equal(toggle.props['aria-pressed'], false)
})
