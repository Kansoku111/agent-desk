import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateOutputTokens, OutputSpeedMeter, SPEED_INTERVAL_MS } from '../server/output-speed.js'

function fixture(t) {
  let now = 0
  const changes = []
  const meter = new OutputSpeedMeter({ now: () => now, onChange: (s) => changes.push(s) })
  t.after(() => meter.finish())
  return { meter, changes, at: (time) => { now = time }, last: () => changes.at(-1) }
}
const text = 'a'.repeat(224) // 56 estimated tokens

test('estimation is additive across split Unicode and ASCII chunks', () => {
  const text = 'abc日本😀'
  assert.equal(estimateOutputTokens(text), text.split('').reduce((sum, c) => sum + estimateOutputTokens(c), 0))
})

test('live and final both use this response average, not a different rolling/turn average', (t) => {
  const f = fixture(t)
  f.meter.push(text.repeat(100))
  f.at(1000); f.meter.push(text); f.meter.tick()
  assert.equal(f.last().tokensPerSecond, 56)
  f.at(2000); f.meter.push(text); f.meter.tick()
  assert.equal(f.changes.length, 1)
  f.meter.finish()
  assert.deepEqual(f.last(), { tokensPerSecond: 56, state: 'done', estimated: true })
})

test('a fast earlier response cannot turn the last 56 t/s answer into 170 t/s', (t) => {
  const f = fixture(t)
  f.meter.start(); f.meter.push(text)
  f.at(1000); f.meter.push(text.repeat(10)); f.meter.pause()
  assert.equal(f.last(), undefined)
  f.at(60_000); f.meter.start(); f.meter.push(text)
  f.at(61_000); f.meter.push(text); f.meter.tick()
  assert.equal(f.last().tokensPerSecond, 56)
  f.meter.finish()
  assert.equal(f.last().tokensPerSecond, 56)
})

test('silence within a response is included, never removed at an idle threshold', (t) => {
  const f = fixture(t)
  f.meter.push(text)
  f.at(1000); f.meter.push(text); f.meter.tick()
  f.at(4000); f.meter.tick()
  assert.equal(f.last().tokensPerSecond, 14)
  assert.ok(f.meter.timer)
  f.at(5000); f.meter.push(text); f.meter.tick()
  assert.equal(f.last().tokensPerSecond, 22.4)
  f.meter.finish()
  assert.equal(f.last().tokensPerSecond, 22.4)
})

for (const duration of [0, 100, 999]) test(`a ${duration}ms burst cannot become valid merely by waiting`, (t) => {
  const f = fixture(t)
  f.meter.push(text)
  f.at(duration); f.meter.push(text.repeat(1000))
  f.at(60_000); f.meter.tick(); f.meter.finish()
  assert.equal(f.changes.length, 0)
})

test('an unmeasurable final response never falls back to an earlier rate', (t) => {
  const f = fixture(t)
  f.meter.push(text)
  f.at(1000); f.meter.push(text); f.meter.tick()
  f.meter.pause()
  assert.equal(f.last(), null)
  f.meter.start(); f.meter.push(text)
  f.at(1100); f.meter.push(text.repeat(100)); f.meter.finish()
  assert.equal(f.last(), null)
})

test('a text-free next response clears the previous average', (t) => {
  const f = fixture(t)
  f.meter.push(text); f.at(1000); f.meter.push(text); f.meter.pause()
  f.meter.start(); f.meter.pause(); f.meter.finish()
  assert.equal(f.changes.length, 0)
})

test('tool boundaries hide and discard the response, and release the timer', (t) => {
  const f = fixture(t)
  f.meter.push(text); f.at(1000); f.meter.push(text); f.meter.tick()
  f.meter.pause({ discard: true })
  assert.equal(f.last(), null)
  assert.equal(f.meter.timer, null)
  f.meter.pause(); f.meter.finish()
  assert.equal(f.last(), null)
})

test('final denominator stops at the last received text, not result/checkpoint wait', (t) => {
  const f = fixture(t)
  f.meter.push(text); f.at(1000); f.meter.push(text)
  f.at(90_000); f.meter.finish()
  assert.equal(f.last().tokensPerSecond, 56)
})

test('timer updates at bounded cadence and stops permanently at finish', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t)
  f.meter.push(text); f.at(1000); f.meter.push(text)
  assert.equal(f.changes.length, 0)
  t.mock.timers.tick(SPEED_INTERVAL_MS)
  assert.equal(f.last().tokensPerSecond, 56)
  f.meter.finish()
  const count = f.changes.length
  f.meter.start(); f.meter.push(text); f.meter.pause()
  t.mock.timers.tick(5000)
  assert.equal(f.changes.length, count)
  assert.equal(f.meter.timer, null)
})

test('no samples or full transcript retained even with many chunks', (t) => {
  const f = fixture(t)
  for (let time = 0; time <= 10000; time++) { f.at(time); f.meter.push('abcd') }
  f.meter.tick()
  assert.equal(f.last().tokensPerSecond, 1000)
  assert.equal(f.meter.samples, undefined)
})

test('invalid/empty chunks do not start timers', (t) => {
  const f = fixture(t)
  for (const value of ['', null, undefined, {}, 42]) f.meter.push(value)
  assert.equal(f.meter.timer, null)
})
