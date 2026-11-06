import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { inspect } from 'node:util'
import { compactPrintedLines, compactPtcResult, patchPtcResultsSource } from '../server/ptc-results-patch.js'

const require = createRequire(import.meta.url)
const executorSource = () => fs.readFile(require.resolve('@deepseek-ai/dsh-tool-executor-ptc'), 'utf8')
const fileText = 'x'.repeat(14_000)

test('edit and write give the program the path, not the whole file twice', () => {
  assert.deepEqual(compactPtcResult('edit', { path: 'a.js', before: fileText, after: fileText }), { path: 'a.js' })
  assert.deepEqual(compactPtcResult('write', { path: 'a.js', operation: 'create', before: null, after: fileText }), { path: 'a.js', operation: 'create' })
})

test('apply_patch keeps its statuses and paths but drops each file text', () => {
  const value = { phase: 'commit', cancelled: false, affectedPaths: ['a.js'], operations: [
    { kind: 'update', status: 'completed', changes: [{ path: 'a.js', before: fileText, after: fileText }] },
    { kind: 'delete', status: 'completed', changes: [{ path: 'b.js', before: fileText, after: null }] },
    { kind: 'update', status: 'failed', code: 'conflict', message: 'no match', changes: [] },
  ] }
  assert.deepEqual(compactPtcResult('apply_patch', value), { phase: 'commit', cancelled: false, affectedPaths: ['a.js'], operations: [
    { kind: 'update', status: 'completed', changes: [{ path: 'a.js' }] },
    { kind: 'delete', status: 'completed', changes: [{ path: 'b.js' }] },
    { kind: 'update', status: 'failed', code: 'conflict', message: 'no match', changes: [] },
  ] })
})

test('programs still get read lines with their numbers', () => {
  const value = { path: 'a.js', offset: 4, totalLines: 9, lines: [{ number: 4, text: 'one' }] }
  assert.equal(compactPtcResult('read', value), value)
})

const readValue = { path: 'a.js', offset: 3, totalLines: 9, lines: [
  { number: 3, text: "const a = 'x'" }, { number: 4, text: '' }, { number: 5, text: 'long '.repeat(30) }, { number: 6, text: 'end' },
] }

for (const [form, print] of [
  ['console.log', (value) => inspect(value, { depth: 4, maxArrayLength: 100 })],
  ['JSON.stringify', (value) => JSON.stringify(value)],
  ['pretty JSON.stringify', (value) => JSON.stringify(value, null, 2)],
]) {
  test(`printed read lines keep their numbers and text, shorter, through ${form}`, () => {
    const printed = print(readValue), compact = compactPrintedLines(printed)
    assert.ok(compact.length < printed.length)
    assert.doesNotMatch(compact, /\bnumber\b/)
    for (const entry of readValue.lines) assert.match(compact, new RegExp(`(^|\\s|\\[)${entry.number} `))
    assert.ok(compact.includes('const a ='))
    assert.ok(compact.includes('long long'))
    assert.ok(compact.includes('a.js'))
    assert.ok(compact.includes('totalLines'))
  })
}

test('text that only resembles line entries stays as it is', () => {
  for (const text of [
    "{ number: 1, text: 'one' }",
    "[{ number: 1, text: 'a' }, { number: 2, text: 'b' }]",
    "[{ number: 1, text: 'a' }, { number: 5, text: 'b' }, { number: 9, text: 'c' }]",
    "{ number: 1, text: 'a' }\nother\n{ number: 2, text: 'b' }\n{ number: 3, text: 'c' }",
    'no such thing',
  ]) assert.equal(compactPrintedLines(text), text)
})

test('an entry written inside a file line is not unpacked', () => {
  const lines = [1, 2, 3].map((number) => ({ number, text: `row { number: ${number}, text: 'inner' }` }))
  const compact = compactPrintedLines(JSON.stringify(lines))
  assert.ok(compact.includes("row { number: 2, text: 'inner' }"))
})

test('the declared output matches the compacted value', () => {
  const schema = Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({
    path: { type: 'string', required: true },
    before: { type: 'string', required: true },
    after: { type: 'string', required: true },
  }) })
  assert.deepEqual(compactPtcResult('edit', schema), { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } })
  assert.ok('before' in schema.properties)
})

test('other tools are untouched, including MCP tools with the same keys', () => {
  const value = { before: 'keep', after: 'keep' }
  assert.equal(compactPtcResult('pwsh', value), value)
  assert.equal(compactPtcResult('mcp__repo__compare', value), value)
})

test('a lone before or after field is not file text', () => {
  assert.deepEqual(compactPtcResult('edit', { path: 'a.js', after: 'kept' }), { path: 'a.js', after: 'kept' })
})

test('the patch changes the program value, the declaration and the printed text, not what the log and UI receive', async () => {
  const patched = patchPtcResultsSource(await executorSource())
  assert.ok(patched)
  assert.match(patched, /value: agentDeskCompactResult\(name, result\.value\)/)
  assert.match(patched, /output: agentDeskCompactResult\(definition\.name, definition\.output\.schema\)/)
  assert.match(patched, /agentDeskCompactPrinted\(value\.logs\.join\("\\n"\)\), agentDeskCompactPrinted\(rendered\)/)
  assert.match(patched, /content: result\.content,?\s/)
  assert.match(patched, /\.\.\.result\.meta === void 0 \? \{\} : \{ meta: result\.meta \}/)
  assert.equal(patchPtcResultsSource(patched), null)
})

test('a changed executor is refused so the full result stays in use', async () => {
  const source = await executorSource()
  assert.equal(patchPtcResultsSource(source.replace('value: result.value', 'value: changed')), null)
  assert.equal(patchPtcResultsSource(source.replace('output: definition.output.schema', 'output: changed')), null)
  assert.equal(patchPtcResultsSource(source.replace('const parts = [value.logs', 'const pieces = [value.logs')), null)
})
