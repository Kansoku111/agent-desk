import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import ts from 'typescript'

const source = await fs.readFile(new URL('../web/src/components/CodexQuestionCard.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
})
const questions = [
  { id: 'mode', header: '方式', question: '選んでください', isOther: true, isSecret: false, options: [{ label: 'A', description: 'Aの説明' }, { label: 'B', description: 'Bの説明' }] },
  { id: 'detail', header: '補足', question: '入力してください', isOther: false, isSecret: true, options: null },
]

function fixture() {
  const state = [], calls = [], reloads = []
  let cursor = 0, result = { accepted: true }
  const modules = {
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    react: {
      useId: () => 'question-form',
      useState: initial => {
        const slot = cursor++
        if (!(slot in state)) state[slot] = initial
        return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
      },
      useRef: initial => {
        const slot = cursor++
        return state[slot] ??= { current: initial }
      },
    },
    '../store': { act: async (method, params) => { calls.push({ method, params }); return result }, loadCodexPermissions: async id => { reloads.push(id) } },
  }
  const exports = {}
  new Function('require', 'exports', outputText)(name => { assert.ok(name in modules, name); return modules[name] }, exports)
  const render = () => { cursor = 0; return exports.CodexQuestionCard({ taskId: 'task', permission: { requestId: '42', title: '質問', kind: 'user-input', questions } }) }
  return { render, calls, reloads, fail: () => { result = null } }
}

function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate))
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}
const inputs = tree => nodes(tree, node => node.type === 'input')
const submitButton = tree => nodes(tree, node => node.type === 'button' && node.props.type === 'submit')[0]

test('question card renders descriptions, requires explicit choices and sends all answers once', async () => {
  const ui = fixture()
  let tree = ui.render()
  assert.equal(submitButton(tree).props.disabled, true)
  assert.deepEqual(inputs(tree).map(node => node.props.type), ['radio', 'radio', 'radio', 'text', 'password'])
  assert.ok(inputs(tree).filter(node => node.props.type === 'radio').every(node => !node.props.checked))
  assert.deepEqual(nodes(tree, node => node.type === 'small').map(node => node.props.children), ['Aの説明', 'Bの説明'])
  inputs(tree)[1].props.onChange()
  inputs(tree)[4].props.onChange({ target: { value: 'synthetic-secret' } })
  tree = ui.render()
  assert.equal(submitButton(tree).props.disabled, false)
  assert.equal(inputs(tree)[1].props.checked, true)
  const event = { preventDefault() {} }
  tree.props.onSubmit(event)
  tree.props.onSubmit(event)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ui.calls, [{ method: 'codex.task.answer', params: { taskId: 'task', requestId: '42', answers: { mode: { answers: ['B'] }, detail: { answers: ['synthetic-secret'] } } } }])
  assert.deepEqual(ui.reloads, ['task'])
})

test('free text replaces a radio choice and failed submission retains the answer for retry', async () => {
  const ui = fixture()
  ui.fail()
  let tree = ui.render()
  inputs(tree)[0].props.onChange()
  inputs(tree)[3].props.onChange({ target: { value: '別の方式' } })
  inputs(tree)[4].props.onChange({ target: { value: '補足' } })
  tree = ui.render()
  assert.equal(inputs(tree)[0].props.checked, false)
  assert.equal(inputs(tree)[2].props.checked, true)
  tree.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ui.calls[0].params.answers.mode, { answers: ['別の方式'] })
  assert.equal(inputs(ui.render())[3].props.value, '別の方式')
  assert.deepEqual(ui.reloads, [])
})

test('skip sends an empty map without requiring any answer', async () => {
  const ui = fixture()
  const tree = ui.render()
  nodes(tree, node => node.type === 'button' && node.props.type === 'button')[0].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ui.calls[0].params.answers, {})
  assert.deepEqual(ui.reloads, ['task'])
})
