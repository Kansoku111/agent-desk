import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deepSeekPricing, deepSeekRatesAt } from '../server/deepseek-pricing.js'
import { loadPricing, priceResponse, summarizeUsage } from '../server/usage.js'
import { dailyUsage } from '../server/usage-history.js'

const pricing = new Map(deepSeekPricing())
const flash = pricing.get('deepseek-official/deepseek-flash')
const at = (value) => Date.parse(value)
const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }
const event = (time, model = 'deepseek-flash') => ({ type: 'assistant/message', time: at(time),
  data: { message: { source: { provider: 'deepseek-official', model } }, usage: tokens } })

test('DeepSeek UTC peak windows include the start and exclude the end', () => {
  for (const [time, peak] of [['00:59:59', false], ['01:00:00', true], ['03:59:59', true], ['04:00:00', false],
    ['05:59:59', false], ['06:00:00', true], ['09:59:59', true], ['10:00:00', false]]) {
    assert.equal(deepSeekRatesAt(flash, at(`2026-10-19T${time}Z`)), peak ? flash.peak : flash.offPeak, time)
  }
  assert.equal(deepSeekRatesAt(flash, at('2026-10-19T10:00:00+09:00')), flash.peak)
})

test('weekends and Chinese holiday ranges use off-peak; unknown years keep an upper estimate', () => {
  for (const day of ['2026-10-17', '2026-10-18', '2026-10-01', '2026-10-07', '2026-02-23', '2026-05-05']) {
    assert.equal(deepSeekRatesAt(flash, at(`${day}T02:00:00Z`)), flash.offPeak, day)
  }
  assert.equal(deepSeekRatesAt(flash, at('2026-10-08T02:00:00Z')), flash.peak)
  assert.equal(deepSeekRatesAt(flash, at('2027-10-01T02:00:00Z')), flash.peak)
  assert.equal(deepSeekRatesAt(flash, undefined), flash.peak)
  assert.equal(deepSeekRatesAt(flash, 1e20), flash.peak)
})

test('native DeepSeek rates include cache hits, the correct family, and documented aliases', async () => {
  const loaded = await loadPricing()
  const weekend = at('2026-10-17T02:00:00Z')
  const peak = at('2026-10-19T02:00:00Z')
  for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(priceResponse(loaded, `deepseek-official/${id}`, tokens, weekend), 0.753)
    assert.equal(priceResponse(loaded, `deepseek-official/${id}`, tokens, peak), 1.506)
  }
  assert.equal(priceResponse(loaded, 'deepseek-official/deepseek-v4-pro', tokens, weekend), 2.662)
  assert.equal(priceResponse(loaded, 'deepseek-official/unknown', tokens, weekend), null)
  const cached = { inputTokens: 773, outputTokens: 1237, cacheReadTokens: 65152 }
  assert.ok(Math.abs(priceResponse(loaded, 'deepseek-official/deepseek-flash', cached, weekend) - 0.001053606) < 1e-12)
})

test('turn and daily totals price each response in its own band and stop at the requested turn boundary', () => {
  const events = [event('2026-10-19T03:59:59Z'), event('2026-10-19T04:00:00Z'), event('2026-10-19T06:00:00Z')]
  const total = summarizeUsage(events, 0, pricing, at('2026-10-19T04:00:00Z'))
  assert.equal(total.requests, 2)
  assert.ok(Math.abs(total.cost - 2.259) < 1e-10)
  const days = dailyUsage(events.slice(0, 2), pricing)
  const daily = Object.values(days)[0]['deepseek-official/deepseek-flash']
  assert.equal(daily.cost, total.cost)
  assert.equal(summarizeUsage([event('2026-10-17T02:00:00Z', 'unknown')], 0, pricing).cost, null)
})
