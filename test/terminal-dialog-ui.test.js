import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const jsx = (type, props, key) => ({ type, props: { ...props, key } })
const source = await fs.readFile(new URL('../web/src/components/TerminalChat.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
})
const question = (dialogId = 'q1', options = []) => ({ dialogId, text: ['どちらの形式にしますか？'], screen: '質問の画面', options })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const nodes = (root) => Array.isArray(root) ? root.flatMap(nodes) : root && typeof root === 'object' ? [root, ...nodes(root.props?.children)] : []
const text = (root) => Array.isArray(root) ? root.map(text).join('') : root && typeof root === 'object' ? text(root.props?.children) : String(root ?? '')

function setup(t, initial = question()) {
  const savedWindow = globalThis.window
  const timers = new Map()
  globalThis.window = { setTimeout: (fn) => { const id = Symbol(); timers.set(id, fn); return id }, clearTimeout: (id) => timers.delete(id) }
  let cursor = 0, tree, next = initial, fail = '', hold = false, release
  const hooks = [], effects = [], cleanups = [], requests = []
  const react = {
    useState(value) { const i = cursor++; if (!(i in hooks)) hooks[i] = value; return [hooks[i], (value) => { hooks[i] = value }] },
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value } },
    useEffect(fn) { const i = cursor++; if (!(i in hooks)) { hooks[i] = true; effects.push(fn) } },
  }
  const request = async (type, params) => {
    requests.push({ type, ...params })
    if (type === 'terminal.dialog') return { dialog: next }
    if (hold) await new Promise((resolve) => { release = resolve })
    if (fail) throw new Error(fail)
    return { sent: true }
  }
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': {}, '../store': { request },
    './TurnView': {}, './TeamPanel': {}, './useConversationScroll': {},
  }
  const exports = {}
  new Function('require', 'exports', outputText)((name) => { assert.ok(name in modules, name); return modules[name] }, exports)
  const render = () => { cursor = 0; tree = exports.DialogCard({ terminalId: 'terminal', onShowScreen() {} }); for (const fn of effects.splice(0)) cleanups.push(fn()); return tree }
  const find = (type, label) => nodes(tree).find((node) => node.type === type && (label === undefined || text(node) === label || node.props['aria-label'] === label))
  t.after(() => { cleanups.forEach((fn) => fn?.()); globalThis.window = savedWindow })
  return {
    render, find, requests,
    setNext: (value) => { next = value }, fail: (value) => { fail = value }, hold: () => { hold = true }, release: () => { hold = false; release() },
    async poll() { const timer = timers.entries().next().value; assert.ok(timer, 'poll scheduled'); timers.delete(timer[0]); timer[1](); await flush(); render() },
    async ready() { render(); await flush(); render() },
    text: () => text(tree),
  }
}

test('free text is explicit, preserves IME/newlines, and does not implicitly confirm', async (t) => {
  const ui = setup(t)
  await ui.ready()
  ui.find('textarea').props.onChange({ target: { value: '日本語\n二行目' } }); ui.render()
  assert.equal(ui.find('textarea').props.onKeyDown, undefined, 'Enter and IME are left to the textarea')
  ui.find('button', '入力を反映').props.onClick()
  await flush(); ui.render()
  assert.deepEqual(ui.requests.filter((call) => call.type === 'terminal.respond'), [{ type: 'terminal.respond', terminalId: 'terminal', dialogId: 'q1', text: '日本語\n二行目' }])
  assert.equal(ui.find('textarea').props.value, '')
  assert.equal(ui.find('button', '確定・次へ').props.disabled, true, 'wait for refreshed screen')
  assert.match(ui.text(), /確定・次へ.*回答を送れます/)
  ui.setNext(question('q2')); await ui.poll()
  ui.find('button', '確定・次へ').props.onClick(); await flush()
  assert.equal(ui.requests.at(-1).key, 'enter')
})

test('failed text is retained, duplicate clicks are blocked, and a stale draft cannot answer another question', async (t) => {
  const ui = setup(t)
  await ui.ready()
  ui.find('textarea').props.onChange({ target: { value: '残す回答' } }); ui.render()
  ui.hold(); ui.fail('接続が切れました')
  const click = ui.find('button', '入力を反映').props.onClick
  click(); click(); await flush(); ui.render()
  assert.equal(ui.requests.filter((call) => call.type === 'terminal.respond').length, 1)
  assert.equal(ui.find('textarea').props.disabled, true)
  ui.release(); await flush(); ui.render()
  assert.equal(ui.find('textarea').props.value, '残す回答')
  assert.match(ui.text(), /接続が切れました/)
  ui.setNext(question('q2')); await ui.poll()
  assert.equal(ui.find('button', '入力を反映').props.disabled, true)
  assert.match(ui.text(), /質問の表示が変わったため/)
  ui.find('button', '入力を消す').props.onClick(); ui.render()
  assert.equal(ui.find('textarea').props.value, '')
})

test('choices use their original CLI label and screen identity; navigation and multi-select remain in chat', async (t) => {
  const ui = setup(t, question('q1', [{ key: '3', label: 'Type something.', detail: '', selected: true }]))
  await ui.ready()
  const choice = ui.find('button', '3自由入力（その他）')
  assert.ok(choice)
  choice.props.onClick(); await flush()
  assert.deepEqual(ui.requests.at(-1), { type: 'terminal.choose', terminalId: 'terminal', dialogId: 'q1', key: '3', label: 'Type something.' })
  ui.setNext(question('q2')); await ui.poll()
  ui.find('button', '選択切替').props.onClick(); await flush()
  assert.equal(ui.requests.at(-1).key, 'space')
  ui.setNext(question('q3')); await ui.poll()
  ui.find('button', 'キャンセル（Esc）').props.onClick(); await flush()
  assert.equal(ui.requests.at(-1).key, 'escape')
})
