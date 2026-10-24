import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beginOutputSpeed, observeOutputSpeed, finishOutputSpeed } from '../server/output-speed-bridge.js'
import { OUTPUT_SPEED_META } from '../server/output-speed.js'

function fixture(t, notify = null) {
  let now = 0
  const updates = []
  const record = {
    agent: { session: { id: 'owned-root-session' } }, outputTail: Promise.resolve(),
    notify: notify ?? (async (update) => { updates.push(update) }),
  }
  const meter = beginOutputSpeed(record)
  meter.now = () => now
  t.after(() => finishOutputSpeed(record))
  return {
    record, meter, updates, at: (time) => { now = time },
    frame: (frame) => observeOutputSpeed(record, frame),
    chunk: (chunk) => observeOutputSpeed(record, { type: 'chunk', chunk }),
    last: () => updates.at(-1)?.update._meta[OUTPUT_SPEED_META],
  }
}

const text = 'a'.repeat(100)

test('stream attempts retain only the last response average and only scalar metadata leaves dsh', async (t) => {
  const f = fixture(t)
  f.frame({ type: 'start' })
  f.chunk({ type: 'text-delta', text })
  f.at(1000)
  f.chunk({ type: 'reasoning-delta', text })
  f.meter.tick()
  await f.record.outputTail
  assert.equal(f.last().tokensPerSecond, 25)
  assert.equal(f.last().state, 'streaming')
  f.chunk({ type: 'tool-call-delta', argumentsDelta: text.repeat(1000) })
  f.frame({ type: 'end' })
  f.at(60_000)
  f.frame({ type: 'start' })
  f.chunk({ type: 'text-delta', text })
  f.at(61_000)
  f.chunk({ type: 'text-delta', text: text.repeat(2) })
  f.frame({ type: 'end' })
  await finishOutputSpeed(f.record)
  assert.deepEqual(f.last(), { tokensPerSecond: 50, state: 'done', estimated: true })
  for (const notification of f.updates) {
    assert.equal(notification.sessionId, 'owned-root-session')
    assert.equal(notification.update.content.text, '')
    assert.equal(JSON.stringify(notification).includes(text), false)
  }
  assert.equal(f.meter.timer, null)
})

test('finishing awaits ordered notification delivery and ignores subsequent frames', async (t) => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const f = fixture(t, async () => pending)
  f.chunk({ type: 'text-delta', text })
  f.at(1000)
  f.chunk({ type: 'text-delta', text })
  let finished = false
  const completion = finishOutputSpeed(f.record).then(() => { finished = true })
  await new Promise(setImmediate)
  assert.equal(finished, false)
  release()
  await completion
  observeOutputSpeed(undefined, { type: 'start' })
  f.chunk({ type: 'text-delta', text })
  assert.equal(f.meter.timer, null)
  assert.equal(f.meter.state, 'done')
})

test('failed metric delivery never fails a prompt or leaves a timer alive', async (t) => {
  const f = fixture(t, async () => { throw new Error('disconnected client') })
  f.chunk({ type: 'text-delta', text })
  f.at(1000)
  f.chunk({ type: 'text-delta', text })
  await finishOutputSpeed(f.record)
  assert.equal(f.meter.timer, null)
})

test('committed blocks, usage and tool JSON are not live text deltas', async (t) => {
  const f = fixture(t)
  f.chunk({ type: 'block-end', block: { type: 'text', text } })
  f.at(1000)
  f.chunk({ type: 'usage', output: 100_000 })
  f.chunk({ type: 'tool-call-delta', argumentsDelta: text })
  f.chunk({ type: 'finish' })
  await finishOutputSpeed(f.record)
  assert.equal(f.updates.length, 0)
})
