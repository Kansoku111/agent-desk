import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import * as workflowEffort from '../shared/workflow-effort.js'

// Renders the real dialog components with a minimal hooks host, as in execution-settings-ui.test.js.
const jsx = (type, props, key) => ({ type, props: { ...props, ...(key === undefined ? {} : { key }) } })
const jsxRuntime = { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') }
const compile = (source, modules) => {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  })
  const exports = {}
  new Function('require', 'exports', outputText)((name) => {
    assert.ok(name in modules, 'unexpected dependency: ' + name)
    return modules[name]
  }, exports)
  return exports
}
const moduleSource = async (file) => fs.readFile(new URL(file, import.meta.url), 'utf8')
const fieldSource = await moduleSource('../web/src/components/WorkflowModelField.tsx')
const fieldComponents = compile(fieldSource, {
  react: {}, 'react/jsx-runtime': jsxRuntime, 'lucide-react': { ChevronDown: 'ChevronDown' },
  '../model-selection': { isModelVisible: () => true, providerReady: () => true, visibleModels: (server) => server.catalog.models },
  '../util': { effortLabel: (value) => value || '指定なし', parseModel: (value) => { const [provider, model] = JSON.parse(value); return { provider, model } } },
  './Pickers': { byNewest: () => 0, providerHeading: (server, provider) => server.catalog.providers[provider] ?? provider, PROVIDER_NOTE: {}, PROVIDER_ORDER: ['openai-codex'] },
  './Popover': {
    Dropdown: ({ trigger, children }) => jsx('div', { children: [trigger({ toggle() {}, open: false }), typeof children === 'function' ? children(() => {}) : children] }),
    MenuDivider: () => jsx('hr', {}), MenuHeading: (props) => jsx('div', props),
    MenuItem: (props) => jsx('button', { ...props, children: props.label }),
  },
  './useWheelSelect': { useWheelSelect: () => ({ ref: null, pending: false, shown: null }) },
})
const abSource = await moduleSource('../web/src/components/Ab.tsx')
const inputSource = await moduleSource('../web/src/components/AbInput.tsx')

const NO_LEVELS = JSON.stringify(['openai-codex', 'no-levels'])
const LOW_ONLY = JSON.stringify(['openai-codex', 'low-only'])

function mountAbStartDialog({ config, effortsByModel = { [NO_LEVELS]: [], [LOW_ONLY]: [{ value: 'low' }] } } = {}) {
  const saved = { a: NO_LEVELS, b: NO_LEVELS, leader: NO_LEVELS, implementer: NO_LEVELS,
    efforts: { a: 'high', b: 'high', leader: 'high', implementer: 'high' },
    lean: true, delegate: false, review: false, toolMode: 'native', ...config }
  const server = {
    catalog: {
      providers: { 'openai-codex': 'GPT' },
      models: [
        { provider: 'openai-codex', id: 'no-levels', value: NO_LEVELS, name: 'レベルなし' },
        { provider: 'openai-codex', id: 'low-only', value: LOW_ONLY, name: 'lowのみ' },
      ],
      effortsByModel,
    },
  }
  const slots = []
  const effectDeps = []
  let cursor = 0
  let tree
  let queued = []
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(callback, dependencies) {
      const index = cursor++
      const previous = effectDeps[index]
      const changed = !Object.hasOwn(effectDeps, index) || !dependencies || dependencies.length !== previous.length || dependencies.some((value, i) => !Object.is(value, previous[i]))
      if (changed) { effectDeps[index] = dependencies ? [...dependencies] : null; queued.push(callback) }
    },
  }
  const rpcCalls = []
  const navigations = []
  const store = {
    act: async (type, params = {}) => {
      rpcCalls.push({ type, params })
      if (type === 'ab.config') return { config: structuredClone(saved) }
      if (type === 'ab.create') return { run: { id: 'R1' } }
      return { ok: true }
    },
    setState() {}, navigate: (route) => navigations.push(route),
    useStore: (selector) => selector({ server }),
    loadAgentTurns: async () => {}, loadThread: async () => {},
    attachmentUrl: (file) => `/attachments/${file}`, isTouch: () => false, uploadAttachment: async () => null,
  }
  const inputComponents = compile(inputSource, {
    react, 'react/jsx-runtime': jsxRuntime,
    'lucide-react': { Loader2: 'Loader2', X: 'X' },
    '../store': store,
  })
  const dependencies = {
    react: { ...react, useLayoutEffect: react.useEffect }, 'react/jsx-runtime': jsxRuntime,
    'lucide-react': { Loader2: 'Loader2', PanelLeftOpen: 'PanelLeftOpen', Square: 'Square', Trash2: 'Trash2', X: 'X', ChevronDown: 'ChevronDown' },
    '../store': store,
    '../model-selection': { isModelVisible: () => true, providerReady: () => true, visibleModels: (server) => server.catalog.models },
    './WorkflowModelField': fieldComponents,
    '../../../shared/workflow-effort.js': workflowEffort,
    '../../../shared/usage-score.js': { scoresUpTo: () => [] },
    './Modal': { Modal: ({ children }) => jsx('div', { children }), ConfirmDialog: () => null },
    './PtcToggle': { PtcToggle: () => null },
    './ClaudeAuthConsent': { ClaudeAuthConsent: () => null },
    './UsageCost': { UsageCost: () => null },
    './ThreadView': { OpenInMenu: () => null },
    './TurnView': { TurnView: () => null },
    './Markdown': { Markdown: (props) => jsx('div', props), CopyButton: () => null },
    '../ab-transcript': { abTimeline: () => [] },
    '../util': { effortLabel: (value) => value || '指定なし' },
    './AbInput': inputComponents,
  }
  const abComponents = compile(abSource, dependencies)
  function resolve(node) {
    if (Array.isArray(node)) return node.map(resolve)
    if (!node || typeof node !== 'object') return node
    if (node.type === jsxRuntime.Fragment) return resolve(node.props.children)
    if (typeof node.type === 'function') return resolve(node.type(node.props))
    return { ...node, props: { ...node.props, children: resolve(node.props?.children) } }
  }
  const render = () => { cursor = 0; tree = resolve(abComponents.AbStartDialog({ workspace: 'C:\\ab-test' })); return tree }
  const settle = async () => {
    let rounds = 0
    while (queued.length) {
      const batch = queued.splice(0)
      for (const callback of batch) callback()
      await new Promise((resolve) => setImmediate(resolve))
      render()
      if (++rounds > 10) throw new Error('effect harness did not settle')
    }
  }
  const walk = (node, predicate, found = []) => {
    if (Array.isArray(node)) { for (const child of node) walk(child, predicate, found); return found }
    if (!node || typeof node !== 'object') return found
    if (predicate(node)) found.push(node)
    walk(node.props?.children, predicate, found)
    return found
  }
  render()
  return {
    async ready() { await settle(); return tree },
    render, walk: (predicate) => walk(tree, predicate), rpcCalls, navigations,
  }
}

const find = (node, predicate) => {
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, predicate); if (hit) return hit } return null }
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  return find(node.props?.children, predicate)
}
const clearEntryFor = (ui, label) => {
  const field = ui.walk((node) => node.type === 'div' && node.props.className === 'ab-field' && node.props.children?.[0]?.props?.children === label)[0]
  return find(field, (node) => node.type === 'button' && node.props.label === '指定なし')
}
const startButton = (ui) => ui.walk((node) => node.type === 'button' && node.props.children === '2社に相談')[0]
const effortTrigger = (ui, label) => ui.walk((node) => node.type === 'button' && String(node.props['aria-label'] ?? '').startsWith(`${label}の推論レベル`))[0]
const textarea = (ui) => ui.walk((node) => node.type === 'textarea')[0]
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)) }

async function typeText(ui, text) {
  textarea(ui).props.onChange({ target: { value: text } })
  ui.render()
  await flush()
}
async function pressEnter(ui) {
  textarea(ui).props.onKeyDown({ key: 'Enter', shiftKey: false, keyCode: 0, nativeEvent: { isComposing: false }, preventDefault() {} })
  await flush()
}
async function click(node) {
  node.props.onClick()
  await flush()
}

test('AB blocks an unsupported saved effort at the button and at draft submit without rewriting it on open', async () => {
  const ui = mountAbStartDialog()
  await ui.ready()
  const rewrittenOnOpen = ui.rpcCalls.some(({ type }) => type === 'ab.configure')
  await typeText(ui, '相談したいこと')
  const disabled = startButton(ui).props.disabled
  await pressEnter(ui)
  await click(startButton(ui))
  assert.deepEqual({
    disabled, rewrittenOnOpen,
    created: ui.rpcCalls.filter(({ type }) => type === 'ab.create').length,
    triggersUnsupported: ['相談 A', '相談 B', '判断・報告リーダー'].every((label) => String(effortTrigger(ui, label).props['aria-label']).includes('非対応')),
  }, { disabled: true, rewrittenOnOpen: false, created: 0, triggersUnsupported: true })
})

test('AB lets the effort menu clear the stale value and then starts with it sent as unset', async () => {
  const ui = mountAbStartDialog()
  await ui.ready()
  const labels = ['相談 A', '相談 B', '判断・報告リーダー']
  for (const label of labels) {
    assert.match(String(effortTrigger(ui, label).props['aria-label']), /非対応/)
    const clear = clearEntryFor(ui, label)
    assert.ok(clear, `clear entry for ${label}`)
    clear.props.onSelect()
    ui.render()
    await flush()
  }
  await typeText(ui, '相談したいこと')
  assert.equal(startButton(ui).props.disabled, false)
  await click(startButton(ui))
  const created = ui.rpcCalls.find(({ type }) => type === 'ab.create')
  assert.deepEqual(created.params.config.efforts, { a: '', b: '', leader: '', implementer: 'high' })
  assert.equal(created.params.text, '相談したいこと')
  assert.equal(ui.navigations.length, 1)
})

test('AB keeps an explicit saved effort while the model capabilities stay unknown', async () => {
  const ui = mountAbStartDialog({ effortsByModel: { [LOW_ONLY]: [{ value: 'low' }] } })
  await ui.ready()
  await typeText(ui, 'unknown capabilities are not a reason to block')
  assert.equal(startButton(ui).props.disabled, false)
  await click(startButton(ui))
  const created = ui.rpcCalls.find(({ type }) => type === 'ab.create')
  assert.deepEqual(created.params.config.efforts, { a: 'high', b: 'high', leader: 'high', implementer: 'high' })
})

test('AB ignores the unused implementer effort while delegation is off and requires it once delegated', async () => {
  const ui = mountAbStartDialog({
    config: { a: LOW_ONLY, b: LOW_ONLY, leader: LOW_ONLY, implementer: NO_LEVELS,
      efforts: { a: 'low', b: 'low', leader: 'low', implementer: 'high' } },
  })
  await ui.ready()
  await typeText(ui, 'delegate choice matters')
  const undelegated = startButton(ui).props.disabled
  const delegate = ui.walk((node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === false && node.props.disabled === false)[0]
  delegate.props.onChange({ target: { checked: true } })
  ui.render()
  await flush()
  assert.deepEqual({ undelegated, delegated: startButton(ui).props.disabled }, { undelegated: false, delegated: true })
})
