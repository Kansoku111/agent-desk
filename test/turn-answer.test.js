import assert from 'node:assert/strict'
import test from 'node:test'
import { turnAnswer } from '../web/src/turn-answer.ts'

const agent = (id, text = id) => ({ type: 'agent', id, text })
const tool = (id) => ({ type: 'tool', id, name: 'read', kind: 'read', status: 'completed' })
const thought = (id) => ({ type: 'thought', id, text: id })
const ids = (items) => turnAnswer(items).map((item) => item.id)

test('the answer is the message after the last tool call; earlier ones are narration', () => {
  assert.deepEqual(ids([agent('narration'), tool('t1'), agent('narration2'), tool('t2'), agent('answer')]), ['answer'])
})

test('a conclusion followed by a note on it stays visible as a whole', () => {
  // GPT wrote its conclusion, then a short follow-up with no tool call between them.
  assert.deepEqual(ids([agent('narration'), tool('t1'), agent('conclusion'), agent('note')]), ['conclusion', 'note'])
})

test('thoughts between the answer messages are not part of the answer', () => {
  assert.deepEqual(ids([tool('t1'), agent('conclusion'), thought('th'), agent('note')]), ['conclusion', 'note'])
})

test('a turn without tool calls is answered by all of its messages', () => {
  assert.deepEqual(ids([agent('first'), agent('second')]), ['first', 'second'])
})

test('a turn that does not end with a message has no answer', () => {
  assert.deepEqual(ids([tool('t1'), agent('text'), thought('th')]), [])
  assert.deepEqual(ids([agent('text'), tool('t1')]), [])
  assert.deepEqual(ids([]), [])
})
