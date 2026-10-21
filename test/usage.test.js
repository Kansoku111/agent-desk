import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { decodeSessionLog, mergeUsage, responseCost, summarizeUsage, turnUsage } from '../server/usage.js'

const sonnet = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
const pricing = new Map([['anthropic/claude-sonnet-5-5', sonnet]])
const message = (time, provider, model, usage) => ({
  type: 'assistant/message',
  time,
  data: { message: { source: { provider, model } }, usage },
})

test('responseCost follows the catalog rates per million tokens', () => {
  const cost = responseCost(sonnet, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000 })
  assert.equal(Number(cost.toFixed(6)), 2 + 1 + 0.4 + 1)
})

test('responseCost switches to a tier above its input threshold', () => {
  const tiered = { input: 1, output: 5, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 100, input: 3, output: 7, cacheRead: 0, cacheWrite: 0 }] }
  assert.equal(responseCost(tiered, { inputTokens: 50, outputTokens: 0 }) * 1e6, 50)
  assert.equal(responseCost(tiered, { inputTokens: 200, outputTokens: 0 }) * 1e6, 600)
})

test('summarizeUsage sums the turn and prices billed routes only', () => {
  const events = [
    message(5, 'anthropic', 'claude-sonnet-5-5', { inputTokens: 999, outputTokens: 999 }),
    message(10, 'anthropic', 'claude-sonnet-5-5', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 }),
    message(12, 'anthropic', 'claude-sonnet-5-5', { inputTokens: 500, outputTokens: 100, cacheWriteTokens: 1000 }),
  ]
  const usage = summarizeUsage(events, 10, pricing)
  assert.equal(usage.requests, 2)
  assert.equal(usage.input, 1500)
  assert.equal(usage.output, 300)
  assert.equal(usage.cacheRead, 5000)
  assert.equal(usage.cacheWrite, 1000)
  assert.equal(Number(usage.cost.toFixed(6)), Number(((1500 * 2 + 300 * 10 + 5000 * 0.2 + 1000 * 2.5) / 1e6).toFixed(6)))
  assert.deepEqual(usage.models, ['anthropic/claude-sonnet-5-5'])

  const subscription = summarizeUsage([message(1, 'openai-codex', 'gpt-6.1-sol', { inputTokens: 10, outputTokens: 5 })], 0, pricing)
  assert.equal(subscription.cost, null)
  assert.equal(summarizeUsage(events, 100, pricing), null)
})

test('decodeSessionLog reads appended zstd frames', () => {
  const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n'))
  const log = Buffer.concat([frame([{ type: 'session' }]), frame([{ type: 'turn/start' }, { type: 'turn/end' }])])
  assert.deepEqual(decodeSessionLog(log).map((event) => event.type), ['session', 'turn/start', 'turn/end'])
})

test('mergeUsage adds counts and keeps a cost when either side has one', () => {
  const gpt = summarizeUsage([message(1, 'openai-codex', 'gpt-5.5', { inputTokens: 10, outputTokens: 5 })], 0, pricing)
  const claude = summarizeUsage([message(1, 'anthropic', 'claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0 })], 0, pricing)
  const total = mergeUsage(gpt, claude)
  assert.equal(total.requests, 2)
  assert.equal(total.input, 1_000_010)
  assert.equal(total.cost, 2)
  assert.deepEqual(total.models, ['openai-codex/gpt-5.5', 'anthropic/claude-sonnet-5-5'])
  assert.equal(mergeUsage(null, gpt), gpt)
  assert.equal(mergeUsage(gpt, gpt).cost, null)
})

test('turnUsage counts the subagents the session started during the turn', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-usage-'))
  const write = async (id, events) => {
    const dir = path.join(home, 'sessions', '--ws--', id)
    await fs.mkdir(dir, { recursive: true })
    const lines = events.map((event) => JSON.stringify(event) + '\n').join('')
    await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines)))
  }
  const since = Date.now() - 1000
  const usage = { inputTokens: 100, outputTokens: 10 }
  try {
    await write('parent', [{ type: 'session', id: 'parent' }, message(since + 1, 'openai-codex', 'gpt-5.5', usage), { type: 'turn/end', time: since + 3 },
      message(since + 10, 'openai-codex', 'gpt-5.5', usage), { type: 'turn/end', time: since + 11 }])
    await write('child', [{ type: 'session', id: 'child', parentSession: 'parent' }, message(since + 2, 'anthropic', 'claude-sonnet-5-5', usage),
      message(since + 10, 'anthropic', 'claude-sonnet-5-5', usage)])
    await write('other', [{ type: 'session', id: 'other', parentSession: 'someone-else' }, message(since + 2, 'anthropic', 'claude-sonnet-5-5', usage)])
    const total = await turnUsage({ dshHome: home, sessionId: 'parent', since, until: since + 4, waitMs: 0 })
    assert.equal(total.requests, 2)
    assert.deepEqual(total.models, ['openai-codex/gpt-5.5', 'anthropic/claude-sonnet-5-5'])
    assert.ok(total.cost > 0)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
