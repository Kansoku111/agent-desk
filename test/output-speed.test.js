import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateOutputTokens, OutputSpeedMeter, SPEED_IDLE_MS, SPEED_INTERVAL_MS } from '../server/output-speed.js'

function fixture(t) {
  let now = 0
  const changes = []
  const meter = new OutputSpeedMeter({ now: () => now, onChange: (snapshot) => changes.push(snapshot) })
  t.after(() => meter.finish())
  return { meter, changes, at: (time) => { now = time }, latest: () => changes.at(-1) }
}

const chunk = 'a'.repeat(100) // approximately 25 tokens

test('the text estimate is additive across ASCII, CJK and split surrogate chunks', () => {
  assert.equal(estimateOutputTokens('abcd日本😀'), 4)
  const text = 'code 日本語 😀'
  const sum = text.split('').reduce((total, part) => total + estimateOutputTokens(part), 0)
  assert.equal(sum, estimateOutputTokens(text))
})

test('no rate is invented for first-token wait, a buffered reply or a tiny burst', (t) => {
  const f = fixture(t)
  f.at(60_000)
  f.meter.push(chunk.repeat(100))
  f.meter.tick()
  assert.equal(f.changes.length, 0)
  f.at(60_100)
  f.meter.push(chunk)
  f.meter.tick()
  f.meter.finish()
  assert.equal(f.changes.length, 0)
  assert.equal(f.meter.timer, null)
})

test('recent rate counts observed text only and completion keeps an estimated average', (t) => {
  const f = fixture(t)
  f.meter.push(chunk.repeat(100)) // initial unknown batch is not timed
  f.at(500)
  f.meter.push(chunk)
  f.meter.tick()
  assert.deepEqual(f.latest(), { tokensPerSecond: 50, state: 'streaming', estimated: true })
  f.at(1000)
  f.meter.push(chunk)
  f.meter.tick()
  assert.equal(f.changes.length, 1, 'unchanged snapshots do not trigger extra UI traffic')
  f.at(90_000)
  f.meter.finish()
  assert.deepEqual(f.latest(), { tokensPerSecond: 50, state: 'done', estimated: true })
  assert.equal(f.meter.elapsed, 1000, 'no wait after the last chunk enters the denominator')
})

test('tool/approval pauses and idle gaps never enter the average', (t) => {
  const f = fixture(t)
  f.meter.push(chunk)
  f.at(500)
  f.meter.push(chunk)
  f.meter.pause()
  assert.equal(f.latest().state, 'paused')
  assert.equal(f.meter.timer, null)
  f.at(100_000)
  f.meter.push(chunk.repeat(100)) // first batch after tool/approval is untimed too
  f.at(100_500)
  f.meter.push(chunk)
  f.meter.tick()
  f.at(100_500 + SPEED_IDLE_MS)
  f.meter.tick()
  assert.equal(f.latest().state, 'paused')
  assert.equal(f.meter.timer, null)
  f.at(200_000)
  f.meter.push(chunk)
  f.at(200_500)
  f.meter.push(chunk)
  f.meter.finish()
  assert.equal(f.latest().tokensPerSecond, 50)
  assert.equal(f.meter.elapsed, 1500)
})

test('a late chunk resets the segment even if the idle timer has not fired yet', (t) => {
  const f = fixture(t)
  f.meter.push(chunk)
  f.at(500)
  f.meter.push(chunk)
  f.at(30_000)
  f.meter.push(chunk.repeat(100))
  f.at(30_500)
  f.meter.push(chunk)
  f.meter.finish()
  assert.equal(f.latest().tokensPerSecond, 50)
  assert.equal(f.meter.elapsed, 1000)
})

test('rolling rate follows the last three seconds, while final rate covers all active intervals', (t) => {
  const f = fixture(t)
  f.meter.push(chunk)
  for (let at = 500; at <= 3000; at += 500) {
    f.at(at)
    f.meter.push(chunk)
  }
  for (let at = 3500; at <= 6000; at += 500) {
    f.at(at)
    f.meter.push(chunk.repeat(2))
  }
  f.meter.tick()
  assert.equal(f.latest().tokensPerSecond, 100)
  f.meter.finish()
  assert.equal(f.latest().tokensPerSecond, 75)
})

test('high-frequency input retains a bounded number of buckets, not the full transcript', (t) => {
  const f = fixture(t)
  for (let at = 0; at <= 10_000; at++) {
    f.at(at)
    f.meter.push('abcd')
  }
  f.meter.tick()
  assert.equal(f.latest().tokensPerSecond, 1000)
  assert.ok(f.meter.samples.length <= 33)
  assert.equal(JSON.stringify(f.latest()).includes('samples'), false)
})

test('empty/non-text chunks and updates after finish are ignored', (t) => {
  const f = fixture(t)
  for (const value of ['', null, undefined, {}, 4]) f.meter.push(value)
  assert.equal(f.meter.timer, null)
  f.meter.finish()
  f.meter.push(chunk)
  f.meter.pause()
  f.meter.tick()
  assert.equal(f.meter.timer, null)
  assert.equal(f.changes.length, 0)
})

test('timer publishes at a bounded cadence, expires idle streams and is released on finish', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t)
  f.meter.push(chunk)
  for (let at = 100; at <= 600; at += 100) {
    f.at(at)
    f.meter.push('abcd')
  }
  assert.equal(f.changes.length, 0, 'push itself does not emit per chunk')
  t.mock.timers.tick(SPEED_INTERVAL_MS)
  assert.equal(f.latest().state, 'streaming')
  f.at(600 + SPEED_IDLE_MS)
  t.mock.timers.tick(SPEED_INTERVAL_MS)
  assert.equal(f.latest().state, 'paused')
  assert.equal(f.meter.timer, null)
  f.meter.finish()
  const count = f.changes.length
  t.mock.timers.tick(10_000)
  assert.equal(f.changes.length, count)
})

test('independent meters never mix parallel sessions', (t) => {
  const a = fixture(t), b = fixture(t)
  a.meter.push(chunk)
  b.meter.push('日本語')
  a.at(500)
  b.at(500)
  a.meter.push(chunk)
  b.meter.push('日本語')
  a.meter.finish()
  b.meter.finish()
  assert.equal(a.latest().tokensPerSecond, 50)
  assert.equal(b.latest().tokensPerSecond, 6)
})
