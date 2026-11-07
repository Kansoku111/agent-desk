import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await fs.readFile(new URL('../web/src/components/TurnView.tsx', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } })
const exports = {}
const jsx = (type, props) => ({ type, props })
const modules = { react: { memo: x => x }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') },
  'lucide-react': new Proxy({}, { get: (_, key) => String(key) }), '../store': {}, './UsageCost': {}, '../util': {},
  './Markdown': {}, './FileRef': {}, './Restore': {}, '../turn-answer': {} }
new Function('require', 'exports', outputText)(name => { assert.ok(name in modules, name); return modules[name] }, exports)
const usage = (requests, models, requestsExact) => ({ requests, models, ...(requestsExact === undefined ? {} : { requestsExact }) })

test('request detail shows exact, partial and historical counts truthfully', () => {
  assert.equal(exports.usageRequestDetail(usage(2, ['codex/gpt'], true)), 'リクエスト 2 回')
  assert.equal(exports.usageRequestDetail(usage(2, ['codex/gpt'], false)), 'リクエスト 2 回以上')
  assert.equal(exports.usageRequestDetail(usage(0, ['codex/gpt'], false)), 'リクエスト数 不明')
  assert.equal(exports.usageRequestDetail(usage(1, ['codex/gpt'])), 'リクエスト数 不明')
  assert.equal(exports.usageRequestDetail(usage(2, ['openai-codex/gpt'])), 'リクエスト 2 回')
  assert.equal(exports.legacyCodexEstimate(usage(1, ['codex/gpt'])), true)
  assert.equal(exports.legacyCodexEstimate(usage(2, ['codex/gpt'], true)), false)
  assert.equal(exports.legacyCodexEstimate(usage(2, ['codex/gpt'], true), true), true)
  assert.equal(exports.legacyCodexEstimate(usage(2, ['openai-codex/gpt'])), false)
})
