import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { priceResponse, scoreResponse, summarizeUsage, turnUsage } from '../server/usage.js'
import { dailyUsage, localDay, pricingSignature, UsageHistory } from '../server/usage-history.js'
import { foldChild, newChild } from '../server/subagents.js'
import { ClaudeConversation, MAX_TURNS } from '../server/claude-transcript.js'
import { formatScore } from '../shared/usage-score.js'

const rates = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }
const providers = ['anthropic', 'deepseek-official', 'openai-codex', 'opencode-go', 'local-llm']
const pricing = new Map(providers.map((provider) => [`${provider}/model`, rates]))
const response = (seq, provider = 'openai-codex', usage = { inputTokens: 1000 }) => ({
  type: 'assistant/message', seq, time: seq + 1,
  data: { message: { id: `response-${seq}`, source: { provider, model: 'model' } }, usage },
})
const frame = (events) => zlib.zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n'))
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`)

for (const provider of providers) {
  test(`${provider}: API billing stays separate from points in turns, history and subagents`, () => {
    const event = response(1, provider)
    const key = `${provider}/model`
    const billed = ['anthropic', 'deepseek-official'].includes(provider)
    const expectedCost = billed ? 0.002 : null
    const turn = summarizeUsage([event], 0, pricing)
    assert.equal(turn.cost, expectedCost)
    assert.equal(priceResponse(pricing, key, event.data.usage, event.time), expectedCost)
    assert.equal(turn.score.points, 1)
    assert.equal(scoreResponse(pricing, key, event.data.usage, event.time).points, 1)
    const daily = dailyUsage([event], pricing)[localDay(event.time)][key]
    assert.equal(daily.cost, expectedCost)
    assert.equal(daily.input, 1000)
    const child = newChild({ type: 'session', id: 'child' })
    foldChild(child, event, pricing)
    assert.equal(child.usage.cost, expectedCost)
    assert.equal(child.usage.input, 1000)
  })
}

test('usage history repairs old subscription costs without losing deleted-log tokens or billable costs', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-review-cache-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const dshHome = path.join(home, 'dsh-home')
  const file = path.join(dshHome, 'sessions', 'work', 'kept', 'session.v4.jsonl.zstd')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const now = Date.now()
  const day = localDay(now)
  const events = [response(1), response(2, 'anthropic')].map((event) => ({ ...event, time: now }))
  await fs.writeFile(file, frame(events))
  const stat = await fs.stat(file)
  const row = (cost, input) => ({ requests: 1, input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost })
  const days = { [day]: {
    'openai-codex/model': row(100, 3000), 'opencode-go/model': row(50, 4000), 'anthropic/model': row(2, 5000),
  } }
  const legacySignature = createHash('sha256').update(JSON.stringify([...pricing.entries()].sort(([a], [b]) => a.localeCompare(b)))).digest('hex').slice(0, 16)
  const cacheFile = path.join(home, 'usage-history.json')
  await fs.writeFile(cacheFile, JSON.stringify({ version: 1, pricing: legacySignature, files: {
    'work/deleted': { size: 100, mtimeMs: 1, days, base: days },
    'work/kept': { size: stat.size, mtimeMs: stat.mtimeMs, offset: 0, days, base: days },
  } }))
  const options = { dshHome, file: cacheFile, pricing: async () => pricing, now: () => now }
  const history = new UsageHistory(options)
  const summary = await history.refresh()
  near(summary.all.cost, 2.002)
  assert.equal(summary.all.input, 14000)
  assert.equal(summary.providers['openai-codex'].all.cost, null)
  assert.equal(summary.providers['opencode-go'].all.cost, null)
  assert.equal(summary.providers['openai-codex'].all.input, 4000)
  const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
  assert.equal(cached.version, 1, 'keep historical entries rather than discarding the cache')
  assert.notEqual(cached.pricing, legacySignature)
  for (const key of ['days', 'base']) {
    assert.equal(cached.files['work/deleted'][key][day]['openai-codex/model'].cost, null)
    assert.equal(cached.files['work/deleted'][key][day]['opencode-go/model'].cost, null)
    assert.equal(cached.files['work/deleted'][key][day]['anthropic/model'].cost, 2)
  }
  const additional = [response(3, 'opencode-go'), response(4, 'anthropic')].map((event) => ({ ...event, time: now }))
  await fs.appendFile(file, frame(additional))
  const restored = await new UsageHistory(options).refresh()
  near(restored.all.cost, 2.004)
  assert.equal(restored.all.input, 16000)
  assert.equal(restored.providers['opencode-go'].all.cost, null)
})

test('billing history cache signatures ignore point-only rates', () => {
  const billable = new Map([...pricing].filter(([key]) => key.startsWith('anthropic/') || key.startsWith('deepseek-official/')))
  assert.equal(pricingSignature(pricing), pricingSignature(billable))
})

test('missing usage contributes one unpriced response even alongside known or duplicate responses', () => {
  const known = response(1)
  const missing = response(2, 'openai-codex', null)
  const total = summarizeUsage([known, missing, { ...missing, seq: 3 }], 0, pricing)
  assert.deepEqual(total.score, { points: 1, priced: 1, unpriced: 1 })
  assert.equal(total.requests, 2)
  assert.equal(total.input, 1000)
  assert.equal(formatScore(total.score), '≥ 1 pt')
  const unavailable = summarizeUsage([missing], 0, pricing)
  assert.deepEqual(unavailable.score, { points: 0, priced: 0, unpriced: 1 })
  assert.equal(formatScore(unavailable.score), '— pt')
  assert.equal(summarizeUsage([missing], missing.time + 1, pricing), null)
})

test('a later usage-bearing duplicate resolves its own missing usage in either log order', () => {
  const missing = response(1, 'anthropic', null)
  const known = { ...response(1, 'anthropic'), seq: 2 }
  for (const events of [[missing, known], [known, missing]]) {
    const total = summarizeUsage(events, 0, pricing)
    assert.equal(total.requests, 1)
    assert.equal(total.input, 1000)
    assert.deepEqual(total.score, { points: 1, priced: 1, unpriced: 0 })
    near(total.cost, 0.002)
  }
  const corrected = { ...known, seq: 3, data: { ...known.data, usage: { inputTokens: 2000 } } }
  assert.equal(summarizeUsage([known, corrected], 0, pricing).score.points, 2)
})

test('turnUsage keeps missing-usage markers from both the root and its subagents', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-review-logs-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const since = Date.now() - 1000
  const write = async (id, events) => {
    const file = path.join(home, 'sessions', 'work', id, 'session.v4.jsonl.zstd')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, frame(events))
  }
  await write('parent', [{ type: 'session', id: 'parent' }, { ...response(1, 'openai-codex', null), time: since + 1 }, { type: 'turn/end', time: since + 3 }])
  await write('child', [{ type: 'session', id: 'child', parentSession: 'parent' }, { ...response(2, 'anthropic', null), time: since + 2 }])
  const usage = await turnUsage({ dshHome: home, sessionId: 'parent', since, until: since + 4, waitMs: 0 })
  assert.equal(usage.requests, 2)
  assert.deepEqual(usage.score, { points: 0, priced: 0, unpriced: 2 })
})

const claudeUser = (id) => ({ type: 'user', uuid: `u${id}`, message: { content: `question ${id}` } })
const claudeAnswer = (id, output = 100) => ({ type: 'assistant', uuid: `a${id}`, message: {
  id: `m${id}`, model: 'model', content: [{ type: 'text', text: 'x'.repeat(10000) }],
  usage: { input_tokens: 1000, output_tokens: output },
} })

test('Claude response metadata does not retain dropped turn bodies and still deduplicates late usage', () => {
  const c = new ClaudeConversation({ pricing })
  const count = MAX_TURNS + 20
  let firstTurn
  for (let i = 0; i < count; i++) {
    c.add(claudeUser(i)); c.add(claudeAnswer(i))
    if (i === 0) firstTurn = c.turns[0]
  }
  assert.equal(c.turns.length, MAX_TURNS)
  assert.equal(c.omitted, 20)
  assert.equal(c.responses.size, count, 'retain compact response metadata for deduplication')
  const first = c.responses.get('m0')
  assert.equal(first.turnId, 'u0')
  assert.equal(Object.values(first).includes(firstTurn), false, 'never retain an evicted turn through response metadata')
  assert.equal('turn' in first, false)
  assert.equal('items' in first.usage, false)
  near(c.totalScore.points, count * 1.5)
  c.add(claudeAnswer(0))
  near(c.totalScore.points, count * 1.5)
  const latest = c.turns.at(-1)
  const previousInput = latest.usage.input
  const previousOutput = latest.usage.output
  c.add(claudeAnswer(0, 200))
  near(c.totalScore.points, count * 1.5 + 0.5)
  near(latest.totalScore.points, count * 1.5 + 0.5)
  near(c.turns[0].totalScore.points, 21 * 1.5 + 0.5)
  assert.equal(latest.usage.input, previousInput)
  assert.equal(latest.usage.output, previousOutput)
  assert.equal(c.totalScore.priced, count)
  assert.equal(c.totalScore.unpriced, 0)
})
