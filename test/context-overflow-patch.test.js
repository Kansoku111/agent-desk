import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { patchContextOverflowSource } from '../server/context-overflow-patch.js'
import { resolveCompatibilityModules } from '../server/dsh-compatibility.js'

const modules = resolveCompatibilityModules(fileURLToPath(new URL('../', import.meta.url)))
const source = fs.readFileSync(modules.llm, 'utf8')
const require = createRequire(modules.llm)
const { isContextOverflow } = await import(new URL('dist/utils/overflow.js', pathToFileURL(modules.pi)).href)
const llm = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
function classifier(source) {
  const start = source.indexOf('function mapStopReason(')
  const end = source.indexOf('\n}', start)
  return new Function('isContextOverflow', 'isContextWindowExceededError', 'CONTEXT_WINDOW_EXCEEDED_CODE', 'EMPTY_RESPONSE_CODE', 'classifyPiAiError',
    source.slice(start, end + 2) + '; return mapStopReason')(isContextOverflow, llm.isContextWindowExceededError,
    llm.CONTEXT_WINDOW_EXCEEDED_CODE, llm.EMPTY_RESPONSE_CODE, () => 'PI_AI_ERROR')
}
const before = classifier(source)
const after = classifier(patchContextOverflowSource(source))
const response = (overrides = {}) => ({ provider: 'openai-codex', model: 'fixture', stopReason: 'stop',
  content: [{ type: 'text', text: 'completed response' }], usage: { input: 177, cacheRead: 511104, output: 748 }, ...overrides })

test('installed stop mapping takes the patch exactly once and refuses drift', () => {
  const patched = patchContextOverflowSource(source)
  assert.ok(patched)
  assert.equal(patchContextOverflowSource(patched), null)
  assert.equal(patchContextOverflowSource(source.replace('function mapStopReason(', 'function changedStop(')), null)
})

test('normal responses and compaction summaries above managed soft budgets remain successful', () => {
  for (const provider of ['openai-codex', 'anthropic']) {
    const message = response({ provider })
    assert.equal(before(message, 500000).failure.code, llm.CONTEXT_WINDOW_EXCEEDED_CODE)
    assert.deepEqual(after(message, 500000), { kind: 'stop' })
    assert.deepEqual(after(message, 1000000), before(message, 1000000))
  }
})

test('actual provider context errors and zero-output length overflow still request recovery', () => {
  for (const provider of ['openai-codex', 'anthropic', 'zai']) {
    for (const message of [response({ provider, stopReason: 'error', errorMessage: 'Your input exceeds the context window of this model' }),
      response({ provider, stopReason: 'length', usage: { input: 177, cacheRead: 511104, output: 0 } })]) {
      assert.equal(after(message, 500000).failure.code, llm.CONTEXT_WINDOW_EXCEEDED_CODE)
    }
  }
})

test('silent-overflow heuristics remain enabled for other providers', () => {
  assert.equal(after(response({ provider: 'zai' }), 500000).failure.code, llm.CONTEXT_WINDOW_EXCEEDED_CODE)
})

test('empty answers, cancellation, output limits, tool calls and unrelated errors keep their semantics', () => {
  assert.equal(after(response({ content: [] }), 500000).failure.code, llm.EMPTY_RESPONSE_CODE)
  for (const stopReason of ['toolUse', 'length', 'aborted', 'pending', 'deferred', 'error']) {
    const message = response({ stopReason })
    assert.deepEqual(after(message, 500000), before(message, 500000))
  }
})
