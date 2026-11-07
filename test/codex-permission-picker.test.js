import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import ts from 'typescript'

const jsx = (type, props) => ({ type, props })
const source = await fs.readFile(new URL('../web/src/components/CodexPermissionPicker.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
})
const exports = {}
const modules = {
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'lucide-react': { ChevronDown: 'ChevronDown', Shield: 'Shield', ShieldAlert: 'ShieldAlert', ShieldCheck: 'ShieldCheck' },
  './Popover': { Dropdown: 'Dropdown', MenuHeading: 'MenuHeading', MenuItem: 'MenuItem' },
}
new Function('require', 'exports', outputText)((name) => {
  assert.ok(name in modules, name)
  return modules[name]
}, exports)

const modes = ['read-only', 'workspace-write', 'danger-full-access']
const labels = ['読み取りのみ', 'ワークスペース編集', 'フルアクセス']

function picker(value, disabled = false) {
  const changes = []
  let closed = 0
  const tree = exports.CodexPermissionPicker({ value, disabled, onChange: (mode) => changes.push(mode) })
  const button = tree.props.trigger({ open: false, toggle() {} })
  const menu = tree.props.children(() => closed++)
  const items = menu.props.children[1]
  return { button, items, changes, closed: () => closed }
}

test('GP permission button shows the saved mode and only offers the three GP modes', () => {
  for (const [index, mode] of modes.entries()) {
    const ui = picker(mode)
    assert.equal(ui.button.type, 'button')
    assert.match(ui.button.props.className, /\bchip\b/)
    assert.equal(ui.button.props['aria-label'], `権限: ${labels[index]}`)
    assert.equal(ui.button.props['aria-haspopup'], 'menu')
    assert.equal(ui.button.props['aria-expanded'], false)
    assert.equal(ui.button.props.disabled, false)
    assert.equal(ui.button.props.className.includes('warn'), mode === 'danger-full-access')
    assert.deepEqual(ui.items.map((item) => item.props.label), labels)
    assert.deepEqual(ui.items.map((item) => item.props.selected), modes.map((entry) => entry === mode))
    assert.deepEqual(ui.changes, [], 'rendering never changes the stored permission')
    for (const item of ui.items) item.props.onSelect()
    assert.deepEqual(ui.changes, modes, 'each choice keeps its existing RPC value')
    assert.equal(ui.closed(), 3)
  }
})

test('a locked GP disables both the trigger and choices, including an already open menu', () => {
  const ui = picker('danger-full-access', true)
  assert.equal(ui.button.props.disabled, true)
  for (const item of ui.items) {
    assert.equal(item.props.disabled, true)
    item.props.onSelect()
  }
  assert.deepEqual(ui.changes, [])
  assert.equal(ui.closed(), 0)
})
