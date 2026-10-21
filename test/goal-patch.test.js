import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { patchGoalSource } from '../server/goal-patch.js'
import { patchAcpSource } from '../server/steer-patch.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The dsh-acp module the installed dsh loads. */
function installedSource() {
  const dshRequire = createRequire(path.join(root, 'node_modules/@deepseek-ai/dsh/package.json'))
  const dir = path.dirname(dshRequire.resolve('@deepseek-ai/dsh-acp/package.json'))
  return fs.readFileSync(path.join(dir, 'lib/index.js'), 'utf8')
}

/**
 * The patched settlement methods in a class of their own, with the module
 * helpers they call stubbed, so a test can drive them with a fake agent.
 */
function settlementClass() {
  const source = patchGoalSource(installedSource())
  const start = source.indexOf('\tasync agentDeskNextGoalRound(inflight) {')
  const end = source.indexOf('\n};', start)
  const cancelStart = source.indexOf('\tcancelPrompt(detail) {')
  const cancel = source.includes('const cancelled = inflight.cancellationDone.promise;')
    ? source.slice(cancelStart, start) : ''
  return new Function(`
    const internalError$1 = (message) => new Error(message);
    const errorChain = (error) => String(error?.message ?? error);
    const turnEndToStopReason = (end) => end.kind === "completed" ? "end_turn" : end.kind;
    return class { ${cancel} ${source.slice(start, end)} }`)()
}

/** A dsh agent that runs turns on demand, and its goal service. */
function fakeSession({ goal }) {
  let finishTurn = () => {}
  const agent = {
    status: 'idle',
    session: { seq: 0 },
    cancelled: 0,
    activity: Promise.resolve(),
    whenIdle() {
      return this.activity
    },
    run() {
      this.session.seq++
      this.status = 'running'
      this.activity = new Promise((resolve) => {
        finishTurn = () => {
          this.status = 'idle'
          resolve()
        }
      })
    },
    finish() {
      finishTurn()
    },
    cancel() {
      this.cancelled++
      this.finish()
    },
  }
  const goals = {
    disarmed: 0,
    get: () => goal,
    disarm() {
      this.disarmed++
      if (goal) goal.activation = 'disarmed'
    },
  }
  return { agent, goals }
}

/** Starts settling one prompt whose own turn has already ended. */
function settle(Bridge, { agent, goals, subagents }, endReason = { kind: 'completed' }) {
  const bridge = new Bridge()
  bridge.agent = agent
  bridge.ctx = { get: (name) => ({ goals, subagents })[name] }
  bridge.outputTail = Promise.resolve()
  let outcome
  const inflight = {
    messageQueued: true,
    admissionDone: Promise.resolve(),
    admissionController: new AbortController(),
    cancellationDone: Promise.withResolvers(),
    endReason,
    resolve: (reason) => (outcome = { stopReason: reason }),
    reject: (error) => (outcome = { error: error.message }),
  }
  bridge.inflight = inflight
  bridge.settleAfterQuiescence(inflight)
  return { bridge, inflight, outcome: () => outcome }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const activeGoal = () => ({ phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 30 })

test('the installed dsh-acp takes the goal patch alongside the steering patch, and still parses', () => {
  const patched = patchGoalSource(installedSource())
  assert.ok(patched, 'dsh-acp no longer matches goal-patch.js; update the patch for this dsh')
  const both = patchAcpSource(patched)
  assert.ok(both, 'the steering patch no longer applies after the goal patch')
  assert.ok(both.includes('await this.agentDeskNextGoalRound(inflight)'))
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-goal-')), 'index.mjs')
  try {
    fs.writeFileSync(file, both)
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

test('leaves an unexpected dsh-acp alone', () => {
  assert.equal(patchGoalSource('export const x = 1'), null)
  const source = installedSource()
  assert.equal(patchGoalSource(source.replace('\n\tsettleAfterQuiescence(inflight) {', '\n\tsettle(inflight) {')), null)
  assert.equal(patchGoalSource(source.replace('inflight.endReason = event.data.reason', 'inflight.end = event.data.reason')), null)
})

test('without a goal the prompt settles at the first idle, as before', async () => {
  const Bridge = settlementClass()
  const session = fakeSession({ goal: undefined })
  const prompt = settle(Bridge, session)
  await tick(20)
  assert.deepEqual(prompt.outcome(), { stopReason: 'end_turn' })
})

test('the prompt stays in flight through goal rounds and settles when the goal stops', async () => {
  const Bridge = settlementClass()
  const goal = activeGoal()
  const session = fakeSession({ goal })
  const prompt = settle(Bridge, session)
  // The driver queues the next round a moment after the agent goes idle.
  await tick(150)
  assert.equal(prompt.outcome(), undefined)
  session.agent.run()
  await tick(150)
  assert.equal(prompt.outcome(), undefined)
  // The round's turn ends, and the goal is complete: nothing follows.
  prompt.inflight.endReason = { kind: 'max-tokens' }
  goal.phase = 'complete'
  session.agent.finish()
  await tick(20)
  assert.deepEqual(prompt.outcome(), { stopReason: 'max-tokens' }, 'the stop reason is the last round\'s')
  assert.equal(prompt.inflight.agentDeskFollowingGoal, true)
})

test('the final allowed round stays inside the prompt until it finishes', async () => {
  const goal = { ...activeGoal(), roundsStarted: 0, maxGoalRounds: 1 }
  const session = fakeSession({ goal })
  const prompt = settle(settlementClass(), session)
  await tick(20)
  goal.roundsStarted = 1
  session.agent.run()
  await tick(150)
  assert.equal(prompt.outcome(), undefined)
  assert.equal(prompt.inflight.agentDeskFollowingGoal, true)
  prompt.inflight.endReason = { kind: 'max-tokens' }
  session.agent.finish()
  await tick(20)
  assert.deepEqual(prompt.outcome(), { stopReason: 'max-tokens' })
})

for (const terminal of ['complete', 'disarmed', 'exhausted']) {
  test(`an already-running round is awaited even when the goal is ${terminal}`, async () => {
    const goal = activeGoal()
    const session = fakeSession({ goal })
    const prompt = settle(settlementClass(), session)
    await tick(20)
    session.agent.run()
    if (terminal === 'complete') goal.phase = 'complete'
    if (terminal === 'disarmed') goal.activation = 'disarmed'
    if (terminal === 'exhausted') goal.roundsStarted = goal.maxGoalRounds
    await tick(150)
    assert.equal(prompt.outcome(), undefined)
    session.agent.finish()
    await tick(20)
    assert.deepEqual(prompt.outcome(), { stopReason: 'end_turn' })
  })
}

test('an idle goal at the round cap does not wait for a new round', async () => {
  const goal = { ...activeGoal(), roundsStarted: 1, maxGoalRounds: 1 }
  const prompt = settle(settlementClass(), fakeSession({ goal }))
  await tick(20)
  assert.deepEqual(prompt.outcome(), { stopReason: 'end_turn' })
})

test('cancelling between rounds disarms the goal so no round starts unseen', async () => {
  const Bridge = settlementClass()
  const goal = activeGoal()
  const session = fakeSession({ goal })
  const prompt = settle(Bridge, session)
  await tick(50)
  if (prompt.bridge.cancelPrompt) prompt.bridge.cancelPrompt('test cancellation')
  else prompt.inflight.cancelRequested = true
  await tick(150)
  assert.ok(session.goals.disarmed >= 1)
  assert.equal(goal.activation, 'disarmed')
  assert.deepEqual(prompt.outcome(), { stopReason: 'cancelled' })
})

test('a goal round that fails settles the prompt with the failure', async () => {
  const Bridge = settlementClass()
  const goal = activeGoal()
  const session = fakeSession({ goal })
  const prompt = settle(Bridge, session)
  await tick(20)
  session.agent.run()
  await tick(150)
  // dsh-acp records a failure outside the prompt's own turn; the driver disarms.
  prompt.inflight.agentError = new Error('WebSocket closed 1012')
  goal.activation = 'disarmed'
  session.agent.finish()
  await tick(20)
  assert.deepEqual(prompt.outcome(), { error: 'turn failed: WebSocket closed 1012' })
})

test('settlement drains children before completing the prompt', async (t) => {
  const Bridge = settlementClass()
  if (!Bridge.prototype.cancelPrompt) return t.skip('legacy dsh has no child-drain settlement')
  const child = Promise.withResolvers()
  let waits = 0
  const session = fakeSession({ goal: undefined })
  session.subagents = { waitForChildren: () => { waits++; return child.promise } }
  const prompt = settle(Bridge, session)
  await tick(20)
  assert.equal(waits, 1)
  assert.equal(prompt.outcome(), undefined)
  child.resolve(false)
  await tick(20)
  assert.deepEqual(prompt.outcome(), { stopReason: 'end_turn' })
})

test('cancelling while waiting for children disarms the goal and settles', async (t) => {
  const Bridge = settlementClass()
  if (!Bridge.prototype.cancelPrompt) return t.skip('legacy dsh has no child-drain settlement')
  const goal = activeGoal()
  const session = fakeSession({ goal })
  session.subagents = { waitForChildren: () => new Promise(() => {}) }
  const prompt = settle(Bridge, session)
  await tick(20)
  prompt.bridge.cancelPrompt('test cancellation')
  await tick(20)
  assert.equal(goal.activation, 'disarmed')
  assert.deepEqual(prompt.outcome(), { stopReason: 'cancelled' })
})

test('cancelling a running goal round disarms it before stopping the agent', async (t) => {
  const Bridge = settlementClass()
  if (!Bridge.prototype.cancelPrompt) return t.skip('legacy dsh has no child-drain settlement')
  const goal = activeGoal()
  const session = fakeSession({ goal })
  const prompt = settle(Bridge, session)
  await tick(20)
  session.agent.run()
  await tick(150)
  prompt.bridge.cancelPrompt('test cancellation')
  assert.equal(goal.activation, 'disarmed')
  await tick(20)
  assert.deepEqual(prompt.outcome(), { stopReason: 'cancelled' })
})
