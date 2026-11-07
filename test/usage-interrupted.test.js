import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { test } from 'node:test'
import { mergeUsage, recordedModelResponse, summarizeUsage, turnUsage } from '../server/usage.js'
import { dailyUsage, localDay, summarizeHistory, UsageHistory } from '../server/usage-history.js'

const source = { provider: 'anthropic', model: 'fixture' }
const rates = new Map([['anthropic/fixture', { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }]])
const time = Date.now() - 1000
const attempt = (seq, usage, withSource = true) => ({
  type: 'assistant/attempt', seq, time,
  data: { ...(withSource ? { source } : {}), turn: 1, step: 1, stream: [
    { type: 'tool-call-chunks', args: ['{"code":', ' '.repeat(100)] },
    ...(usage ? [{ type: 'chunk', chunk: { type: 'usage', usage } }] : []),
    { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT' } } } },
  ] },
})
const success = { type: 'assistant/message', seq: 3, time: time + 1, data: {
  message: { id: 'success', source }, usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5 },
} }
const frame = events => zlib.zstdCompressSync(Buffer.from(events.map(x => JSON.stringify(x)).join('\n') + '\n'))

test('interrupted attempts count separately without treating synthetic zero usage as measured zero', () => {
  const first = attempt(1, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  const second = attempt(2)
  const total = summarizeUsage([first, first, second, success], 0, rates)
  assert.equal(total.requests, 3)
  assert.equal(total.interruptedRequests, 2)
  assert.equal(total.usageIncomplete, true)
  assert.equal(total.input, 100)
  assert.equal(total.output, 20)
  assert.ok(Math.abs(total.score.points - 0.07) < 1e-12)
  assert.equal(total.score.priced, 1)
  assert.equal(total.score.unpriced, 2)
  assert.equal(total.reasoningIncomplete, true)
  assert.equal(recordedModelResponse(first).usage, undefined)
})

test('positive usage from an interrupted attempt is retained and merged, not double counted', () => {
  const event = attempt(1, { inputTokens: 10, outputTokens: 2 })
  const a = summarizeUsage([event], 0, rates), b = summarizeUsage([success], 0, rates)
  const total = mergeUsage(a, b)
  assert.equal(total.requests, 2)
  assert.equal(total.interruptedRequests, 1)
  assert.equal(total.input, 110)
  assert.equal(total.output, 22)
  assert.equal(total.usageIncomplete, undefined)
  assert.equal(total.score.unpriced, 0)
  assert.equal(total.reasoningIncomplete, true)
  assert.equal(total.reasoning, 5)
  for (const usage of [{ inputTokens: -1 }, { inputTokens: 1.5 }, { totalTokens: 20 }, { inputTokens: 1, reasoningTokens: 'bad' }, { outputTokens: 1, reasoningTokens: 2 }, { cacheWriteTokens: 1, cacheWrite1hTokens: 2 }])
    assert.equal(recordedModelResponse(attempt(1, usage)).usage, undefined)
})

test('interrupted messages use the same accounting rules, and unknown attempt routes are not guessed', () => {
  const event = { ...success, data: { ...success.data, interrupted: true, usage: { inputTokens: 0, outputTokens: 0 } } }
  const total = summarizeUsage([event], 0, rates)
  assert.equal(total.requests, 1)
  assert.equal(total.interruptedRequests, 1)
  assert.equal(total.usageIncomplete, true)
  assert.equal(total.score.unpriced, 1)
  const unknown = summarizeUsage([attempt(4, { inputTokens: 10 }, false)], 0, rates)
  assert.deepEqual(unknown.models, [])
  assert.equal(unknown.input, 10)
  assert.equal(unknown.score.unpriced, 1)
})

test('compressed turn and history scans keep attempts in root and child logs', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-attempt-usage-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const write = async (id, events) => {
    const file = path.join(home, 'sessions', 'workspace', id, 'session.v4.jsonl.zstd')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, frame(events))
    return file
  }
  const a = attempt(1, { inputTokens: 0, outputTokens: 0 }, false)
  const root = await write('root', [{ type: 'session', id: 'root' }, a, success, { type: 'turn/end', time: time + 2 }])
  await write('child', [{ type: 'session', id: 'child', parentSession: 'root' }, attempt(2)])
  const total = await turnUsage({ dshHome: home, sessionId: 'root', since: time, until: time + 2, waitMs: 0 })
  assert.equal(total.requests, 3)
  assert.equal(total.interruptedRequests, 2)
  assert.ok(total.score.unpriced >= 2, 'both interrupted requests must remain unpriced regardless of local catalog rates')
  assert.equal(total.usageIncomplete, true)

  const options = { dshHome: home, file: path.join(home, 'cache.json'), pricing: async () => rates, now: () => time + 2 }
  const history = new UsageHistory(options)
  const first = await history.refresh()
  assert.equal(first.all.requests, 3)
  assert.equal(first.all.interruptedRequests, 2)
  assert.equal(first.all.usageIncomplete, 2)
  assert.equal(first.all.unpriced, 2)
  assert.equal(first.daily.at(-1).usageIncomplete, true)
  assert.equal(first.models.find(x => x.model === 'unknown').all.requests, 1)
  await fs.appendFile(root, frame([attempt(4)]))
  const second = await history.refresh()
  assert.equal(second.all.requests, 4)
  assert.equal(second.all.interruptedRequests, 3)
  const reloaded = await new UsageHistory(options).refresh()
  assert.deepEqual(reloaded, second)
})

test('history retains measured tokens and marks unavailable counts and metered costs separately', () => {
  const days = dailyUsage([attempt(1), success], rates)
  const totals = days[localDay(time)]['anthropic/fixture']
  assert.equal(totals.requests, 2)
  assert.equal(totals.unpriced, 1)
  assert.equal(totals.usageIncomplete, 1)
  assert.equal(totals.input, 100)
  const summary = summarizeHistory({ file: { days } }, time)
  assert.equal(summary.all.usageIncomplete, 1)
  assert.equal(summary.providers.anthropic.all.interruptedRequests, 1)
})
