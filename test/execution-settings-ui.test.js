import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import * as workflowEffort from '../shared/workflow-effort.js'

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
  '../model-selection': { providerReady: () => true, visibleModels: (server) => server.catalog.models },
  '../util': { effortLabel: (value) => value || '指定なし', parseModel: (value) => { const [provider, model] = JSON.parse(value); return { provider, model } } },
  './Pickers': { byNewest: () => 0, providerHeading: (server, provider) => server.catalog.providers[provider] ?? provider, PROVIDER_NOTE: {}, PROVIDER_ORDER: ['openai-codex'] },
  './Popover': {
    Dropdown: ({ trigger, children }) => jsx('div', { children: [trigger({ toggle() {}, open: false }), typeof children === 'function' ? children(() => {}) : children] }),
    MenuDivider: () => jsx('hr', {}), MenuHeading: (props) => jsx('div', props),
    MenuItem: (props) => jsx('button', { ...props, children: props.label }),
  },
  './useWheelSelect': { useWheelSelect: () => ({ ref: null, pending: false, shown: null }) },
})
const executionSource = await moduleSource('../web/src/components/ExecutionSettings.tsx')
const CHILD_VALUE = JSON.stringify(['openai-codex', 'eco-child'])
const LEADER_VALUE = JSON.stringify(['openai-codex', 'eco-leader'])
const UNKNOWN = Symbol('unknown capabilities')

function mountExecutionDialog({ childCapabilities = [], childEffort = 'high', leaderEffort = '' } = {}) {
  const models = {
    leader: LEADER_VALUE, provider: 'gpt', model: 'eco-child',
    leaderEffort, childEffort, toolMode: 'native',
  }
  const server = {
    settings: { agentTeams: {} },
    catalog: {
      providers: { 'openai-codex': 'GPT' },
      models: [
        { provider: 'openai-codex', id: 'eco-leader', value: LEADER_VALUE, name: 'Eco leader', description: null },
        { provider: 'openai-codex', id: 'eco-child', value: CHILD_VALUE, name: 'Eco child', description: null },
      ],
      effortsByModel: {
        [LEADER_VALUE]: [],
        ...(childCapabilities === UNKNOWN ? {} : { [CHILD_VALUE]: childCapabilities.map((value) => ({ value, name: value })) }),
      },
    },
    accounts: {
      chatgpt: { signedIn: true }, claude: { configured: true }, deepseek: { configured: true },
      opencodeGo: { configured: true }, localLlm: { configured: true },
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
  const teamStarts = []
  const selection = (_server, _provider, leader, child) => ({
    leaderModels: [{ value: LEADER_VALUE }], childModels: [{ id: 'eco-child', value: CHILD_VALUE }],
    leader: leader === LEADER_VALUE ? LEADER_VALUE : '', model: child === 'eco-child' ? child : '',
  })
  const dependencies = {
    react, 'react/jsx-runtime': jsxRuntime, 'lucide-react': { Plus: 'Plus', Trash2: 'Trash2' },
    '../store': {
      act: async (type, params = {}) => {
        rpcCalls.push({ type, params })
        if (type === 'execution.models') return { models }
        if (type === 'execution.setModels') return { models: params.models }
        if (type === 'execution.checks') return { checks: [] }
        if (type === 'execution.configure') return { configured: true }
        return { ok: true }
      },
      setState() {}, startTeam: async (...args) => { teamStarts.push(args); return true },
      useStore: (selector) => selector({ server }),
    },
    '../model-selection': {
      executionModelSelection: selection,
      executionChildChoice: (_server, value) => value === CHILD_VALUE ? { provider: 'gpt', model: 'eco-child' } : null,
    },
    '../execution-checks': { nextCheckId: () => 'check-1' },
    './WorkflowModelField': fieldComponents,
    '../../../shared/workflow-effort.js': workflowEffort,
    './Modal': { Modal: ({ children }) => jsx('div', { children }) },
    './PtcToggle': { PtcToggle: () => null },
    './ClaudeAuthConsent': { ClaudeAuthConsent: () => null },
  }
  const component = compile(executionSource, dependencies).ExecutionStartDialog
  function resolve(node) {
    if (Array.isArray(node)) return node.map(resolve)
    if (!node || typeof node !== 'object') return node
    if (node.type === jsxRuntime.Fragment) return resolve(node.props.children)
    if (typeof node.type === 'function') return resolve(node.type(node.props))
    return { ...node, props: { ...node.props, children: resolve(node.props?.children) } }
  }
  const render = () => {
    cursor = 0
    tree = resolve(component({ workspace: 'C:\\eco-test' }))
    return tree
  }
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
  return { async ready() { await settle(); return tree }, render, walk: (predicate) => walk(tree, predicate), teamStarts, rpcCalls }
}

async function click(node) {
  node.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
}

test('eco blocks unsupported saved child effort without rewriting it on open', async () => {
  const ui = mountExecutionDialog({ childCapabilities: [], childEffort: 'high' })
  await ui.ready()
  const start = ui.walk(node => node.type === 'button' && node.props.children === '始める')[0]
  const disabled = start.props.disabled
  const savedAgainOnOpen = ui.rpcCalls.some(({ type }) => type === 'execution.setModels')
  await click(start)
  assert.deepEqual({ disabled, savedAgainOnOpen, dispatched: ui.teamStarts.length > 0 }, { disabled: true, savedAgainOnOpen: false, dispatched: false })
})

test('eco blocks an unsupported saved leader effort too', async () => {
  const ui = mountExecutionDialog({ childCapabilities: [], childEffort: '', leaderEffort: 'high' })
  await ui.ready()
  const start = ui.walk(node => node.type === 'button' && node.props.children === '始める')[0]
  const disabled = start.props.disabled
  await click(start)
  assert.deepEqual({ disabled, dispatched: ui.teamStarts.length > 0 }, { disabled: true, dispatched: false })
})

test('eco lets the real effort menu clear a stale value before sending', async () => {
  const ui = mountExecutionDialog({ childCapabilities: [], childEffort: 'high' })
  await ui.ready()
  const trigger = ui.walk(node => node.type === 'button' && String(node.props['aria-label']).startsWith('子の推論レベル:'))[0]
  const clear = ui.walk(node => node.type === 'button' && node.props.label === '指定なし')[0]
  const unsupportedShown = String(trigger.props['aria-label']).includes('非対応')
  if (clear) {
    clear.props.onSelect()
    ui.render()
    await ui.ready()
    const start = ui.walk(node => node.type === 'button' && node.props.children === '始める')[0]
    await click(start)
  }
  assert.deepEqual({ unsupportedShown, clearAvailable: Boolean(clear), dispatchedEffort: ui.teamStarts[0]?.[1]?.gpt?.low?.effort }, {
    unsupportedShown: true, clearAvailable: true, dispatchedEffort: null,
  })
})

test('eco does not block an explicit effort while model capabilities are unknown', async () => {
  const ui = mountExecutionDialog({ childCapabilities: UNKNOWN, childEffort: 'high' })
  await ui.ready()
  const start = ui.walk(node => node.type === 'button' && node.props.children === '始める')[0]
  const disabled = start.props.disabled
  await click(start)
  assert.deepEqual({ disabled, dispatchedEffort: ui.teamStarts[0]?.[1]?.gpt?.low?.effort }, { disabled: false, dispatchedEffort: 'high' })
})

test('shared model fields keep their prior no-effort UI unless eco opts in', () => {
  const field = fieldComponents.ModelField({ label: 'AB', value: 'model', groups: [], disabled: false, onChange() {}, effort: 'high', efforts: [], onEffort() {} })
  const effortDropdown = field.props.children[1].props.children[1]
  const trigger = effortDropdown.props.trigger({ toggle() {}, open: false })
  const menu = effortDropdown.props.children(() => {})
  assert.equal(trigger.props.disabled, true)
  assert.match(trigger.props['aria-label'], /指定不可/)
  assert.equal(menu.props.children.flat(Infinity).filter((item) => item && typeof item === 'object').length, 0)
})
