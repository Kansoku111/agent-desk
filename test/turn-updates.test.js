import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sameJson, shareTurn, withSpeed } from '../web/src/turn-updates.ts'

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const turn = () => ({
  id: 'turn', status: 'running', startedAt: 1, endedAt: null, error: null, stopReason: null,
  user: { text: 'hello', images: [] },
  items: [
    { type: 'agent', id: 'answer', text: 'first' },
    { type: 'tool', id: 'tool', name: 'edit', status: 'in_progress', input: { path: 'a.txt', edits: ['old'] } },
  ],
})
const speed = () => ({ tokensPerSecond: 12, state: 'streaming', estimated: true })

test('sameJson compares parsed JSON recursively, ignoring object key order but preserving array order', () => {
  const value = freeze({ a: [null, true, 3, { text: 'hello' }], b: false })
  assert.equal(sameJson(value, value), true)
  assert.equal(sameJson(value, freeze({ b: false, a: [null, true, 3, { text: 'hello' }] })), true)
  for (const [a, b] of [[null, {}], [null, false], [1, '1'], [[], {}], [[1, 2], [2, 1]], [{ a: 1 }, { b: 1 }], [{ a: 1 }, { a: 1, b: 2 }], [value, { ...value, a: [null, true, 3, { text: 'changed' }] }]]) {
    assert.equal(sameJson(a, b), false)
    assert.equal(sameJson(b, a), false)
  }
  assert.equal(sameJson(undefined, undefined), true)
  assert.equal(sameJson(undefined, null), false)
  assert.equal(sameJson({}, JSON.parse('{"__proto__":null}')), false)
})

test('shareTurn returns the incoming turn without a predecessor and reuses an equal predecessor', () => {
  const previous = freeze(turn())
  const next = freeze(structuredClone(previous))
  assert.equal(shareTurn(undefined, next), next)
  assert.equal(shareTurn(previous, next), previous)
})

test('shareTurn preserves only unchanged items without mutating either input', () => {
  const previous = freeze(turn())
  const next = structuredClone(previous)
  next.items[1].input.edits[0] = 'new'
  freeze(next)
  const result = shareTurn(previous, next)
  assert.deepEqual(result, next)
  assert.notEqual(result, previous)
  assert.notEqual(result, next)
  assert.notEqual(result.items, next.items)
  assert.equal(result.items[0], previous.items[0])
  assert.equal(result.items[1], next.items[1])
  assert.equal(previous.items[1].input.edits[0], 'old')
  assert.notEqual(next.items[0], previous.items[0])
})

test('shareTurn exposes metadata changes, reordering, addition, removal, and item type changes', () => {
  const previous = freeze(turn())
  const metadata = freeze({ ...structuredClone(previous), status: 'done', endedAt: 2, user: { text: 'corrected', images: [] } })
  const changed = shareTurn(previous, metadata)
  assert.deepEqual(changed, metadata)
  assert.notEqual(changed, previous)
  assert.equal(changed.items[0], previous.items[0])
  assert.equal(changed.items[1], previous.items[1])
  const reversed = freeze({ ...structuredClone(previous), items: structuredClone(previous.items).reverse() })
  const reordered = shareTurn(previous, reversed)
  assert.deepEqual(reordered, reversed)
  assert.equal(reordered.items[0], previous.items[1])
  assert.equal(reordered.items[1], previous.items[0])
  for (const items of [[], [structuredClone(previous.items[0])], [...structuredClone(previous.items), { type: 'agent', id: 'new', text: 'added' }], [{ ...previous.items[0], type: 'thought' }]]) {
    const next = freeze({ ...structuredClone(previous), items })
    const result = shareTurn(previous, next)
    assert.deepEqual(result, next)
    assert.notEqual(result, previous)
    if (items.length === 3) assert.equal(result.items[2], next.items[2])
    if (items[0]?.type === 'thought') assert.equal(result.items[0], next.items[0])
  }
})

test('withSpeed returns null for missing turns, unknown IDs, and unchanged speed', () => {
  const turns = freeze([turn()])
  assert.equal(withSpeed(undefined, 'turn', speed()), null)
  assert.equal(withSpeed([], 'turn', speed()), null)
  assert.equal(withSpeed(turns, 'missing', speed()), null)
  assert.equal(withSpeed(turns, 'turn', null), null)
  const measured = freeze([{ ...turn(), outputSpeed: speed() }])
  assert.equal(withSpeed(measured, 'turn', freeze(speed())), null)
})

test('withSpeed adds, replaces, and removes speed while sharing unaffected references', () => {
  const turns = freeze([turn(), { ...turn(), id: 'other' }])
  const incoming = freeze(speed())
  const added = freeze(withSpeed(turns, 'turn', incoming))
  assert.notEqual(added, turns)
  assert.notEqual(added[0], turns[0])
  assert.equal(added[0].outputSpeed, incoming)
  assert.equal(added[0].items, turns[0].items)
  assert.equal(added[0].user, turns[0].user)
  assert.equal(added[1], turns[1])
  assert.equal(Object.hasOwn(turns[0], 'outputSpeed'), false)
  const replacement = freeze({ ...speed(), tokensPerSecond: 20, state: 'done' })
  const replaced = freeze(withSpeed(added, 'turn', replacement))
  assert.equal(replaced[0].outputSpeed, replacement)
  assert.equal(replaced[1], turns[1])
  assert.equal(added[0].outputSpeed, incoming)
  const removed = withSpeed(replaced, 'turn', null)
  assert.deepEqual(removed, turns)
  assert.equal(Object.hasOwn(removed[0], 'outputSpeed'), false)
  assert.equal(removed[0].items, turns[0].items)
  assert.equal(removed[1], turns[1])
  assert.equal(replaced[0].outputSpeed, replacement)
  assert.equal(withSpeed(removed, 'turn', null), null)
})
