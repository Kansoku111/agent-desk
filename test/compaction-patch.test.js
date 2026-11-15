import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { patchCompactionSource } from '../server/compaction-patch.js'
import { resolveCompatibilityModules } from '../server/dsh-compatibility.js'

const modules = resolveCompatibilityModules(fileURLToPath(new URL('../', import.meta.url)))
const source = fs.readFileSync(modules.compaction, 'utf8')
const require = createRequire(modules.compaction)
const { toolPairingBalancedBefore } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-compaction')).href)

function selector(source) {
  const start = source.indexOf('function selectCompactableRange(')
  const end = source.indexOf('\n}', start)
  return new Function('toolPairingBalancedBefore', 'systemHead', source.slice(start, end + 2) + '; return selectCompactableRange')(
    toolPairingBalancedBefore, (session, seq) => session.eventAt(seq).type === 'system/message' ? session.eventAt(seq) : undefined)
}
const before = selector(source)
const after = selector(patchCompactionSource(source))
function fixture(entries) {
  const events = entries.map(([type, tokens], seq) => ({ seq, type, data: type === 'assistant/message'
    ? { message: { content: [{ type: 'tool-call', id: 'fixture-call' }] } } : {}, tokens }))
  const session = { surface: { nodes: events.map(e => e.seq), replaceGeneration: 0 }, eventAt: seq => events[seq] }
  return [session, { nodes: events.map(e => ({ seq: e.seq, tokens: e.tokens })) }]
}

test('installed compaction selector takes the patch exactly once and refuses drift', () => {
  const patched = patchCompactionSource(source)
  assert.ok(patched)
  assert.equal(patchCompactionSource(patched), null)
  assert.equal(patchCompactionSource(source.replace('function selectCompactableRange(', 'function changedRange(')), null)
})

test('a huge imported head no longer prevents pressure compaction when the recent tail is short', () => {
  const args = fixture([['system/message', 9742], ['user/message', 204135], ['user/message', 30000], ['user/message', 33095]])
  assert.equal(before(...args, 74757), null)
  assert.deepEqual(after(...args, 74757), { start: 1, end: 1 })
})

test('ordinary retention and forced overflow ranges are unchanged', () => {
  const args = fixture([['system/message', 1000], ['user/message', 100000], ['user/message', 50000], ['user/message', 50000]])
  for (const retain of [0, 50000, 75000]) assert.deepEqual(after(...args, retain), before(...args, retain))
})

test('fallback respects pairing when retention backs into an entire tool step', () => {
  const args = fixture([['system/message', 1000], ['assistant/message', 1000], ['tool/result', 100000], ['user/message', 5000]])
  assert.equal(before(...args, 75000), null)
  assert.deepEqual(after(...args, 75000), { start: 1, end: 2 })
})

test('fallback also works without a system head and keeps the newest node', () => {
  const args = fixture([['user/message', 200000], ['user/message', 5000]])
  assert.deepEqual(after(...args, 75000), { start: 0, end: 0 })
})

test('no fallback consumes the whole surface or splits the only open tool step', () => {
  for (const entries of [[], [['system/message', 1000]], [['system/message', 1000], ['user/message', 200000]],
    [['system/message', 1000], ['assistant/message', 200000], ['tool/result', 1000]],
    [['system/message', 1000], ['assistant/message', 200000], ['user/message', 1000]]]) {
    assert.equal(after(...fixture(entries), 75000), null)
  }
})

test('surface corruption and unmatched tool results remain errors', () => {
  const [session, measurement] = fixture([['system/message', 1000], ['tool/result', 200000], ['user/message', 5000]])
  assert.throws(() => after(session, measurement, 75000), /no matching tool-call/)
  assert.throws(() => after(session, { nodes: measurement.nodes.slice(1) }, 75000), /surface does not match/)
})

function summarizer(source) {
  const start = source.indexOf('async function summarizeWithLlm(')
  const end = source.indexOf('\n}', start)
  const BlockAssembler = class { push() {} finish = undefined; blocks() { return [{ type: 'text', text: 'summary' }] } }
  return new Function('BlockAssembler', 'deepFreeze', 'COMPACTION_INSTRUCTION', 'finishError', 'summaryText',
    source.slice(start, end + 2) + '; return summarizeWithLlm')(BlockAssembler, (value) => value, 'compact', () => undefined, (blocks) => blocks)
}
async function summaryOptions(summarize, header, config = { summarizationProvider: '', summarizationModel: '', maxTokens: 1000 }) {
  let seen
  const ctx = { llm: { async * stream(options) { seen = options } } }
  const agent = { options: {}, session: { id: 'session-1', requestHeader: () => header && { config: header }, toolHistory: () => [] } }
  await summarize(ctx, config, { messages: [], tools: [] }, agent)
  return seen
}

test('the summary request keeps the reasoning effort of the request it continues', async () => {
  const header = { provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'max' }
  assert.equal((await summaryOptions(summarizer(source), header)).reasoningEffort, undefined)
  const patched = summarizer(patchCompactionSource(source))
  assert.equal((await summaryOptions(patched, header)).reasoningEffort, 'max')
  assert.equal('reasoningEffort' in await summaryOptions(patched, { provider: 'openai-codex', model: 'gpt-6-luna' }), false)
  // A separately configured summarization model gets its own default effort.
  const other = await summaryOptions(patched, header, { summarizationProvider: 'openai-codex', summarizationModel: 'gpt-6.1-terra', maxTokens: 1000 })
  assert.equal(other.model, 'gpt-6.1-terra')
  assert.equal('reasoningEffort' in other, false)
  assert.equal(patchCompactionSource(source.replace('purpose: "compaction",', 'purpose: "summary",')), null)
})
