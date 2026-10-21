import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectThreadRange } from '../web/src/thread-selection.ts'

const rows = ['a', 'b', 'c', 'd', 'e']

test('click toggles one session without affecting other selections', () => {
  assert.deepEqual(selectThreadRange(['e'], rows, null, 'b', false), ['e', 'b'])
  assert.deepEqual(selectThreadRange(['e', 'b'], rows, 'b', 'b', false), ['e'])
})

test('Shift selects inclusive ranges in both directions and retains other selections', () => {
  assert.deepEqual(selectThreadRange(['a', 'e'], rows, 'b', 'd', true), ['a', 'e', 'b', 'c', 'd'])
  assert.deepEqual(selectThreadRange([], rows, 'd', 'b', true), ['b', 'c', 'd'])
})

test('range selection never selects hidden rows, projects, or stale targets', () => {
  assert.deepEqual(selectThreadRange([], ['a', 'c', 'e'], 'a', 'e', true), ['a', 'c', 'e'])
  assert.deepEqual(selectThreadRange(['a'], rows, 'project', 'c', true), ['a', 'c'])
  assert.deepEqual(selectThreadRange(['a'], rows, 'a', 'project', true), ['a'])
})

test('missing anchor behaves as an ordinary toggle and never mutates input', () => {
  const selected = Object.freeze(['a'])
  assert.deepEqual(selectThreadRange(selected, rows, null, 'd', true), ['a', 'd'])
  assert.deepEqual(selected, ['a'])
})
