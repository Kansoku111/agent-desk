import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { compactPtcResult, patchPtcResultsSource } from '../server/ptc-results-patch.js'

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

test('read keeps its numbered lines', () => {
  const value = { path: 'a.js', offset: 4, totalLines: 9, lines: [{ number: 4, text: 'one' }] }
  assert.equal(compactPtcResult('read', value), value)
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

test('the patch changes the program value and the declaration, not what the log and UI receive', async () => {
  const patched = patchPtcResultsSource(await executorSource())
  assert.ok(patched)
  assert.match(patched, /value: agentDeskCompactResult\(name, result\.value\)/)
  assert.match(patched, /output: agentDeskCompactResult\(definition\.name, definition\.output\.schema\)/)
  assert.match(patched, /content: result\.content,?\s/)
  assert.match(patched, /\.\.\.result\.meta === void 0 \? \{\} : \{ meta: result\.meta \}/)
  assert.equal(patchPtcResultsSource(patched), null)
})

test('a changed executor is refused so the full result stays in use', async () => {
  const source = await executorSource()
  assert.equal(patchPtcResultsSource(source.replace('value: result.value', 'value: changed')), null)
  assert.equal(patchPtcResultsSource(source.replace('output: definition.output.schema', 'output: changed')), null)
})
