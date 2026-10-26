import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { patchGoalDriverSource } from '../server/goal-patch.js'
import { goalWaitDriverReady, isGoalWaiting, setGoalWaiting } from '../server/goal-wait.js'
const require = createRequire(import.meta.url)
const original = fs.readFileSync(require.resolve('@deepseek-ai/dsh-goal-round-driver'), 'utf8')

test('driver wait patch rejects changed or already-patched lifecycle anchors', () => {
  assert.equal(patchGoalDriverSource('export {}'), null)
  assert.equal(patchGoalDriverSource(original.replace('function validReservation(state, content, source)', 'function changedReservation()')), null)
  assert.equal(patchGoalDriverSource(patchGoalDriverSource(original)), null)
})

test('the actual driver rechecks waiting before reservations and before a claimed round enters', () => {
  const source = patchGoalDriverSource(original)
  const ready = source.match(/function readyToDrive\(state\) \{[\s\S]*?\n\t\}/)[0]
  const valid = source.match(/function validReservation\(state, content, source\) \{[\s\S]*?\n\t\t\}/)[0]
  const agent = { id: 'parent', status: 'idle' }
  const ctx = { fiber: { state: 2 }, agents: { get: () => agent } }
  const goal = { id: 'goal', revision: 1, phase: 'active', activation: 'armed', roundsStarted: 0 }
  const functions = new Function('agentDeskGoalWaiting', 'ctx', 'currentGoal', 'sameQueued', ready + '\n' + valid + '\nreturn { readyToDrive, validReservation }')(isGoalWaiting, ctx, () => goal, () => true)
  const state = { agent, attempt: { phase: 'claimed' } }
  const message = { goalId: 'goal', revision: 1, round: 1 }
  assert.equal(functions.readyToDrive(state), true)
  assert.equal(functions.validReservation(state, [], message), true)
  // A wait arriving during a durability/admission await must reject the old reservation.
  goalWaitDriverReady()
  const record = { agent, assertActive() {} }
  setGoalWaiting(record, 'waiting')
  assert.equal(functions.readyToDrive(state), false)
  assert.equal(functions.validReservation(state, [], message), false)
  assert.equal(goal.activation, 'armed')
  assert.equal(goal.roundsStarted, 0)
  setGoalWaiting(record, 'ready')
  assert.equal(functions.readyToDrive(state), true)
  assert.equal(functions.validReservation(state, [], message), true)
})
