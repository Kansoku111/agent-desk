import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

// Exercise the real components with the same lightweight hooks host used by the AB settings tests.
const source = await fs.readFile(new URL('../web/src/components/Ab.tsx', import.meta.url), 'utf8')
const jsx = (type, props, key) => ({ type, props: { ...props, ...(key === undefined ? {} : { key }) } })
const jsxRuntime = { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') }

function mount(run) {
  const state = { server: { ab: [run], catalog: { models: [] } }, turns: {}, agentTurns: {} }
  const loaded = []
  const slots = [], deps = []
  let cursor = 0, dirty = false, effects = []
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value) => {
        const next = typeof value === 'function' ? value(slots[index]) : value
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true }
      }]
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useEffect(callback, dependencies) {
      const index = cursor++
      const previous = deps[index]
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        deps[index] = [...dependencies]; effects.push(callback)
      }
    },
  }
  react.useLayoutEffect = react.useEffect
  const dependencies = {
    react, 'react/jsx-runtime': jsxRuntime,
    'lucide-react': { Loader2: 'Loader2', PanelLeftOpen: 'PanelLeftOpen', Square: 'Square', Trash2: 'Trash2' },
    '../store': {
      useStore: (select) => select(state), setState() {}, navigate() {}, act() {},
      loadAgentTurns: (id) => { loaded.push(id); state.agentTurns[id] = [] },
      loadThread: (id) => { loaded.push(id); state.turns[id] = [] },
    },
    './UsageCost': { UsageCost: 'UsageCost' },
    '../../../shared/usage-score.js': { scoresUpTo: () => [] },
    './ThreadView': { OpenInMenu: 'OpenInMenu' }, './TurnView': { TurnView: 'TurnView' },
    '../ab-transcript': { abTimeline: (value) => value.jobs.map((job) => ({ kind: 'job', job, key: job.id })) },
    '../../../shared/workflow-effort.js': {},
    './Modal': { Modal: 'Modal', ConfirmDialog: 'ConfirmDialog' }, '../util': { effortLabel: (value) => value },
    './WorkflowModelField': { CLAUDE_CODE: [], ModelField: 'ModelField' },
    './Markdown': { Markdown: 'Markdown', CopyButton: 'CopyButton' },
    './ClaudeAuthConsent': { ClaudeAuthConsent: 'ClaudeAuthConsent' },
    './AbInput': { AbImages: 'AbImages', AbInput: 'AbInput', useAbDraft: () => ({}) },
    './PtcToggle': { PtcToggle: 'PtcToggle' },
  }
  const { outputText } = ts.transpileModule(source + '\nexport { Report }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  })
  const components = {}
  new Function('require', 'exports', outputText)((name) => {
    assert.ok(name in dependencies, 'unexpected dependency: ' + name)
    return dependencies[name]
  }, components)
  const render = (component, props) => {
    let tree
    for (let round = 0; round < 10; round++) {
      cursor = 0; dirty = false; tree = component(props)
      for (const effect of effects.splice(0)) effect()
      if (!dirty) return tree
    }
    throw new Error('hooks did not settle')
  }
  return { ...components, state, loaded, render }
}

const job = (id, role, status = 'completed', report = 'report') => ({ id, role, model: 'fixture', status, report })
const makeRun = (jobs) => ({ id: 'run', workspace: 'fixture', title: 'AB', text: '', config: {}, phase: 'completed', jobs, messages: [] })
const findReports = (node, report, found = []) => {
  if (Array.isArray(node)) { node.forEach((child) => findReports(child, report, found)); return found }
  if (!node || typeof node !== 'object') return found
  if (node.type === report) found.push(node.props)
  findReports(node.props?.children, report, found)
  return found
}

test('AB opens direct implementations before completion and in older history', () => {
  const run = makeRun([job('a', 'a'), job('b', 'b'), job('old', 'direct'), job('leader', 'leader'), job('direct', 'direct', 'running', '')])
  const ui = mount(run)
  const reports = () => findReports(ui.render(ui.AbView, { id: run.id }), ui.Report)
  assert.deepEqual(reports().map(({ job, open }) => [job.id, !!open]), [
    ['a', false], ['b', false], ['old', true], ['leader', true], ['direct', true],
  ])
  run.jobs[4] = job('direct', 'direct', 'completed')
  assert.deepEqual(reports().map(({ job, open }) => [job.id, !!open]), [
    ['a', false], ['b', false], ['old', true], ['leader', false], ['direct', true],
  ])
  run.jobs.push(job('leader-2', 'leader', 'running', ''))
  assert.equal(reports().at(-1).open, false)
  run.jobs[5] = job('leader-2', 'leader')
  assert.equal(reports().at(-1).open, true)
})

test('report details follow manual toggles and later default changes', () => {
  const item = { ...job('direct', 'direct'), handle: { kind: 'claude', id: 'direct-turns' } }
  const ui = mount(makeRun([item]))
  const props = { job: item, workspace: 'fixture', modelName: 'fixture', open: true }
  const render = () => ui.render(ui.Report, props)
  let details = render()
  assert.equal(details.props.open, true)
  assert.deepEqual(ui.loaded, ['direct-turns'])
  details.props.onToggle({ currentTarget: { open: false } })
  details = render()
  assert.equal(details.props.open, false, 'manual close is respected on render')
  details.props.onToggle({ currentTarget: { open: true } })
  details = render()
  assert.equal(details.props.open, true, 'manual reopen is respected on render')
  props.open = false
  assert.equal(render().props.open, false, 'a changed latest report closes the previous report')
  props.open = true
  assert.equal(render().props.open, true, 'a newly latest report opens')
})

test('closed completed reports load their turns when opened', () => {
  for (const kind of ['claude', 'thread']) {
    const item = { ...job('leader', 'leader'), handle: { kind, id: 'leader-turns' } }
    const ui = mount(makeRun([item]))
    const props = { job: item, workspace: 'fixture', modelName: 'fixture', open: false }
    let details = ui.render(ui.Report, props)
    assert.deepEqual(ui.loaded, [])
    details.props.onToggle({ currentTarget: { open: true } })
    details = ui.render(ui.Report, props)
    assert.equal(details.props.open, true)
    assert.deepEqual(ui.loaded, ['leader-turns'])
  }
})
