import assert from 'node:assert/strict'
import { test } from 'node:test'
import { watchMemory } from '../server/memory-watch.js'

const GB = 1024 ** 3

test('the heap is logged at start and at each new high from 1 GB, not on every check', () => {
  const lines = []
  let heapUsed = 0.5 * GB
  const watch = watchMemory((line) => lines.push(line), { usage: () => ({ heapUsed, rss: heapUsed * 1.2 }), details: () => 'tasks 3 loaded' })
  assert.match(lines[0], /^memory at start: heap 512 MB of \d+ MB, rss 614 MB · tasks 3 loaded$/)
  watch.check()
  assert.equal(lines.length, 1)
  heapUsed = 1.1 * GB
  watch.check()
  watch.check()
  assert.equal(lines.length, 2)
  assert.match(lines[1], /^memory: heap 1126 MB of \d+ MB, rss 1352 MB · tasks 3 loaded$/)
  heapUsed = 2.2 * GB
  watch.check()
  heapUsed = 1.2 * GB
  watch.check()
  assert.equal(lines.length, 3)
  watch.stop()
})

test('a failing detail does not stop the log line', () => {
  const lines = []
  const watch = watchMemory((line) => lines.push(line), { usage: () => ({ heapUsed: 0, rss: 0 }), details: () => { throw new Error('boom') } })
  assert.match(lines[0], /details failed: boom$/)
  watch.stop()
})
