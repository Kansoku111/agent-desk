import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { isModelVisible, providerReady, visibleModels } from '../web/src/model-selection.ts'

async function load(path, modules, extra = '') {
  const source = await fs.readFile(new URL(path, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  })
  const exports = {}
  new Function('require', 'exports', outputText)((name) => {
    assert.ok(name in modules, 'unexpected dependency: ' + name)
    return modules[name]
  }, exports)
  return exports
}

const jsx = (type, props) => ({ type, props })
const common = { react: {}, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': {}, '../store': {}, '../model-selection': { isModelVisible, providerReady, visibleModels }, '../util': {}, './Popover': {}, './useWheelSelect': {}, './ProjectDialog': {} }
const pickers = await load('../web/src/components/Pickers.tsx', common)
const parseModel = (value) => { try { const [provider, id] = JSON.parse(value); return { provider, id } } catch { return null } }
const workflow = await load('../web/src/components/WorkflowModelField.tsx', { ...common, '../util': { parseModel }, './Pickers': pickers }, '\nexport { selectedName }')
const model = (provider, id, name) => ({ provider, id, name, value: JSON.stringify([provider, id]) })
const api = model('anthropic', 'claude-haiku-5-5', 'Claude Haiku')
const server = {
  catalog: { providers: { anthropic: 'Claude', 'opencode-go': 'OpenCode Go' }, models: [api, model('opencode-go', 'model-a', 'Model A')] },
  settings: { modelVisibility: {} },
  accounts: { chatgpt: { signedIn: false }, claude: { configured: true }, deepseek: { configured: false }, opencodeGo: { configured: true } },
}

test('Claude Code and Claude API remain separate groups and choices', () => {
  const groups = workflow.modelGroups(server)
  const code = groups.find((group) => group.id === 'claude-code')
  const anthropic = groups.find((group) => group.id === 'anthropic')
  assert.equal(code.heading, 'Claude Code')
  assert.equal(anthropic.heading, 'Claude（API）')
  assert.equal(anthropic.note, 'Anthropic API キー')
  assert.ok(code.models.some((entry) => entry.value === 'claude:haiku'))
  assert.deepEqual(anthropic.models, [api])
  assert.equal(pickers.providerHeading(server, 'opencode-go'), 'OpenCode Go')
  assert.equal(pickers.providerHeading(server, 'anthropic'), 'Claude（API）')
  assert.equal(workflow.selectedName(groups, 'claude:haiku'), 'Claude Code / Haiku')
  assert.equal(workflow.selectedName(groups, api.value), 'Claude（API） / Claude Haiku')
})

test('hiding Claude Code and API choices affects only the chosen route', () => {
  const state = { ...server, settings: { modelVisibility: { [api.value]: false } } }
  assert.ok(workflow.modelGroups(state).find((group) => group.id === 'claude-code').models.some((entry) => entry.value === 'claude:haiku'))
  assert.equal(workflow.modelGroups(state).some((group) => group.id === 'anthropic'), false)
  state.settings.modelVisibility = { 'claude:haiku': false }
  const groups = workflow.modelGroups(state)
  assert.ok(!groups.find((group) => group.id === 'claude-code').models.some((entry) => entry.value === 'claude:haiku'))
  assert.deepEqual(groups.find((group) => group.id === 'anthropic').models, [api])
})

test('saved but unavailable Claude choices still show their own route', () => {
  const groups = [{ id: 'current', heading: '選択済み', models: [{ value: api.value, name: api.name }, { value: 'claude:haiku', name: 'Haiku' }] }]
  assert.equal(workflow.selectedName(groups, api.value), 'Claude（API） / Claude Haiku')
  assert.equal(workflow.selectedName(groups, 'claude:haiku'), 'Claude Code / Haiku')
  assert.equal(workflow.selectedName(groups, ''), 'モデルを選択')
  const disconnected = { ...server, accounts: { ...server.accounts, claude: { configured: false } } }
  assert.equal(workflow.modelGroups(disconnected).some((group) => group.id === 'anthropic'), false)
})
