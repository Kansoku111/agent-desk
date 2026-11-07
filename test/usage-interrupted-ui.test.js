import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const jsx = (type, props) => ({ type, props })
const modules = {
  react: { memo: x => x, useState: x => [x, () => {}], useEffect() {} },
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') },
  'lucide-react': new Proxy({}, { get: (_, key) => String(key) }),
  '../store': {}, './UsageCost': { UsageCost: 'UsageCost' },
  '../util': { formatTokens: String, formatTokensExact: String, formatUsd: x => '$' + x, usageModelId: String },
  './Markdown': {}, './FileRef': {}, './Restore': {}, '../turn-answer': {},
}
async function component(file, name) {
  const source = (await fs.readFile(new URL('../web/src/components/' + file, import.meta.url), 'utf8'))
    .replace('function ' + name + '(', 'export function ' + name + '(')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } })
  const result = {}
  new Function('require', 'exports', outputText)(name => { assert.ok(name in modules, name); return modules[name] }, result)
  return result[name]
}
const usageLine = await component('TurnView.tsx', 'UsageLine')
const localCard = await component('UsagePanel.tsx', 'LocalUsageCard')
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : []
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')

const usage = { requests: 3, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5, cost: null, models: ['openai-codex/fixture'] }
test('turn usage shows interrupted requests and lower bounds without extra labels on ordinary turns', () => {
  const partial = usageLine({ usage: { ...usage, interruptedRequests: 2, usageIncomplete: true, reasoningIncomplete: true }, taskCost: null })
  assert.match(partial.props.title, /リクエスト 3 回（中断 2 回）/)
  assert.match(partial.props.title, /うち推論 ≥ 5/)
  assert.match(partial.props.title, /未算定/)
  assert.match(text(partial), /入力 ≥ 100/)
  assert.match(text(partial), /出力 ≥ 20/)
  const normal = usageLine({ usage, taskCost: null })
  assert.doesNotMatch(text(normal), /≥|中断|未算定/)
})

test('daily, model and chart token totals preserve the unavailable-usage marker', () => {
  const totals = { ...usage, unpriced: 1, interruptedRequests: 2, usageIncomplete: 2 }
  const root = localCard({ local: { today: totals, month: totals, all: totals, since: '2026-11-08', providers: {}, models: [{ model: 'unknown', month: totals, all: totals }], daily: [{ day: '2026-11-08', cost: 0, tokens: 120, unpriced: 1, usageIncomplete: true }], updatedAt: 0 } })
  const all = nodes(root)
  assert.equal(all.find(x => x.props?.label === '今日').props.sub, '全モデルで ≥ 120 トークン')
  assert.equal(all.find(x => x.props?.label === '今月').props.sub, '全モデルで ≥ 120 トークン')
  assert.match(all.find(x => x.props?.points).props.points[0].title, /≥ 120 トークン/)
  assert.ok(all.some(x => x.type === 'td' && x.props.title === '中断 2 回を含みます'))
  assert.match(text(root), /≥ 100/)
  assert.match(text(root), /≥ 20/)
})
