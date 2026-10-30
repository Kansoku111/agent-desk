import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { threadMarkdown } from '../web/src/thread-transcript.ts'
import { copyText } from '../web/src/util.ts'

const source = await fs.readFile(new URL('../web/src/components/Sidebar.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source + '\nexport { copyTerminalHistory, CopyHistoryDialog }', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
})
const jsx = (type, props) => ({ type, props })
const messages = []
let snapshot
let copy
const modules = {
  react: {}, 'react-dom': {}, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
  'lucide-react': {}, '../store': { act: async () => snapshot, toast: (...args) => messages.push(args) },
  '../thread-selection': {}, '../task-rows': {}, '../thread-transcript': { threadMarkdown }, '../ab-transcript': {},
  './Modal': { Modal: 'Modal' }, '../util': { copyText: (text) => copy(text) }, '../projectColors': {},
  './Popover': {}, './ProjectDialog': {}, './TeamPanel': {},
}
const sidebar = {}
new Function('require', 'exports', outputText)((name) => { assert.ok(name in modules, name); return modules[name] }, sidebar)
const terminal = { id: 'cl', title: 'Claude', workspace: 'C:\\work', model: 'haiku' }
const turns = [{ user: { text: '質問', images: [] }, items: [{ type: 'agent', text: '回答' }], status: 'done' }]

function nodes(root) {
  if (!root || typeof root !== 'object') return []
  return [root, ...[root.props?.children].flat(Infinity).flatMap(nodes)]
}

test('delayed clipboard denial retains the exact Claude history for another tap', async () => {
  messages.length = 0
  snapshot = { turns, omitted: 2, file: 'session.jsonl' }
  let attempted
  copy = async (text) => { attempted = text; throw new Error('activation expired') }
  let fallback
  await sidebar.copyTerminalHistory(terminal, (text) => { fallback = text })
  assert.equal(fallback, attempted)
  assert.match(fallback, /質問/)
  assert.match(fallback, /回答/)
  assert.match(fallback, /2 件/)
  assert.match(fallback, /session.jsonl/)
  assert.deepEqual(messages, [])

  let closed = false
  let copied
  copy = (text) => { copied = text; return Promise.resolve() }
  const dialog = sidebar.CopyHistoryDialog({ text: fallback, onClose: () => { closed = true } })
  const all = nodes(dialog)
  assert.equal(all.find((node) => node.type === 'textarea').props.value, fallback)
  assert.equal(all.find((node) => node.type === 'textarea').props.readOnly, true)
  all.find((node) => node.type === 'button').props.onClick()
  assert.equal(copied, fallback) // The clipboard call happens directly in the click handler.
  await Promise.resolve()
  assert.equal(closed, true)
  assert.deepEqual(messages.at(-1), ['履歴をコピーしました', 'success'])
})

test('failed retry leaves the selectable history open', async () => {
  messages.length = 0
  let closed = false
  copy = () => Promise.reject(new Error('denied'))
  const dialog = sidebar.CopyHistoryDialog({ text: '履歴', onClose: () => { closed = true } })
  nodes(dialog).find((node) => node.type === 'button').props.onClick()
  await Promise.resolve()
  assert.equal(closed, false)
  assert.match(messages.at(-1)[0], /本文を選択/)
})

test('successful and empty snapshots keep their original behavior', async () => {
  messages.length = 0
  snapshot = { turns, omitted: 0, file: null }
  copy = async () => {}
  await sidebar.copyTerminalHistory(terminal, () => assert.fail('unexpected fallback'))
  assert.deepEqual(messages.at(-1), ['履歴をコピーしました', 'success'])
  snapshot = { turns: [], omitted: 0, file: null }
  await sidebar.copyTerminalHistory(terminal, () => assert.fail('unexpected fallback'))
  assert.deepEqual(messages.at(-1), ['コピーできる会話がまだありません', 'info'])
})

test('HTTP clipboard fallback focuses and cleans up its temporary field', async () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const calls = []
  const area = { style: {}, setAttribute() {}, focus() { calls.push('focus') }, select() { calls.push('select') },
    setSelectionRange(a, b) { calls.push([a, b]) }, remove() { calls.push('remove') } }
  globalThis.window = { isSecureContext: false }
  globalThis.document = { createElement: () => area, body: { appendChild() {} }, execCommand: () => false }
  try {
    await assert.rejects(copyText('abc'), /copy failed/)
    assert.deepEqual(calls, ['focus', 'select', [0, 3], 'remove'])
  } finally {
    globalThis.window = originalWindow
    globalThis.document = originalDocument
  }
})
