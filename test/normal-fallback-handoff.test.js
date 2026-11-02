import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasGoalHistory, handoffClaudeToThread, handoffThreadToClaude } from '../server/normal-fallback-handoff.js'

const choice = { model: 'claude:haiku', effort: 'low' }
const thread = { id: 'source', title: 'task', workspace: 'folder', permissionMode: 'danger-full-access' }
const turn = { id: 'turn', status: 'error', user: { text: 'request', images: [] }, items: [] }
const fixture = () => {
  const calls = []
  const terminals = {
    create: async (input) => { calls.push(['create', input]); return { id: 'target' } },
    deliverUsageFallback: async (id, prompt, guard) => { guard(); calls.push(['send', id, prompt]) },
    revealUsageFallback: async (id) => calls.push(['reveal', id]),
    discardUsageFallback: async (id) => calls.push(['remove', id]),
    stopUsageFallback: (id) => calls.push(['stop', id]),
  }
  const args = { thread, turn, turns: [turn], choice, terminals, guard: () => {}, commit: async (id) => calls.push(['commit', id]) }
  return { calls, args }
}

test('a goal command or recorded goal creation is treated as possibly active', () => {
  assert.equal(hasGoalHistory([{ user: { text: '/goal ship it' }, items: [] }]), true)
  assert.equal(hasGoalHistory([{ user: { text: 'work' }, items: [{ type: 'tool', name: 'agent_desk.run_code', input: { code: 'await tools.create_goal({})' } }] }]), true)
  assert.equal(hasGoalHistory([{ user: { text: 'work' }, items: [] }]), false)
})

test('Claude handoff starts a read-only DSH target only after linking and stopping source', async () => {
  const calls = []
  const threads = {
    checkUsageFallbackModel: async () => {},
    create: async (input) => { calls.push(['create', input]); return { id: 'target' } },
    deliverUsageFallback: async (id, input, marker, guard) => { guard(); calls.push(['deliver', id, input, marker]) },
    revealUsageFallback: async (id) => calls.push(['reveal', id]),
    discardUsageFallback: async (id) => calls.push(['remove', id]),
    stopUsageFallback: async (id) => calls.push(['stop', id]),
  }
  await handoffClaudeToThread({ terminal: { id: 'terminal', workspace: 'folder' }, turns: [turn],
    choice: { model: '["openai-codex","luna"]', effort: 'low' }, threads, guard: () => {},
    commit: async (id) => calls.push(['commit-and-stop', id]) })
  assert.deepEqual(calls.map((entry) => entry[0]), ['create', 'commit-and-stop', 'deliver', 'reveal'])
  assert.equal(calls[0][1].permissionMode, 'read-only')
  assert.equal(calls[0][1].usageFallbackPending, true)
  assert.match(calls[2][2].text, /読み取り専用/)
  assert.equal(calls[2][3].sourceTerminalId, 'terminal')
})

test('Claude handoff refuses image history instead of dropping it', async () => {
  let created = false
  await assert.rejects(handoffClaudeToThread({ terminal: { id: 'terminal', workspace: 'folder' },
    turns: [{ ...turn, user: { text: 'explain [画像]', images: [] } }], choice: { model: 'x', effort: 'low' },
    threads: { create: async () => { created = true } }, guard: () => {}, commit: async () => {} }), /画像/)
  assert.equal(created, false)
})

test('handoff persists a hidden target link before sending and revealing', async () => {
  const f = fixture()
  await handoffThreadToClaude(f.args)
  assert.deepEqual(f.calls.map((entry) => entry[0]), ['create', 'commit', 'send', 'reveal'])
  assert.equal(f.calls[0][1].requireDurable, true)
  assert.equal(f.calls[0][1].usageFallbackPending, true)
  assert.match(f.calls[2][2], /request/)
  assert.match(f.calls[2][2], /繰り返さない/)
})

test('handoff does not weaken permissions or discard images or plan state', async () => {
  for (const overrides of [
    { thread: { ...thread, permissionMode: 'workspace-write' } },
    { turn: { ...turn, user: { ...turn.user, plan: true } } },
    { turn: { ...turn, user: { ...turn.user, text: '/goal continue safely' } } },
    { turns: [{ ...turn, user: { ...turn.user, images: [{ file: 'abcdef.png' }] } }] },
  ]) {
    const f = fixture()
    await assert.rejects(handoffThreadToClaude({ ...f.args, ...overrides }))
    assert.equal(f.calls.length, 0)
  }
})

test('a target is removed when the source fence changes before commit', async () => {
  const f = fixture()
  let checks = 0
  f.args.guard = () => { if (++checks === 2) throw new Error('cancelled') }
  await assert.rejects(handoffThreadToClaude(f.args), /cancelled/)
  assert.deepEqual(f.calls.map((entry) => entry[0]), ['create', 'remove'])
})

test('a target is retained and stopped if commit or delivery is uncertain', async () => {
  for (const failure of ['commit', 'send']) {
    const f = fixture()
    if (failure === 'commit') f.args.commit = async () => { throw new Error('uncertain') }
    else f.args.terminals.deliverUsageFallback = async () => { throw new Error('uncertain') }
    await assert.rejects(handoffThreadToClaude(f.args), /uncertain/)
    assert.equal(f.calls.some((entry) => entry[0] === 'remove'), false)
    assert.deepEqual(f.calls.slice(-2).map((entry) => entry[0]), ['stop', 'reveal'])
  }
})
