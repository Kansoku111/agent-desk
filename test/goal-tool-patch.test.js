import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { patchGoalToolSource } from '../server/goal-tool-patch.js'
import '../server/goal-tool-hook.js'

// Exercise the real load hook and upstream tool validators without booting dsh,
// calling a provider, or touching persisted goals.
const goalTool = await import('@deepseek-ai/dsh-tool-goal')
const require = createRequire(import.meta.url)
const ref = { goal_id: 'goal-test', revision: 7 }
const fillers = { objective: '', max_goal_rounds: 0, blocked_reason: '' }

function fixture({ authority = 'human', rounds = 3, phase = 'active', eventRevision = ref.revision } = {}) {
  const tools = new Map()
  const sections = []
  const calls = []
  const deferred = []
  const goal = { id: ref.goal_id, revision: ref.revision, objective: 'Original goal',
    maxGoalRounds: 23, roundsStarted: rounds, phase, activation: 'disarmed' }
  const source = authority === 'round'
    ? { kind: 'goal', goalId: goal.id, revision: eventRevision, round: rounds }
    : { kind: 'user' }
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { source } }]
  const agent = { id: 'agent', status: 'running', session: { snapshotEvents: () => events } }
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    systemPrompt: { section: (section) => sections.push(section), getSectionOrder: () => 0 },
    agents: { get: () => agent, currentInitiator: () => agent, roots: () => authority === 'child' ? [] : [agent], turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) },
    goals: { get: () => goal },
  }
  for (const operation of ['edit', 'pause', 'resume', 'complete', 'block']) {
    ctx.goals[operation] = (...args) => { calls.push({ operation, args }); return goal }
  }
  goalTool.apply(ctx, {})
  const exec = { agent, deferContext: (message) => deferred.push(message) }
  const invoke = (args) => tools.get('update_goal').execute({ ...ref, ...args }, exec)
  return { tools, sections, calls, deferred, goal, agent, invoke }
}

const rejectsCode = (code) => (error) => { assert.equal(error.code, code); return true }

test('installed goal tools take the patch; changed or already-patched sources are rejected', async () => {
  const source = await fs.readFile(require.resolve('@deepseek-ai/dsh-tool-goal'), 'utf8')
  const patched = patchGoalToolSource(source)
  assert.ok(patched)
  assert.equal(patchGoalToolSource(patched), null)
  assert.equal(patchGoalToolSource('export {}'), null)
  for (const anchor of [
    'difficulty, uncertainty, or useful remaining work is not blocked.',
    'description: "Update the current goal."',
    'Replacement objective; valid only with action edit.',
    'Replacement cap; valid only with action edit.',
    'Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.',
  ]) assert.equal(patchGoalToolSource(source.replace(anchor, 'changed upstream')), null, anchor)
  assert.equal(patchGoalToolSource(source + '\n// Replacement cap; valid only with action edit.'), null)
})

test('model guidance explains omission and fillers without changing required fields or authority policy', () => {
  const f = fixture()
  const tool = f.tools.get('update_goal')
  assert.deepEqual(tool.parameters.required, ['goal_id', 'revision', 'action'])
  assert.match(tool.description, /pause\/resume\/complete need only goal_id, revision, and action/)
  assert.match(tool.description, /objective="", max_goal_rounds=0, blocked_reason=""/)
  assert.match(tool.parameters.properties.objective.description, /Do not copy the current objective/)
  assert.match(tool.parameters.properties.max_goal_rounds.description, /use 0/)
  assert.match(tool.parameters.properties.blocked_reason.description, /Otherwise omit/)
  assert.match(f.sections[0].text, /max_goal_rounds=0/)
  assert.match(f.sections[0].text, /at least 3 consecutive goal rounds/)
  assert.match(tool.parameters.properties.action.description, /direct top-level human request/)
})

for (const action of ['pause', 'resume', 'complete']) {
  test(`${action} accepts omitted or empty fields and preserves the exact goal reference`, async () => {
    for (const optional of [{}, fillers]) {
      const f = fixture()
      const result = await f.invoke({ action, ...optional })
      assert.equal(result.goal.id, ref.goal_id)
      assert.deepEqual(f.calls, [{ operation: action, args: [f.agent, { id: ref.goal_id, revision: ref.revision }] }])
    }
  })
}

// 0.2.2-rc.1 ignores the fields an action does not use; earlier dsh rejected
// them. If a later dsh rejects them again, this fails and the error rewrite that
// this hook used to apply is worth restoring.
test('pause, resume and complete ignore a copied objective, cap or blocked reason', async () => {
  for (const action of ['pause', 'resume', 'complete']) {
    for (const extra of [
      { max_goal_rounds: 23 },
      { objective: 'Original goal' },
      { blocked_reason: 'Not blocked' },
      { objective: 'Original goal', max_goal_rounds: 23, blocked_reason: 'Not blocked' },
    ]) {
      const f = fixture()
      await f.invoke({ action, ...fillers, ...extra })
      assert.deepEqual(f.calls, [{ operation: action, args: [f.agent, { id: ref.goal_id, revision: ref.revision }] }])
    }
  }
})

test('edit and blocked pass only the fields they use to the goal domain', async () => {
  const edit = fixture()
  await edit.invoke({ action: 'edit', objective: 'New objective', max_goal_rounds: 30, blocked_reason: 'Unused' })
  assert.equal(edit.calls[0].operation, 'edit')
  assert.deepEqual(edit.calls[0].args[2], { objective: 'New objective', maxGoalRounds: 30 })
  const blocked = fixture()
  await blocked.invoke({ action: 'blocked', objective: 'Original goal', max_goal_rounds: 23, blocked_reason: 'Service remains unavailable' })
  assert.equal(blocked.calls[0].operation, 'block')
  assert.deepEqual(blocked.calls[0].args[2], { code: 'model-reported', message: 'Service remains unavailable' })
})

test('edit still permits independent replacements without sending filler values to the goal domain', async () => {
  for (const [optional, expected] of [
    [{ objective: 'New objective' }, { objective: 'New objective' }],
    [{ max_goal_rounds: 30 }, { maxGoalRounds: 30 }],
    [{ ...fillers, objective: 'New objective' }, { objective: 'New objective' }],
  ]) {
    const f = fixture()
    await f.invoke({ action: 'edit', ...optional })
    assert.deepEqual(f.calls[0].args[2], expected)
  }
})

test('authority, driver, paused-resume, blocked threshold, and schema guards remain enforced', async () => {
  for (const action of ['edit', 'pause', 'resume']) {
    const f = fixture({ authority: 'round' })
    await assert.rejects(f.invoke({ action, ...fillers }), rejectsCode('GOAL_TOOL_AUTHORITY_REQUIRED'))
    await assert.rejects(f.invoke({ action, ...fillers, max_goal_rounds: 23 }), rejectsCode('GOAL_TOOL_AUTHORITY_REQUIRED'))
    assert.equal(f.calls.length, 0)
  }
  const child = fixture({ authority: 'child' })
  await assert.rejects(child.invoke({ action: 'complete' }), rejectsCode('GOAL_TOOL_AUTHORITY_REQUIRED'))
  assert.equal(child.calls.length, 0)
  const idle = fixture()
  idle.agent.status = 'idle'
  await assert.rejects(idle.invoke({ action: 'resume' }), rejectsCode('GOAL_TOOL_DRIVER_REQUIRED'))
  assert.equal(idle.calls.length, 0)
  const paused = fixture({ phase: 'paused' })
  await assert.rejects(paused.invoke({ action: 'resume' }), rejectsCode('GOAL_TOOL_RESUME_PAUSED'))
  assert.equal(paused.calls.length, 0)
  const early = fixture({ authority: 'round', rounds: 2 })
  await assert.rejects(early.invoke({ action: 'blocked', blocked_reason: 'Unavailable' }), rejectsCode('GOAL_TOOL_BLOCK_THRESHOLD'))
  assert.equal(early.calls.length, 0)
  const stale = fixture({ authority: 'round', eventRevision: ref.revision - 1 })
  await assert.rejects(stale.invoke({ action: 'complete' }), rejectsCode('GOAL_TOOL_AUTHORITY_REQUIRED'))
  assert.equal(stale.calls.length, 0)
  const missingReason = fixture()
  await assert.rejects(missingReason.invoke({ action: 'blocked', ...fillers }), /blocked_reason is required/)
  assert.equal(missingReason.calls.length, 0)
  const malformed = fixture()
  await assert.rejects(malformed.invoke({ action: 'complete', max_goal_rounds: null }))
  await assert.rejects(malformed.invoke({ action: 'other' }))
  assert.equal(malformed.calls.length, 0)
})

test('authorized goal-round completion and blocking still defer the upstream closing-message context', async () => {
  for (const action of ['complete', 'blocked']) {
    const f = fixture({ authority: 'round' })
    await f.invoke({ action, ...fillers, blocked_reason: action === 'blocked' ? 'Unavailable for three rounds' : '' })
    assert.equal(f.calls.length, 1)
    assert.equal(f.deferred.length, 1)
    assert.match(JSON.stringify(f.deferred[0]), action === 'complete' ? /goal_complete/ : /goal_blocked/)
  }
})
