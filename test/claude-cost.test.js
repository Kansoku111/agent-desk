import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ClaudeCost, fetchCostDays, parseCostReport, summarizeCost } from '../server/claude-cost.js'

const bucket = (day, results) => ({ starting_at: `${day}T00:00:00Z`, ending_at: `${day}T23:59:59Z`, results })
const cost = (amount, extra = {}) => ({ amount, currency: 'USD', cost_type: 'tokens', model: 'claude-sonnet-5-5', ...extra })

test('parseCostReport turns cents into dollars by day and model', () => {
  const days = parseCostReport([
    { data: [bucket('2026-10-01', [cost('123.45'), cost('100', { token_type: 'output_tokens' }), cost('50', { model: null, cost_type: 'web_search' })])] },
    { data: [bucket('2026-10-02', []), bucket('2026-10-03', [cost('1', { model: 'claude-haiku-5-5' })])] },
  ])
  assert.equal(Number(days['2026-10-01']['claude-sonnet-5-5'].toFixed(4)), 2.2345)
  assert.equal(days['2026-10-01']['Web 検索'], 0.5)
  assert.deepEqual(days['2026-10-02'], {})
  assert.equal(days['2026-10-03']['claude-haiku-5-5'], 0.01)
})

test('summarizeCost splits today, this month, 30 days and months', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const summary = summarizeCost({
    '2026-10-09': { 'claude-sonnet-5-5': 1 },
    '2026-10-01': { 'claude-sonnet-5-5': 2, 'claude-haiku-5-5': 0.5 },
    '2026-09-15': { 'claude-haiku-5-5': 4 },
    '2026-06-01': { 'claude-opus-5-5': 10 },
  }, now)
  assert.equal(summary.today, 1)
  assert.equal(summary.month, 3.5)
  assert.equal(summary.last30, 7.5)
  assert.equal(summary.all, 17.5)
  assert.equal(summary.since, '2026-06-01')
  assert.deepEqual(summary.models.map((entry) => entry.label), ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'])
  assert.deepEqual(summary.months, [{ month: '2026-06', amount: 10 }, { month: '2026-09', amount: 4 }, { month: '2026-10', amount: 3.5 }])
})

test('fetchCostDays follows pages and sends the admin headers', async () => {
  const seen = []
  const pages = [
    { data: [bucket('2026-10-01', [cost('100')])], has_more: true, next_page: 'page_2' },
    { data: [bucket('2026-10-02', [cost('200')])], has_more: false, next_page: null },
  ]
  const fetchImpl = async (url, init) => {
    seen.push({ url: new URL(url), headers: init.headers })
    return { ok: true, status: 200, json: async () => pages[seen.length - 1] }
  }
  const result = await fetchCostDays({ key: 'sk-ant-admin01-x', from: Date.parse('2026-10-01T00:00:00Z'), fetchImpl })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.days, { '2026-10-01': { 'claude-sonnet-5-5': 1 }, '2026-10-02': { 'claude-sonnet-5-5': 2 } })
  assert.equal(seen[0].url.searchParams.get('starting_at'), '2026-10-01T00:00:00Z')
  assert.equal(seen[0].url.searchParams.get('bucket_width'), '1d')
  assert.deepEqual(seen[0].url.searchParams.getAll('group_by[]'), ['description'])
  assert.equal(seen[0].headers['x-api-key'], 'sk-ant-admin01-x')
  assert.equal(seen[1].url.searchParams.get('page'), 'page_2')
})

test('fetchCostDays reports refusals', async () => {
  const reply = (status, message) => async () => ({ ok: false, status, json: async () => ({ error: { message } }) })
  assert.deepEqual(await fetchCostDays({ key: 'k', from: 0, fetchImpl: reply(401, 'bad key') }), { status: 'invalid', httpStatus: 401, message: 'bad key' })
  assert.equal((await fetchCostDays({ key: 'k', from: 0, fetchImpl: reply(403, 'no') })).status, 'forbidden')
  assert.equal((await fetchCostDays({ key: 'k', from: 0, fetchImpl: async () => { throw new Error('offline') } })).message, 'offline')
})

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-cost-'))
  return { file: path.join(dir, 'claude-cost.json'), cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

test('ClaudeCost fetches a year once, then only the last days', async () => {
  const { file, cleanup } = await tempFile()
  const now = Date.parse('2026-10-09T12:00:00Z')
  const calls = []
  const fetchDays = async ({ from }) => {
    calls.push(new Date(from).toISOString().slice(0, 10))
    return calls.length === 1
      ? { status: 'ok', days: { '2026-01-10': { a: 5 }, '2026-10-08': { a: 1 } } }
      : { status: 'ok', days: { '2026-10-08': { a: 2 }, '2026-10-09': { a: 3 } } }
  }
  const costs = await new ClaudeCost({ file, keys: async () => ({ admin: 'sk-ant-admin01-x', api: null }), fetchDays, now: () => now }).load()
  const first = await costs.refresh()
  assert.equal(first.status, 'ok')
  assert.equal(first.source, 'admin')
  assert.equal(first.summary.all, 6)
  // A new instance reads the cache and fetches from three days back.
  const later = await new ClaudeCost({ file, keys: async () => ({ admin: 'sk-ant-admin01-x', api: null }), fetchDays, now: () => now }).load()
  assert.equal(later.state.summary.all, 6)
  const second = await later.refresh()
  assert.deepEqual(calls, ['2025-10-09', '2026-10-06'])
  assert.equal(second.summary.all, 10)
  assert.equal(second.summary.today, 3)
  // Fresh enough: no request.
  await later.refresh({ maxAgeMs: 60_000 })
  assert.equal(calls.length, 2)
  await cleanup()
})

test('ClaudeCost asks for an Admin key when the API key cannot read costs', async () => {
  const { file, cleanup } = await tempFile()
  const costs = await new ClaudeCost({
    file,
    keys: async () => ({ admin: null, api: 'sk-ant-api03-x' }),
    fetchDays: async () => ({ status: 'forbidden', httpStatus: 403, message: 'workspace key' }),
  }).load()
  const state = await costs.refresh()
  assert.equal(state.status, 'needs-admin')
  assert.equal(state.summary, null)
  await cleanup()
})

test('ClaudeCost keeps the cached summary when a refresh fails', async () => {
  const { file, cleanup } = await tempFile()
  let fail = false
  const costs = await new ClaudeCost({
    file,
    keys: async () => ({ admin: 'sk-ant-admin01-x', api: null }),
    fetchDays: async () => (fail ? { status: 'error', message: 'offline' } : { status: 'ok', days: { [new Date().toISOString().slice(0, 10)]: { a: 1 } } }),
  }).load()
  await costs.refresh()
  fail = true
  const state = await costs.refresh()
  assert.equal(state.status, 'error')
  assert.equal(state.message, 'offline')
  assert.equal(state.summary.all, 1)
  assert.equal((await new ClaudeCost({ file, keys: async () => ({ admin: null, api: null }) }).load().then((c) => c.refresh())).status, 'none')
  await cleanup()
})
