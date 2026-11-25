import assert from 'node:assert/strict'
import { test } from 'node:test'
import { watchMemory } from '../server/memory-watch.js'

const GB = 1024 ** 3

test('the heap is logged at each new high from 1 GB, not on every check', () => {
  const lines = []
  let heapUsed = 0.5 * GB
  const watch = watchMemory((line) => lines.push(line), { usage: () => ({ heapUsed, rss: heapUsed * 1.2 }), details: () => 'task transcripts in memory: 3' })
  watch.check()
  assert.equal(lines.length, 0)
  heapUsed = 1.1 * GB
  watch.check()
  watch.check()
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^memory: heap 1126 MB of \d+ MB, rss 1352 MB · task transcripts in memory: 3$/)
  heapUsed = 2.2 * GB
  watch.check()
  heapUsed = 1.2 * GB
  watch.check()
  assert.equal(lines.length, 2)
  watch.stop()
})
