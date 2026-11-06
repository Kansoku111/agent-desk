import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCodexEvent } from '../server/codex-events.js'

const turn = () => ({ id: 'turn', items: [], user: {}, status: 'running' })
const item = (t, method, value, now = 10) => applyCodexEvent(t, `item/${method}`, { item: value }, now)
const delta = (t, method, id, value) => applyCodexEvent(t, `item/${method}`, { itemId: id, delta: value }, 12)

test('interleaved text and command deltas are replaced by completed snapshots', () => {
  const t = turn()
  item(t, 'started', { type: 'agentMessage', id: 'a', text: '' })
  item(t, 'started', { type: 'commandExecution', id: 'c', command: 'ls', cwd: '/w', aggregatedOutput: '', status: 'inProgress' })
  delta(t, 'agentMessage/delta', 'a', 'hel')
  delta(t, 'commandExecution/outputDelta', 'c', 'first')
  delta(t, 'agentMessage/delta', 'a', 'lo')
  assert.equal(t.items[0].text, 'hello')
  assert.equal(t.items[1].output, 'first')
  item(t, 'completed', { type: 'commandExecution', id: 'c', command: 'ls', cwd: '/w', aggregatedOutput: 'final', exitCode: 0, status: 'completed' }, 20)
  item(t, 'completed', { type: 'agentMessage', id: 'a', text: 'final answer' }, 21)
  item(t, 'completed', { type: 'commandExecution', id: 'c', command: 'ls', cwd: '/w', aggregatedOutput: 'final', exitCode: 0, status: 'completed' }, 30)
  assert.equal(t.items.length, 2)
  assert.equal(t.items[0].text, 'final answer')
  assert.deepEqual(t.items[1], { type: 'tool', id: 'c', name: 'shell', kind: 'execute', status: 'completed', input: { command: 'ls', cwd: '/w', exitCode: 0 }, output: 'final', startedAt: 10, endedAt: 20 })
})

test('reasoning deltas and snapshots use summary or content', () => {
  const t = turn()
  delta(t, 'reasoning/summaryTextDelta', 'r', 'thinking')
  item(t, 'completed', { type: 'reasoning', id: 'r', summary: ['one', 'two'], content: ['private'] })
  assert.equal(t.items[0].text, 'one\n\ntwo')
  item(t, 'completed', { type: 'reasoning', id: 'r2', summary: [], content: ['content'] })
  assert.equal(t.items[1].text, 'content')
})

test('patch snapshots retain all diffs and failed patches remain failed', () => {
  const t = turn()
  const changes = [{ path: '/a', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' }, { path: '/b', kind: { type: 'add' }, diff: '+second' }]
  item(t, 'completed', { type: 'fileChange', id: 'p', changes, status: 'failed' })
  assert.equal(t.items[0].status, 'failed')
  assert.equal(t.items[0].input.path, '/a')
  assert.equal(t.items[0].input.old_string, 'old')
  assert.equal(t.items[0].input.new_string, 'new')
  assert.deepEqual(t.items[0].input.changes, changes)
  assert.match(t.items[0].output, /second/)
  item(t, 'completed', { type: 'fileChange', id: 'q', changes, status: 'declined' })
  assert.equal(t.items[1].status, 'failed')
})

test('other tool types retain inputs, results and failures', () => {
  const t = turn()
  item(t, 'completed', { type: 'mcpToolCall', id: 'm', server: 'chrome', tool: 'click', arguments: { uid: 'x' }, result: { content: [{ type: 'text', text: 'ok' }] } })
  item(t, 'completed', { type: 'dynamicToolCall', id: 'd', tool: 'custom', arguments: { x: 1 }, success: false, contentItems: [{ type: 'inputText', text: 'bad' }] })
  item(t, 'completed', { type: 'webSearch', id: 'w', query: 'search', results: [{ title: 'result' }] })
  item(t, 'completed', { type: 'imageView', id: 'i', path: '/a.png' })
  item(t, 'completed', { type: 'contextCompaction', id: 'x' })
  assert.equal(t.items[0].name, 'mcp__chrome__click')
  assert.match(t.items[0].output, /ok/)
  assert.equal(t.items[1].status, 'failed')
  assert.equal(t.items[2].input.query, 'search')
  assert.equal(t.items[3].input.path, '/a.png')
  assert.equal(t.items[4].status, 'completed')
})

test('unrecognized and malformed notifications do not modify turn', () => {
  const t = turn()
  assert.equal(applyCodexEvent(t, 'turn/completed', {}), false)
  assert.equal(applyCodexEvent(t, 'item/started', { item: { type: 'userMessage', id: 'u' } }), false)
  assert.equal(applyCodexEvent(t, 'item/agentMessage/delta', { itemId: 'a', delta: 1 }), false)
  assert.deepEqual(t.items, [])
})

test('unknown item types are retained for display', () => {
  const t = turn()
  item(t, 'completed', { type: 'functionCallOutput', id: 'f', name: 'call', output: { value: 1 } })
  assert.equal(t.items[0].name, 'functionCallOutput')
  assert.match(t.items[0].output, /"value": 1/)
})
