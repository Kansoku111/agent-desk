import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexOutputSpeedMeter } from '../server/codex-output-speed.js'
import { SPEED_INTERVAL_MS } from '../server/output-speed.js'

const chunk = 'a'.repeat(224)
function fixture(t) {
  let now = 0
  const changes = []
  const meter = new CodexOutputSpeedMeter({ now: () => now, onChange: (value) => changes.push(value) })
  t.after(() => meter.finish())
  return {
    meter, changes,
    at: (value) => { now = value },
    last: () => changes.at(-1),
    start: (id, type = 'agentMessage') => meter.event('item/started', { item: { id, type } }),
    end: (id, type = 'agentMessage') => meter.event('item/completed', { item: { id, type } }),
    delta: (id, delta = chunk, method = 'item/agentMessage/delta', extra = {}) => meter.event(method, { itemId: id, delta, ...extra }),
  }
}

test('long text streams with bounded periodic notifications and settles as estimated', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t)
  f.start('a'); f.delta('a', chunk.repeat(100))
  f.at(1000); f.delta('a')
  t.mock.timers.tick(SPEED_INTERVAL_MS)
  assert.deepEqual(f.last(), { tokensPerSecond: 56, state: 'streaming', estimated: true })
  f.end('a'); assert.equal(f.last(), null)
  f.meter.finish()
  assert.deepEqual(f.last(), { tokensPerSecond: 56, state: 'done', estimated: true })
  assert.equal(f.meter.timer, null)
})

test('reasoning blocks restart across hidden thinking, methods and indexes', (t) => {
  const f = fixture(t)
  const summary = 'item/reasoning/summaryTextDelta'
  const content = 'item/reasoning/textDelta'
  f.start('r', 'reasoning')
  f.delta('r', chunk, summary, { summaryIndex: 0 })
  f.at(1000); f.delta('r', chunk, summary, { summaryIndex: 0 }); f.meter.tick()
  assert.equal(f.last().tokensPerSecond, 56)
  f.at(20000); f.meter.event('item/reasoning/summaryPartAdded', { itemId: 'r', summaryIndex: 1 })
  assert.equal(f.last(), null)
  f.at(30000); f.delta('r', chunk, summary, { summaryIndex: 1 })
  f.at(31000); f.delta('r', chunk, summary, { summaryIndex: 1 }); f.meter.tick()
  assert.equal(f.last().tokensPerSecond, 56)
  f.delta('r', chunk, content, { contentIndex: 0 }); assert.equal(f.last(), null)
  f.at(32000); f.delta('r', chunk, content, { contentIndex: 0 }); f.meter.tick()
  assert.equal(f.last().tokensPerSecond, 56)
  f.delta('r', chunk, content, { contentIndex: 1 }); assert.equal(f.last(), null)
})

test('tool start discards speed and output, usage and user messages are ignored', (t) => {
  const f = fixture(t)
  f.delta('a'); f.at(1000); f.delta('a'); f.meter.tick()
  f.start('tool', 'commandExecution')
  assert.equal(f.last(), null); assert.equal(f.meter.timer, null)
  f.meter.event('item/commandExecution/outputDelta', { itemId: 'tool', delta: chunk.repeat(10) })
  f.meter.event('item/fileChange/outputDelta', { itemId: 'tool', delta: chunk })
  f.meter.event('thread/tokenUsage/updated', { tokenUsage: { total: { outputTokens: 100000 } } })
  f.start('user', 'userMessage')
  f.meter.finish(); assert.equal(f.last(), null)
})

test('approval wait can be paused by runner without charging wait time', (t) => {
  const f = fixture(t)
  f.delta('a'); f.at(1000); f.delta('a'); f.meter.pause()
  f.at(60000); f.meter.finish()
  assert.equal(f.last().tokensPerSecond, 56)
})

for (const mode of ['short', 'bulk', 'snapshot', 'turn snapshot']) test(`last ${mode} response never reuses earlier speed`, (t) => {
  const f = fixture(t)
  f.delta('a'); f.at(1000); f.delta('a'); f.end('a')
  if (mode === 'turn snapshot') {
    f.meter.event('turn/completed', { turn: { items: [{ id: 'a', type: 'agentMessage', text: chunk }, { id: 'b', type: 'agentMessage', text: chunk.repeat(50) }] } })
  } else {
    f.start('b')
    if (mode === 'short') { f.delta('b', 'hi'); f.at(2000); f.delta('b', 'there') }
    if (mode === 'bulk') f.delta('b', chunk.repeat(50))
    f.end('b')
  }
  f.meter.finish(); assert.equal(f.last() ?? null, null)
})

test('unseen item completed snapshot clears earlier speed even without started', (t) => {
  const f = fixture(t)
  f.delta('a'); f.at(1000); f.delta('a'); f.end('a')
  f.end('b'); f.meter.finish(); assert.equal(f.last() ?? null, null)
})

test('duplicate and late completion never pause a different active item', (t) => {
  const f = fixture(t)
  f.delta('a'); f.end('a'); f.delta('b')
  f.end('a'); f.end('old')
  assert.equal(f.meter.state, 'streaming')
  f.at(1000); f.delta('b'); f.meter.tick()
  assert.equal(f.last().tokensPerSecond, 56)
  f.end('b'); f.end('b'); f.meter.finish()
  assert.equal(f.last().tokensPerSecond, 56)
})

test('late completion of an earlier observed item preserves a completed current item', (t) => {
  const f = fixture(t)
  f.delta('a'); f.delta('b'); f.at(1000); f.delta('b'); f.end('b')
  f.end('a'); f.meter.finish()
  assert.equal(f.last().tokensPerSecond, 56)
})

test('interleaved item and block changes cannot mix sample windows', (t) => {
  const f = fixture(t)
  f.delta('a'); f.at(1000); f.delta('a'); f.meter.tick()
  f.delta('b'); assert.equal(f.last(), null)
  f.at(2000); f.delta('a'); assert.equal(f.last(), null)
  f.at(3000); f.delta('a'); f.meter.tick()
  assert.equal(f.last().tokensPerSecond, 56)
})

test('malformed and empty deltas and snapshot history do not count', (t) => {
  const f = fixture(t)
  for (const params of [{ delta: chunk }, { itemId: '', delta: chunk }, { itemId: 'a', delta: '' }, { itemId: 'a', delta: 1 }]) {
    f.meter.event('item/agentMessage/delta', params)
  }
  f.meter.event('turn/completed', { turn: { items: [{ type: 'agentMessage', id: 'a', text: chunk.repeat(100) }] } })
  f.meter.finish(); assert.equal(f.meter.timer, null); assert.equal(f.changes.filter(Boolean).length, 0)
})
