import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import * as workflowEffort from '../shared/workflow-effort.js'
import { claudeCodeModels } from '../web/src/model-selection.ts'

const jsx = (type, props, key) => ({ type, props: { ...props, ...(key === undefined ? {} : { key }) } })
const jsxRuntime = { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') }
const compile = (source, modules, localStorage) => {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  })
  const exports = {}
  new Function('require', 'exports', 'localStorage', outputText)((name) => {
    assert.ok(name in modules, 'unexpected dependency: ' + name)
    return modules[name]
  }, exports, localStorage)
  return exports
}
const moduleSource = async (file) => fs.readFile(new URL(file, import.meta.url), 'utf8')
const fieldSource = await moduleSource('../web/src/components/WorkflowModelField.tsx')
const fieldComponents = compile(fieldSource, {
  react: {}, 'react/jsx-runtime': jsxRuntime, 'lucide-react': { ChevronDown: 'ChevronDown' },
  '../model-selection': { claudeCodeModels, providerReady: () => true, visibleModels: (server) => server.catalog.models },
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
const ptcSource = await moduleSource('../web/src/components/PtcToggle.tsx')
const CHILD_VALUE = JSON.stringify(['openai-codex', 'eco-child'])
const LEADER_VALUE = JSON.stringify(['openai-codex', 'eco-leader'])
const UNKNOWN = Symbol('unknown capabilities')

function mountExecutionDialog({ childCapabilities = [], childEffort = 'high', leaderEffort = '', leader = LEADER_VALUE,
  planImplement = false, legacy = false, modelsStore, browserChoice = null, onSave } = {}) {
  const models = {
    leader, provider: 'gpt', model: 'eco-child',
    leaderEffort, childEffort, toolMode: 'native', planImplement,
  }
  if (legacy) delete models.planImplement
  modelsStore ??= { models }
  let browserValue = browserChoice === null ? null : JSON.stringify(browserChoice)
  const localStorage = {
    getItem: () => browserValue,
    setItem: (_key, value) => { browserValue = value },
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
    leader: [LEADER_VALUE, 'claude:opus'].includes(leader) ? leader : '', model: child === 'eco-child' ? child : '',
  })
  const dependencies = {
    react, 'react/jsx-runtime': jsxRuntime, 'lucide-react': { Plus: 'Plus', Trash2: 'Trash2' },
    '../store': {
      act: async (type, params = {}) => {
        rpcCalls.push({ type, params })
        if (type === 'execution.models') return { models: structuredClone(modelsStore.models) }
        if (type === 'execution.setModels') {
          if (onSave && await onSave(params) === false) return null
          if (!params.onlyIfUnset || modelsStore.models === null) modelsStore.models = structuredClone(params.models)
          return { models: structuredClone(modelsStore.models) }
        }
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
    './PtcToggle': compile(ptcSource, { react, 'react/jsx-runtime': jsxRuntime }),
    './ClaudeAuthConsent': { ClaudeAuthConsent: ({ onChange }) => jsx('button', { 'aria-label': 'Claude同意', onClick: () => onChange({ ready: true, confirmation: { challenge: 'test' } }) }) },
  }
  const component = compile(executionSource, dependencies, localStorage).ExecutionStartDialog
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
  return { async ready() { await settle(); return tree }, render, walk: (predicate) => walk(tree, predicate), teamStarts, rpcCalls, modelsStore }
}

async function click(node) {
  node.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
}

const planToggle = (ui) => ui.walk((node) => node.type === 'button' && node.props['aria-label'] === '計画 → 実装')[0]
const startButton = (ui) => ui.walk((node) => node.type === 'button' && node.props.children === '始める')[0]
const savedChoices = (ui) => ui.rpcCalls.filter(({ type }) => type === 'execution.setModels')

test('eco restores older saved choices with plan → implement off and sends false', async () => {
  const ui = mountExecutionDialog({ childEffort: '', legacy: true })
  assert.equal(planToggle(ui).props.disabled, true)
  await ui.ready()
  const toggle = planToggle(ui)
  assert.equal(toggle.props.disabled, false)
  assert.equal(toggle.props['aria-pressed'], false)
  assert.equal(toggle.props.children.join(''), '計画 → 実装 OFF')
  await click(startButton(ui))
  assert.equal(savedChoices(ui).at(-1).params.models.planImplement, false)
  assert.deepEqual(ui.teamStarts[0][3], { leaderModel: LEADER_VALUE, planImplement: false })
})

test('eco saves plan → implement before starting and restores it on reopening', async () => {
  const ui = mountExecutionDialog({ childEffort: '' })
  await ui.ready()
  await click(planToggle(ui))
  ui.render()
  assert.equal(planToggle(ui).props['aria-pressed'], true)
  assert.equal(planToggle(ui).props.children.join(''), '計画 → 実装 ON')
  assert.equal(ui.modelsStore.models.planImplement, true)

  const reopened = mountExecutionDialog({ modelsStore: ui.modelsStore })
  await reopened.ready()
  assert.equal(planToggle(reopened).props['aria-pressed'], true)
  assert.equal(savedChoices(reopened).length, 0)
  await click(startButton(reopened))
  assert.deepEqual(reopened.teamStarts[0][3], { leaderModel: LEADER_VALUE, planImplement: true })
})

test('eco defaults to PTC without saved choices and preserves an explicit off choice', async () => {
  const fresh = mountExecutionDialog({ modelsStore: { models: null } })
  await fresh.ready()
  const ptc = (ui) => ui.walk((node) => node.type === 'button' && node.props['aria-label'] === 'PTC')[0]
  assert.equal(ptc(fresh).props['aria-pressed'], true)
  assert.equal(fresh.modelsStore.models.toolMode, 'ptc')
  await click(ptc(fresh))
  fresh.render()
  assert.equal(fresh.modelsStore.models.toolMode, 'native')
  const reopened = mountExecutionDialog({ modelsStore: fresh.modelsStore })
  await reopened.ready()
  assert.equal(ptc(reopened).props['aria-pressed'], false)
})

test('eco preserves PTC independently when plan → implement is toggled', async () => {
  const ui = mountExecutionDialog({ childEffort: '' })
  await ui.ready()
  const ptc = () => ui.walk((node) => node.type === 'button' && node.props['aria-label'] === 'PTC')[0]
  await click(ptc())
  ui.render()
  assert.equal(ptc().props['aria-pressed'], true)
  await click(planToggle(ui))
  ui.render()
  assert.equal(ptc().props['aria-pressed'], true)
  assert.equal(planToggle(ui).props['aria-pressed'], true)
  assert.equal(ui.modelsStore.models.toolMode, 'ptc')
  assert.equal(ui.modelsStore.models.planImplement, true)
  await click(startButton(ui))
  assert.equal(ui.teamStarts[0][1].toolMode, 'ptc')
  assert.equal(ui.teamStarts[0][3].planImplement, true)
})

test('eco saves rapid on/off selections in order and starts in the final state', async () => {
  const ui = mountExecutionDialog({ childEffort: '' })
  await ui.ready()
  const toggle = planToggle(ui)
  toggle.props.onClick()
  toggle.props.onClick()
  ui.render()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(planToggle(ui).props['aria-pressed'], false)
  assert.deepEqual(savedChoices(ui).map(({ params }) => params.models.planImplement), [true, false])
  assert.equal(ui.modelsStore.models.planImplement, false)
  await click(startButton(ui))
  assert.deepEqual(ui.teamStarts[0][3], { leaderModel: LEADER_VALUE, planImplement: false })
})

test('eco migrates old browser-only choices and leaves newer server choices intact', async () => {
  const browserChoice = { leader: LEADER_VALUE, provider: 'gpt', model: 'eco-child', leaderEffort: '', childEffort: '', toolMode: 'native' }
  const modelsStore = { models: null }
  const ui = mountExecutionDialog({ modelsStore, browserChoice })
  await ui.ready()
  assert.equal(planToggle(ui).props['aria-pressed'], false)
  assert.equal(savedChoices(ui)[0].params.onlyIfUnset, true)
  assert.equal(savedChoices(ui)[0].params.models.planImplement, false)
  assert.equal(modelsStore.models.planImplement, false)

  const newerServerChoice = mountExecutionDialog({ modelsStore, browserChoice: { ...browserChoice, planImplement: true } })
  await newerServerChoice.ready()
  assert.equal(planToggle(newerServerChoice).props['aria-pressed'], false)
  assert.equal(savedChoices(newerServerChoice).length, 0)

  const malformed = mountExecutionDialog({ modelsStore: { models: null }, browserChoice: { ...browserChoice, planImplement: 'true' } })
  await malformed.ready()
  assert.equal(planToggle(malformed).props['aria-pressed'], false)
  assert.equal(savedChoices(malformed)[0].params.models.planImplement, false)
})

test('eco waits for plan → implement save and refuses to start if it fails', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const ui = mountExecutionDialog({ childEffort: '', onSave: () => pending })
  await ui.ready()
  planToggle(ui).props.onClick()
  ui.render()
  await click(startButton(ui))
  ui.render()
  assert.equal(planToggle(ui).props.disabled, true)
  assert.equal(ui.teamStarts.length, 0)
  assert.equal(ui.rpcCalls.some(({ type }) => type === 'execution.configure'), false)
  release(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(ui.teamStarts[0][3], { leaderModel: LEADER_VALUE, planImplement: true })

  const failing = mountExecutionDialog({ childEffort: '', onSave: () => false })
  await failing.ready()
  await click(planToggle(failing))
  failing.render()
  await click(startButton(failing))
  assert.equal(failing.teamStarts.length, 0)
  assert.equal(failing.rpcCalls.some(({ type }) => type === 'execution.configure'), false)
})

test('eco sends plan → implement for a Claude Code parent after consent', async () => {
  const ui = mountExecutionDialog({ childEffort: '', leader: 'claude:opus', planImplement: true })
  await ui.ready()
  assert.equal(startButton(ui).props.disabled, true)
  await click(ui.walk((node) => node.props?.['aria-label'] === 'Claude同意')[0])
  ui.render()
  assert.equal(startButton(ui).props.disabled, false)
  await click(startButton(ui))
  assert.deepEqual(ui.teamStarts[0][2], { challenge: 'test' })
  assert.deepEqual(ui.teamStarts[0][3], { planImplement: true })
})

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
