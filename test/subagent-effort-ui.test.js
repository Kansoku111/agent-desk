import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { effortLabel, pickableEfforts } from '../web/src/util.ts'

const jsx = (type, props) => ({ type, props })
const nodes = (node, match) => !node || typeof node !== 'object' ? [] : [
  ...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, match)),
]
const calls = []
const server = {
  settings: { subagentModels: { anthropic: 'a', 'openai-codex': null }, subagentEfforts: { anthropic: 'high', 'openai-codex': null } },
  catalog: { models: [{ provider: 'anthropic', id: 'a', name: 'A' }, { provider: 'anthropic', id: 'b', name: 'B' }],
    effortsByModel: { '["anthropic","a"]': [{ value: 'low' }, { value: 'high' }], '["anthropic","b"]': [{ value: 'low' }] }, fallbackEfforts: [] },
}
const source = await fs.readFile(new URL('../web/src/components/settings/ModelsSettings.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source + '\nexport { Subagents }', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } })
const modules = {
  'react/jsx-runtime': { jsx, jsxs: jsx }, '../../store': { useStore: fn => fn({ server }), act: (...args) => calls.push(args) },
  '../Pickers': { byNewest: () => 0, providerReady: () => true }, '../../util': { effortLabel, pickableEfforts },
}
const result = {}
new Function('require', 'exports', outputText)(name => modules[name] ?? {}, result)
const select = label => nodes(result.Subagents(), node => node.type === 'select' && node.props['aria-label'] === label)[0]

test('subagent effort picker shows model levels and saves choices', () => {
  const effort = select('Claude のサブエージェントの推論レベル')
  assert.equal(effort.props.value, 'high')
  assert.deepEqual(nodes(effort, node => node.type === 'option').map(node => node.props.value), ['', 'low', 'high'])
  effort.props.onChange({ target: { value: 'low' } })
  assert.deepEqual(calls.at(-1)[1].patch, { subagentEfforts: { anthropic: 'low' } })
  assert.equal(select('ChatGPT のサブエージェントの推論レベル').props.disabled, true)
})

test('changing models clears only incompatible levels; disabling retains the choice', () => {
  const model = select('Claude のサブエージェントに使うモデル')
  model.props.onChange({ target: { value: 'b' } })
  assert.deepEqual(calls.at(-1)[1].patch, { subagentModels: { anthropic: 'b' }, subagentEfforts: { anthropic: null } })
  model.props.onChange({ target: { value: '' } })
  assert.deepEqual(calls.at(-1)[1].patch, { subagentModels: { anthropic: null } })
})
