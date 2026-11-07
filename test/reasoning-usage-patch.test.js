import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { summarizeUsage } from '../server/usage.js'
import { patchReasoningUsageSource } from '../server/reasoning-usage-patch.js'
import '../server/reasoning-usage-hook.js'

const require = createRequire(import.meta.url)
const entry = require.resolve('@deepseek-ai/dsh-llm-pi-ai')
const url = pathToFileURL(entry).href + '?reasoning-test'
const observer = registerHooks({
  load(request, context, next) {
    const loaded = next(request, context)
    return request === url ? { ...loaded, source: String(loaded.source) + '\nexport { toStreamChunks as testStream };\n' } : loaded
  },
})
const { testStream } = await import(url)
observer.deregister()

function message(reasoning) {
  return { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'openai-responses', provider: 'openai-codex', model: 'gpt-6-luna',
    usage: { input: 20, output: 20, cacheRead: 3, cacheWrite: 0, totalTokens: 43, reasoning, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 }
}
async function chunks(reasoning, type = 'done') {
  const msg = message(reasoning)
  async function* events() { yield type === 'done' ? { type, message: msg } : { type, error: { ...msg, stopReason: 'error', errorMessage: 'mock' } } }
  return Array.fromAsync(testStream(events(), 272000, undefined, 'gpt-6-luna'))
}

test('real patched adapter forwards the reasoning subset without counting it twice', async () => {
  const assembler = new BlockAssembler()
  for (const chunk of await chunks(5)) assembler.push(chunk)
  assert.deepEqual(assembler.usage, { inputTokens: 20, outputTokens: 20, totalTokens: 43, cacheReadTokens: 3, reasoningTokens: 5 })
  const event = { type: 'assistant/message', time: 1, data: { message: { id: 'response-1', source: { provider: 'openai-codex', model: 'gpt-6-luna' } }, usage: assembler.usage } }
  const total = summarizeUsage([event], 0, new Map())
  assert.equal(total.output, 20)
  assert.equal(total.reasoning, 5)
})

test('error settlements retain a valid reported reasoning subset too', async () => {
  const usage = (await chunks(7, 'error')).find(x => x.type === 'usage').usage
  assert.equal(usage.reasoningTokens, 7)
})

test('missing, ambiguous zero and invalid reasoning are not fabricated', async () => {
  for (const value of [undefined, 0, -1, 1.5, 21, Number.NaN, Infinity, '5']) {
    const usage = (await chunks(value)).find(x => x.type === 'usage').usage
    assert.equal(Object.hasOwn(usage, 'reasoningTokens'), false, String(value))
    assert.equal(usage.outputTokens, 20)
  }
})

test('source drift and a duplicate mapper fail closed', async () => {
  const original = await fs.readFile(entry, 'utf8')
  const patched = patchReasoningUsageSource(original)
  assert.ok(patched)
  assert.equal(patchReasoningUsageSource(patched), null)
  assert.equal(patchReasoningUsageSource(original.replace('function mapUsage(usage)', 'function upstreamUsage(usage)')), null)
  assert.equal(patchReasoningUsageSource(original + '\n' + original), null)
})
