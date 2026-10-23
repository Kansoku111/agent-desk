import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { decodeSessionLog } from '../server/usage.js'
import { dailyUsage, localDay, summarizeHistory, UsageHistory } from '../server/usage-history.js'

const sonnet = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
const pricing = new Map([['anthropic/claude-sonnet-5-5', sonnet]])
const message = (time, provider, model, usage) => ({
  type: 'assistant/message',
  time,
  data: { message: { source: { provider, model } }, usage },
})
const at = (text) => new Date(text).getTime()

test('dailyUsage sums responses by local day and model, pricing only rated models', () => {
  const days = dailyUsage([
    message(at('2026-10-01T10:00:00'), 'anthropic', 'claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 }),
    message(at('2026-10-01T11:00:00'), 'anthropic', 'claude-sonnet-5-5', { inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 1_000_000 }),
    message(at('2026-10-02T09:00:00'), 'openai-codex', 'gpt-6.1-sol', { inputTokens: 900, outputTokens: 50 }),
    { type: 'user/message', time: at('2026-10-02T09:00:00') },
  ], pricing)
  const sonnetDay = days['2026-10-01']['anthropic/claude-sonnet-5-5']
  assert.equal(sonnetDay.requests, 2)
  assert.equal(sonnetDay.input, 1_500_000)
  assert.equal(sonnetDay.cacheRead, 1_000_000)
  assert.equal(Number(sonnetDay.cost.toFixed(6)), 2 + 1 + 1 + 0.2)
  const gpt = days['2026-10-02']['openai-codex/gpt-6.1-sol']
  assert.equal(gpt.input, 900)
  assert.equal(gpt.cost, null)
})

test('summarizeHistory splits today, this month and all time', () => {
  const now = at('2026-10-09T12:00:00')
  const row = (cost, input) => ({ requests: 1, input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost })
  const files = {
    a: { days: { '2026-10-09': { 'anthropic/claude-sonnet-5-5': row(1, 10) }, '2026-10-01': { 'anthropic/claude-sonnet-5-5': row(2, 20) } } },
    b: { days: { '2026-09-20': { 'anthropic/claude-haiku-5-5': row(4, 40), 'openai-codex/gpt-6.1-sol': row(null, 5) } } },
  }
  const summary = summarizeHistory(files, now)
  assert.equal(summary.today.cost, 1)
  assert.equal(summary.month.cost, 3)
  assert.equal(summary.all.cost, 7)
  assert.equal(summary.all.input, 75)
  assert.equal(summary.since, '2026-09-20')
  assert.equal(summary.providers.anthropic.all.cost, 7)
  assert.equal(summary.providers['openai-codex'].all.cost, null)
  assert.equal(summary.providers['openai-codex'].all.input, 5)
  assert.deepEqual(summary.models.map((entry) => entry.model), ['anthropic/claude-haiku-5-5', 'anthropic/claude-sonnet-5-5', 'openai-codex/gpt-6.1-sol'])
  assert.equal(summary.models[1].month.cost, 3)
  assert.equal(summary.daily.length, 30)
  assert.equal(summary.daily.at(-1).day, localDay(now))
  assert.equal(summary.daily.at(-1).cost, 1)
  assert.equal(summary.daily.find((point) => point.day === '2026-09-20').cost, 4)
})

const log = (events) => zlib.zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n'))

test('UsageHistory caches per log, rescans changed logs and keeps removed ones', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-history-'))
  const dshHome = path.join(home, 'dsh-home')
  const logFile = (session) => path.join(dshHome, 'sessions', '--work--', session, 'session.v4.jsonl.zstd')
  const write = async (session, events) => {
    await fs.mkdir(path.dirname(logFile(session)), { recursive: true })
    await fs.writeFile(logFile(session), log(events))
  }
  const now = at('2026-10-09T12:00:00')
  const sonnetCall = (input) => message(now - 1000, 'anthropic', 'claude-sonnet-5-5', { inputTokens: input, outputTokens: 0 })
  await write('one', [sonnetCall(1_000_000)])
  await write('two', [sonnetCall(500_000)])

  let pricingCalls = 0
  const history = new UsageHistory({
    dshHome,
    file: path.join(home, 'usage-history.json'),
    pricing: async () => {
      pricingCalls += 1
      return pricing
    },
    now: () => now,
  })
  const first = await history.refresh()
  assert.equal(first.all.cost, 3)
  assert.equal(first.today.requests, 2)

  // The cache is reused by a fresh instance; a grown log is read again.
  await write('one', [sonnetCall(1_000_000), sonnetCall(1_000_000)])
  await fs.rm(path.dirname(logFile('two')), { recursive: true })
  const again = new UsageHistory({ dshHome, file: path.join(home, 'usage-history.json'), pricing: async () => pricing, now: () => now })
  const second = await again.refresh()
  assert.equal(second.all.requests, 3)
  assert.equal(second.all.cost, 5)
  assert.ok(pricingCalls >= 1)
  await fs.rm(home, { recursive: true, force: true })
})

test('UsageHistory retries all logs after a failed repricing read', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-history-'))
  const originalOpen = fs.open
  try {
    const dshHome = path.join(home, 'dsh-home')
    const logFile = (session) => path.join(dshHome, 'sessions', '--work--', session, 'session.v4.jsonl.zstd')
    const write = async (session, event) => {
      await fs.mkdir(path.dirname(logFile(session)), { recursive: true })
      await fs.writeFile(logFile(session), log([event]))
    }
    const now = at('2026-10-09T12:00:00')
    const call = () => message(now - 1000, 'anthropic', 'model', { inputTokens: 1_000_000, outputTokens: 0 })
    const rates = (input) => new Map([['anthropic/model', { input, output: 0, cacheRead: 0, cacheWrite: 0 }]])
    await write('one', call())
    await write('two', call())

    let currentRates = rates(2)
    const history = new UsageHistory({
      dshHome,
      file: path.join(home, 'usage-history.json'),
      pricing: async () => currentRates,
      now: () => now,
    })
    const first = await history.refresh()
    assert.equal(first.all.cost, 4)
    const previousSignature = history.cache.pricing
    currentRates = rates(4)

    let failOnce = true
    fs.open = async (...args) => {
      if (failOnce && args[0] === logFile('one')) {
        failOnce = false
        throw new Error('temporary read failure')
      }
      return originalOpen(...args)
    }
    const partial = await history.refresh()
    assert.equal(partial.all.cost, 6)
    assert.equal(history.cache.pricing, previousSignature)
    fs.open = originalOpen

    const retried = await history.refresh()
    assert.equal(retried.all.cost, 8)
    assert.notEqual(history.cache.pricing, previousSignature)
  } finally {
    fs.open = originalOpen
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('UsageHistory adds only the frames appended since the last scan and gets what a full read gets', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-history-'))
  const dshHome = path.join(home, 'dsh-home')
  const file = path.join(dshHome, 'sessions', '--work--', 'grow', 'session.v4.jsonl.zstd')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const now = at('2026-10-09T12:00:00')
  const call = (seq, input) => ({ type: 'assistant/message', seq, time: now - 1000 + seq, data: { message: { source: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }, usage: { inputTokens: input, outputTokens: 1 } } })
  const frames = [log([{ type: 'session', id: 'grow' }])]
  for (let seq = 0; seq < 40; seq += 1) frames.push(log(seq % 3 === 2 ? [{ type: 'turn/end', seq, time: now }] : [call(seq, 1000 + seq)]))
  const options = { dshHome, file: path.join(home, 'usage-history.json'), pricing: async () => pricing, now: () => now }
  let scanner = new UsageHistory(options)
  // The log as it grows: on a frame edge, through several frames, cut inside the
  // last frame, unchanged in size, and read by a new process from the saved cache.
  const steps = [{ frames: 5 }, { frames: 12 }, { frames: 12 }, { frames: 26, cut: 3 }, { frames: 26, cut: 3, restart: true }, { frames: 27 }, { frames: 41 }]
  for (const [index, { frames: count, cut = 0, restart = false }] of steps.entries()) {
    const whole = Buffer.concat(frames.slice(0, count))
    const bytes = whole.subarray(0, whole.length - cut)
    await fs.writeFile(file, bytes)
    await fs.utimes(file, new Date(), new Date(Date.now() + (index + 1) * 1000))
    if (restart) scanner = new UsageHistory(options)
    await scanner.refresh()
    const entry = scanner.cache.files['--work--/grow']
    assert.deepEqual(entry.days, dailyUsage(decodeSessionLog(bytes), pricing), `step ${index}`)
    assert.ok(Number.isInteger(entry.offset) && entry.offset <= bytes.length)
  }
  await fs.rm(home, { recursive: true, force: true })
})

test('UsageHistory reads a log that was written anew from the start', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-history-'))
  const dshHome = path.join(home, 'dsh-home')
  const file = path.join(dshHome, 'sessions', '--work--', 'again', 'session.v4.jsonl.zstd')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const now = at('2026-10-09T12:00:00')
  const call = (seq, input) => ({ type: 'assistant/message', seq, time: now - 1000, data: { message: { source: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }, usage: { inputTokens: input, outputTokens: 0 } } })
  const history = new UsageHistory({ dshHome, file: path.join(home, 'usage-history.json'), pricing: async () => pricing, now: () => now })
  await fs.writeFile(file, Buffer.concat([log([call(0, 1_000_000)]), log([call(1, 1_000_000)]), log([call(2, 1_000_000)])]))
  assert.equal((await history.refresh()).all.cost, 6)
  // Recovery rewrote the log: bigger, but not the old one with frames appended.
  await fs.writeFile(file, Buffer.concat([log([call(0, 500_000)]), log([call(1, 500_000)]), log([call(2, 500_000)]), log([call(3, 500_000)]), log([call(4, 500_000)])]))
  await fs.utimes(file, new Date(), new Date(Date.now() + 5000))
  assert.equal((await history.refresh()).all.cost, 5)
  await fs.rm(home, { recursive: true, force: true })
})

test('UsageHistory runs one more scan when asked during a scan', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-history-'))
  let scans = 0
  const history = new UsageHistory({
    dshHome: path.join(home, 'none'),
    file: path.join(home, 'usage-history.json'),
    pricing: async () => {
      scans += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return pricing
    },
  })
  const first = history.refresh()
  const second = history.refresh()
  await Promise.all([first, second])
  assert.equal(scans, 2)
  assert.equal(history.summary.all.requests, 0)
  await fs.rm(home, { recursive: true, force: true })
})
