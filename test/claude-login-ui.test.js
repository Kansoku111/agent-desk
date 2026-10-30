import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { turnAnswer } from '../web/src/turn-answer.ts'

const jsx = (type, props, key) => ({ type, props: { ...props, ...(key === undefined ? {} : { key }) } })
const runtime = { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') }
const react = {
  memo: (component) => component,
  useState: (value) => [value, () => {}],
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
  useLayoutEffect: () => {},
}
const icons = new Proxy({}, { get: (_, name) => String(name) })
const compile = async (file, modules) => {
  const source = await fs.readFile(new URL(file, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  })
  const exports = {}
  new Function('require', 'exports', outputText)((name) => {
    assert.ok(name in modules, `unexpected dependency: ${name}`)
    return modules[name]
  }, exports)
  return exports
}
const TurnView = (await compile('../web/src/components/TurnView.tsx', {
  react, 'react/jsx-runtime': runtime, 'lucide-react': icons,
  '../store': {}, './UsageCost': { UsageCost: 'UsageCost' },
  '../util': { duration: () => '0秒' },
  './Markdown': { CopyButton: 'CopyButton', Markdown: 'Markdown' },
  './FileRef': { FileRef: 'FileRef' }, './Restore': { RestoreControls: 'RestoreControls' },
  '../turn-answer': { turnAnswer },
})).TurnView
const TerminalChat = (await compile('../web/src/components/TerminalChat.tsx', {
  react, 'react/jsx-runtime': runtime, 'lucide-react': icons,
  '../store': {}, './TurnView': { TurnView: 'TurnView' }, './TeamPanel': { useLedTeam: () => null },
  './useConversationScroll': { useConversationScroll: () => ({ scroller: { current: null } }) },
})).TerminalChat

const nodes = (root) => {
  const found = []
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!node || typeof node !== 'object') return
    found.push(node)
    visit(node.props?.children)
  }
  visit(root)
  return found
}
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return node && typeof node === 'object' ? text(node.props?.children) : ''
}
const turn = (id, item) => ({
  id, startedAt: 1, endedAt: 1001, status: 'done', stopReason: null, error: null,
  user: { text: 'hello', images: [] }, items: [item],
})
const expired = { type: 'agent', id: 'a1', text: 'Login expired · Please run /login', claudeLoginRequired: true }
const props = (item, onClaudeLogin) => ({ turn: turn('t1', item), workspace: '/work', threadId: 'terminal', threadBusy: false, undoable: false, onClaudeLogin })

test('a real Claude login error is explained in Japanese and opens the terminal', () => {
  let opened = 0
  const tree = TurnView(props(expired, () => { opened++ }))
  const all = nodes(tree)
  assert.match(text(tree), /Claude Code のログインが切れました。ターミナルで \/login/)
  assert.doesNotMatch(text(tree), /Login expired/)
  assert.equal(all.find((node) => node.props?.className === 'turn-error claude-login-error').props.role, 'alert')
  const button = all.find((node) => node.type === 'button' && text(node).includes('ターミナルを開く'))
  assert.ok(button)
  button.props.onClick()
  assert.equal(opened, 1)
  assert.match(all.find((node) => node.type === 'CopyButton').props.text, /ログインが切れました/)
})

test('ordinary quoted text stays untouched and historical errors have no login action', () => {
  const quoted = { type: 'agent', id: 'a2', text: expired.text }
  const ordinary = nodes(TurnView(props(quoted, () => {})))
  assert.equal(ordinary.find((node) => node.type === 'Markdown').props.text, expired.text)
  assert.equal(ordinary.some((node) => node.type === 'button' && text(node).includes('ターミナルを開く')), false)
  const history = nodes(TurnView(props(expired)))
  assert.ok(history.some((node) => node.props?.className === 'turn-error claude-login-error'))
  assert.equal(history.some((node) => node.type === 'button' && text(node).includes('ターミナルを開く')), false)
  const resumed = { ...props(expired, () => {}), turn: { ...turn('t1', expired), items: [expired, { type: 'agent', id: 'a3', text: '続きの回答' }] } }
  assert.equal(nodes(TurnView(resumed)).some((node) => node.type === 'button' && text(node).includes('ターミナルを開く')), false)
})

test('terminal chat only offers the login action for the latest turn of a live terminal', () => {
  const onShowScreen = () => {}
  const first = turn('older', expired)
  const latest = turn('latest', { ...expired, id: 'a2' })
  const make = (state) => TerminalChat({
    terminal: { id: 'terminal', workspace: '/work', state, activity: 'idle' },
    turns: [first, latest], omitted: 0, loaded: true, error: null, onShowScreen, onRestart: () => {},
  })
  const live = nodes(make('running')).filter((node) => node.type === 'TurnView')
  assert.equal(live[0].props.onClaudeLogin, undefined)
  assert.equal(live[1].props.onClaudeLogin, onShowScreen)
  const stopped = nodes(make('stopped')).filter((node) => node.type === 'TurnView')
  assert.equal(stopped[1].props.onClaudeLogin, undefined)
})
