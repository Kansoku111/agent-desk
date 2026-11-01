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
]
const server = { taskPresets: runs, catalog: { providers: { 'openai-codex': 'ChatGPT' }, models: [{ value: model, name: '実装モデル' }] } }
let state
const source = await fs.readFile(new URL('../web/src/components/TaskPresets.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } })
const modules = { 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') }, '../store': { useStore: fn => fn({ server }), setState: patch => { state = patch } }, '../util': { effortLabel, parseModel } }
const result = {}
new Function('require', 'exports', outputText)(name => modules[name] ?? {}, result)

test('preset panel shows each source worker, status and saved model and opens its result', () => {
  const panel = result.TaskPresetRuns({ source: { kind: 'thread', id: 'parent' }, onClose() {} })
  const aside = nodes(panel, node => node.type === 'aside')[0]
  assert.equal(aside.props['aria-label'], '委託とレビュー')
  const cards = nodes(aside, node => node.type === 'button' && node.props.className?.includes('subagent-card'))
  assert.equal(cards.length, 2)
  assert.match(text(cards[0]), /子に委託.*作業中.*ChatGPT \/ 実装モデル.*低/)
  assert.match(text(cards[1]), /独立レビュー.*完了.*Claude Code \/ haiku.*低/)
  cards[1].props.onClick()
  assert.deepEqual(state, { presetRun: 'two' })
  const terminal = result.TaskPresetRuns({ source: { kind: 'terminal', id: 'parent' }, onClose() {} })
  assert.match(text(terminal), /別タスク/)
  assert.doesNotMatch(text(terminal), /レビュー完了/)
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
