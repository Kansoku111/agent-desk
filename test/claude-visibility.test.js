import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { claudeCodeModels, isModelVisible, providerReady, visibleModels } from '../web/src/model-selection.ts'

const jsx = (type, props) => ({ type, props })
const nodes = (node, match) => !node || typeof node !== 'object' ? [] : [
  ...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, match)),
]
async function load(file, modules, extra = '') {
  const source = await fs.readFile(new URL(file, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source + extra, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } })
  const result = {}
  new Function('require', 'exports', outputText)((name) => modules[name] ?? {}, result)
  return result
}
const model = { id: 'claude-sonnet-5-5', name: 'Claude Sonnet', provider: 'anthropic', value: '["anthropic","claude-sonnet-5-5"]' }
const codeValue = 'claude:claude-sonnet-5-5'
const state = {
  settings: { modelVisibility: { [model.value]: false } },
  catalog: { models: [model], providers: { anthropic: 'Claude' } },
  accounts: { claude: { configured: false }, chatgpt: { signedIn: false }, deepseek: { configured: false } },
}
const calls = []
const store = { useStore: (select) => select({ server: state }), act: (method, params) => { calls.push([method, params]); Object.assign(state.settings.modelVisibility, params.patch.modelVisibility) } }
const workflow = await load('../web/src/components/WorkflowModelField.tsx', {
  'react/jsx-runtime': { jsx, jsxs: jsx }, '../model-selection': { claudeCodeModels, isModelVisible, providerReady, visibleModels },
  './Pickers': { byNewest: () => 0, providerHeading: () => 'Claude（API）', PROVIDER_NOTE: {}, PROVIDER_ORDER: ['anthropic'] },
})
const settings = await load('../web/src/components/settings/ModelsSettings.tsx', {
  react: { useState: () => [true, () => {}] }, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../store': store,
  '../../model-selection': { isModelVisible }, '../Pickers': { byNewest: () => 0 }, '../WorkflowModelField': workflow,
}, '\nexport { ModelVisibility }')
const terminal = await load('../web/src/components/TerminalPickers.tsx', {
  react: {}, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../model-selection': { isModelVisible },
  './Pickers': { byNewest: () => 0 },
})
const render = () => settings.ModelVisibility()
const labels = () => nodes(render(), (node) => node.type === 'input').map((node) => node.props['aria-label'])
const input = (label) => nodes(render(), (node) => node.type === 'input' && node.props['aria-label'] === label)[0].props

test('settings omit unconfigured API and show distinct controls after connection', () => {
  state.accounts.claude.configured = false
  assert.ok(labels().includes('Claude Code Claude Sonnet をモデルピッカーに表示'), JSON.stringify(labels()))
  assert.ok(!labels().some((label) => label.startsWith('Claude（API）')))
  assert.ok(terminal.claudeModels(state).some((item) => item.id === model.id), 'old API visibility does not hide Code')
  state.accounts.claude.configured = true
  assert.ok(labels().includes('Claude（API） Claude Sonnet をモデルピッカーに表示'))
  assert.equal(input('Claude（API） Claude Sonnet をモデルピッカーに表示').checked, false, 'old API choice is retained')
  assert.equal(input('Claude Code Claude Sonnet をモデルピッカーに表示').checked, true)
  input('Claude Code Claude Sonnet をモデルピッカーに表示').onChange({ target: { checked: false } })
  assert.deepEqual(calls.at(-1)[1].patch.modelVisibility, { [codeValue]: false })
  assert.ok(!terminal.claudeModels(state).some((item) => item.id === model.id))
  input('Claude（API） Claude Sonnet をモデルピッカーに表示').onChange({ target: { checked: true } })
  assert.deepEqual(calls.at(-1)[1].patch.modelVisibility, { [model.value]: true })
  assert.equal(input('Claude Code Claude Sonnet をモデルピッカーに表示').checked, false)
  assert.ok(workflow.modelGroups(state).find((group) => group.id === 'anthropic').models.some((item) => item.value === model.value))
})

test('Claude Code aliases have their own visibility across picker and terminal', () => {
  input('Claude Code Haiku をモデルピッカーに表示').onChange({ target: { checked: false } })
  assert.ok(!workflow.modelGroups(state).find((group) => group.id === 'claude-code').models.some((item) => item.value === 'claude:haiku'))
  assert.ok(!terminal.claudeModels(state).some((item) => item.id === 'haiku'))
  assert.equal(input('Claude（API） Claude Sonnet をモデルピッカーに表示').checked, true)
})
