import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import * as textLimits from '../shared/text-limits.js'

const source = await fs.readFile(new URL('../web/src/components/settings/PersonalizeSettings.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
})

const Fragment = Symbol('Fragment')
const jsx = (type, props, key) => ({ type, props: { ...props, ...(key === undefined ? {} : { key }) } })
const icon = (name) => function Icon() { return { type: name, props: {} } }

function mount(initialItems = [], { onRequest } = {}) {
  let state = { server: { settings: { customInstructionItems: structuredClone(initialItems) } } }
  const calls = []
  const toasts = []
  const slotsByPath = new Map()
  let activePath = 'root'
  let cursor = 0
  let idCounter = 0

  const getSlots = () => {
    if (!slotsByPath.has(activePath)) slotsByPath.set(activePath, [])
    return slotsByPath.get(activePath)
  }

  const react = {
    Fragment,
    useId: () => `id-${++idCounter}`,
    useState(initial) {
      const slots = getSlots()
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value
      }]
    },
  }

  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment },
    'lucide-react': {
      ChevronDown: icon('ChevronDown'),
      ChevronRight: icon('ChevronRight'),
      Loader2: icon('Loader2'),
      Plus: icon('Plus'),
      Trash2: icon('Trash2'),
    },
    '../../store': {
      useStore: (selector) => selector(state),
      getState: () => state,
      toast: (message, kind) => toasts.push({ message, kind }),
      request: async (name, args) => {
        calls.push({ name, args: structuredClone(args) })
        if (onRequest) return onRequest(name, args, {
          get items() { return state.server.settings.customInstructionItems },
          publish: (next) => { state = { server: { settings: { customInstructionItems: structuredClone(next) } } } },
        })
        state = { server: { settings: { customInstructionItems: structuredClone(args.patch.customInstructionItems) } } }
        return { settings: state.server.settings }
      },
    },
    '../../outbox': { messageId: () => `msg-${++idCounter}` },
    '../../../../shared/text-limits.js': textLimits,
    './PersonalizeSettings.css': {},
  }

  const exports = {}
  new Function('require', 'exports', outputText)((name) => {
    assert.ok(name in modules, `unexpected import: ${name}`)
    return modules[name]
  }, exports)

  const expand = (node, path) => {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}[${index}]`))
    if (!node || typeof node !== 'object') return node
    if (node.type === Fragment) return expand(node.props?.children, path)
    if (typeof node.type === 'function') {
      const key = node.props?.key ?? node.type.name ?? 'fn'
      const nextPath = `${path}/${key}`
      const prevPath = activePath
      const prevCursor = cursor
      activePath = nextPath
      cursor = 0
      try {
        return expand(node.type(node.props ?? {}), nextPath)
      } finally {
        activePath = prevPath
        cursor = prevCursor
      }
    }
    if (node.props && 'children' in node.props) {
      return { ...node, props: { ...node.props, children: expand(node.props.children, path) } }
    }
    return node
  }

  let tree
  const render = () => {
    idCounter = 0
    tree = expand(jsx(exports.PersonalizeSettings, {}), 'root')
    return tree
  }
  const walk = (node, predicate) => {
    if (Array.isArray(node)) return node.flatMap((child) => walk(child, predicate))
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)]
  }
  const textOf = (node) => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (!node || typeof node !== 'object') return ''
    return textOf(node.props?.children)
  }

  render()
  return {
    calls,
    toasts,
    render,
    setItems: (next) => { state = { server: { settings: { customInstructionItems: structuredClone(next) } } } },
    items: () => state.server.settings.customInstructionItems,
    find: (predicate) => walk(tree, predicate),
    button: (label) => walk(tree, (node) => node.type === 'button' && textOf(node) === label)[0],
    switches: () => walk(tree, (node) => node.type === 'input' && node.props?.role === 'switch'),
    errors: () => walk(tree, (node) => node.type === 'p' && node.props?.className === 'form-error').map(textOf),
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

const sample = [
  { id: 'a', title: '口調', body: '日本語で回答', enabled: true, targets: { dsh: true, claude: true } },
  { id: 'b', title: 'Git', body: 'コミット前に確認', enabled: false, targets: { dsh: true, claude: false } },
  { id: 'c', title: 'UI', body: '簡潔に', enabled: false, targets: { dsh: false, claude: true } },
]

test('empty instruction list hides bulk on/off buttons', () => {
  const ui = mount([])
  assert.equal(ui.button('すべてオン'), undefined)
  assert.equal(ui.button('すべてオフ'), undefined)
  assert.ok(ui.button('追加'))
})

test('bulk on and off buttons update all items in one action and disable when already in that state', async () => {
  const ui = mount(sample)
  const onBtn = ui.button('すべてオン')
  const offBtn = ui.button('すべてオフ')
  assert.equal(onBtn.props.disabled, false)
  assert.equal(offBtn.props.disabled, false)

  onBtn.props.onClick()
  await flush()
  ui.render()

  assert.equal(ui.calls.length, 1)
  assert.equal(ui.calls[0].name, 'settings.update')
  assert.deepEqual(ui.calls[0].args.patch.customInstructionItemsBase, sample)
  assert.deepEqual(ui.calls[0].args.patch.customInstructionItems.map((item) => [item.id, item.enabled, item.title, item.body]), [
    ['a', true, '口調', '日本語で回答'],
    ['b', true, 'Git', 'コミット前に確認'],
    ['c', true, 'UI', '簡潔に'],
  ])
  assert.equal(ui.button('すべてオン').props.disabled, true)
  assert.equal(ui.button('すべてオフ').props.disabled, false)
  assert.deepEqual(ui.switches().map((node) => node.props.checked), [true, true, true])

  ui.button('すべてオフ').props.onClick()
  await flush()
  ui.render()

  assert.equal(ui.calls.length, 2)
  assert.deepEqual(ui.calls[1].args.patch.customInstructionItems.map((item) => item.enabled), [false, false, false])
  assert.equal(ui.button('すべてオン').props.disabled, false)
  assert.equal(ui.button('すべてオフ').props.disabled, true)
  assert.deepEqual(ui.switches().map((node) => node.props.checked), [false, false, false])
})

test('bulk action locks while saving, shows pre-commit errors, and clears them after recovery', async () => {
  let rejectPending
  let mode = 'pending'
  const ui = mount(sample, {
    onRequest: (_name, args, { items, publish }) => {
      if (mode === 'pending') {
        return new Promise((resolve, reject) => {
          rejectPending = reject
          void resolve
        })
      }
      if (mode === 'fail') throw new Error('保存エラー')
      publish(args.patch.customInstructionItems)
      return { settings: { customInstructionItems: items } }
    },
  })

  ui.button('すべてオン').props.onClick()
  ui.render()
  assert.equal(ui.button('すべてオン').props.disabled, true)
  assert.equal(ui.button('すべてオフ').props.disabled, true)

  rejectPending(new Error('通信に失敗しました'))
  await flush()
  ui.render()
  assert.deepEqual(ui.errors(), ['通信に失敗しました'])
  assert.equal(ui.button('すべてオン').props.disabled, false)
  assert.equal(ui.button('すべてオフ').props.disabled, false)

  mode = 'ok'
  ui.button('すべてオフ').props.onClick()
  await flush()
  ui.render()
  assert.deepEqual(ui.errors(), [])
  assert.deepEqual(ui.items().map((item) => item.enabled), [false, false, false])
})

test('bulk action disables when list is stale from another window and recovers when continuing', () => {
  const ui = mount(sample)
  ui.setItems(sample.map((item) => ({ ...item, enabled: false })))
  ui.render()

  assert.equal(ui.button('すべてオン').props.disabled, true)
  assert.equal(ui.button('すべてオフ').props.disabled, true)

  ui.button('下書きを残して続ける').props.onClick()
  ui.render()
  assert.equal(ui.button('すべてオン').props.disabled, false)
  assert.equal(ui.button('すべてオフ').props.disabled, true)
})
