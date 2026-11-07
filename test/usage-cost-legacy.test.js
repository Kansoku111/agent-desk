import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import * as scoreModule from '../shared/usage-score.js'

let open = false
const jsx = (type, props) => ({ type, props })
const source = await fs.readFile(new URL('../web/src/components/UsageCost.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } })
const modules = { react: { useState: () => [open, () => {}] }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') },
  'react-dom': { createPortal: value => value }, '../store': { useStore: selector => selector({ server: { settings: { usageCurrency: 'USD' } } }) },
  '../../../shared/usage-score.js': scoreModule, './Modal': { Modal: 'Modal' } }
const exports = {}
new Function('require', 'exports', outputText)(name => { assert.ok(name in modules, name); return modules[name] }, exports)
const nodes = value => {
  if (Array.isArray(value)) return value.flatMap(nodes)
  return value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : []
}
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')

test('legacy totals are unknown instead of a false precise value or lower bound', () => {
  open = false
  const root = exports.UsageCost({ score: { points: 285, priced: 1, unpriced: 1 }, unreliable: true })
  const button = nodes(root).find(node => node.type === 'button')
  assert.equal(text(button), 'API換算 —')
  assert.match(button.props.title, /保存値は変更していません/)
  assert.doesNotMatch(text(button), /≥|0.57/)
})

test('current known and partial totals keep the normal display', () => {
  open = false
  const known = nodes(exports.UsageCost({ score: { points: 285, priced: 1, unpriced: 0 } })).find(node => node.type === 'button')
  assert.equal(text(known), 'API換算 $0.57')
  const partial = nodes(exports.UsageCost({ score: { points: 285, priced: 1, unpriced: 1 } })).find(node => node.type === 'button')
  assert.match(text(partial), /≥/)
})
