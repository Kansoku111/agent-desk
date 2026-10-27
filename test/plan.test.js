import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import YAML from 'yaml'
import { abPatch } from '../server/dsh-config.js'
import { apply } from '../server/ab-policy-plugin.js'
import { RuntimePool } from '../server/runtime.js'
import { TOOL_MODE_CONFIG } from '../server/ptc.js'
import { createThreadHandlers } from '../server/rpc-handlers-threads.js'
import { fixture } from './helpers/thread-manager.js'
import { Outbox, readQueues } from '../web/src/outbox.ts'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

test('Plan has a separate read-only runtime and denies mutating or arbitrary code tools', () => {
  const pool = new RuntimePool({ paths: { planPatch: 'plan' }, onUpdate() {}, onPermission() {} })
  assert.equal(pool.runtimes.get('plan').mode, 'read-only')
  assert.deepEqual(pool.runtimes.get('plan').patches, ['plan'])
  const rows = YAML.parse(abPatch({ plan: true, lean: false }))
  assert.deepEqual(rows.find((row) => row.id === 'tool-fs').config, { write: false, edit: false })
  for (const id of ['tool-bash', 'tool-pwsh', 'tool-subagent', 'tool-goal']) assert.ok(rows.some((row) => row.id === id && row.disabled))
  let guard, section
  apply({ tools: { guard: (fn) => { guard = fn } }, systemPrompt: { section: (value) => { section = value } } }, { plan: true })
  assert.match(section.text, /Plan mode/)
  for (const name of ['write', 'edit', 'run_code', 'pwsh', 'subagent', 'mcp__chrome__evaluate_script', 'unknown']) assert.ok(guard({ name, arguments: {} }), name)
  assert.ok(guard({ name: 'read', arguments: { sandbox_permissions: 'danger-full-access' } }))
  assert.equal(guard({ name: 'read', arguments: {} }), undefined)
})

test('Plan is per turn, preserves receipts, rejects escalation and switches sessions both ways', async (t) => {
  const f = await fixture(t, { getMcpServers: () => [{ name: 'unsafe' }] })
  const keys = [], servers = [], prompts = []
  f.pool.get = async (key) => { keys.push(key); return f.runtime }
  const create = f.runtime.newSession.bind(f.runtime)
  f.runtime.newSession = async (cwd, mcp) => { servers.push(mcp); return create(cwd, mcp) }
  f.runtime.prompt = async (sessionId, blocks) => { prompts.push({ sessionId, blocks }); return { stopReason: 'end_turn' } }
  const send = async (message) => {
    const finished = once(f.manager, 'turn-finished')
    const receipt = await f.manager.send(f.thread.id, message)
    assert.equal((await finished)[0].status, 'done')
    return receipt
  }
  await send({ text: 'first' })
  const receipt = await send({ text: 'consult', plan: true, messageId: ID })
  assert.deepEqual(keys, ['workspace-write', 'plan'])
  assert.deepEqual(servers, [[{ name: 'unsafe' }], []])
  assert.notEqual(prompts[0].sessionId, prompts[1].sessionId)
  assert.match(prompts[1].blocks[0].text, /first/)
  assert.equal((await f.manager.send(f.thread.id, { text: 'consult', plan: true, messageId: ID })).turnId, receipt.turnId)
  await assert.rejects(f.manager.send(f.thread.id, { text: 'consult', messageId: ID }), /messageId/)
  assert.equal((await f.manager.get(f.thread.id)).turns[1].user.plan, true)
  const planId = prompts[1].sessionId
  // Simulate an application restart: the saved session mode, not a live holder, decides the boundary.
  f.runtime.liveSessions.delete(planId)
  await send({ text: 'implement' })
  assert.equal(keys.at(-1), 'workspace-write')
  assert.notEqual(prompts[2].sessionId, planId)
  assert.match(prompts[2].blocks[0].text, /consult/)
  assert.equal(f.manager.threads.get(f.thread.id).permissionMode, 'workspace-write')
})

test('Plan forces native tools without changing the saved PTC choice, including team tasks', async (t) => {
  const f = await fixture(t)
  const thread = await f.manager.create({ workspace: f.base, model: f.thread.model, toolMode: 'ptc', team: { id: 'team', childId: 'child' } })
  const selected = []
  const options = (value) => [{ id: TOOL_MODE_CONFIG, currentValue: value }, { id: 'model', currentValue: f.thread.model }]
  f.runtime.newSession = async () => { f.runtime.liveSessions.add('plan-session'); return { sessionId: 'plan-session', configOptions: options('ptc') } }
  f.runtime.setOption = async (_id, config, value) => { selected.push([config, value]); return options(value) }
  f.runtime.prompt = async () => ({ stopReason: 'end_turn' })
  const done = once(f.manager, 'turn-finished')
  await f.manager.send(thread.id, { text: 'consult', plan: true })
  assert.equal((await done)[0].status, 'done')
  assert.deepEqual(selected, [[TOOL_MODE_CONFIG, 'native']])
  assert.equal(f.manager.threads.get(thread.id).toolMode, 'ptc')
})

test('first-message RPC carries Plan and binds it to the create key', async (t) => {
  const f = await fixture(t)
  const handlers = createThreadHandlers({ paths: f.paths, threads: f.manager, mutateSettings: async () => {} })
  const params = { workspace: f.base, model: f.thread.model, text: 'consult', plan: true, createId: ID }
  const created = await handlers['thread.create'](params)
  const turn = (await f.manager.get(created.thread.id)).turns[0]
  assert.equal(turn.user.plan, true)
  await assert.rejects(handlers['thread.create']({ ...params, plan: false }), /異なる内容/)
  f.finish.resolve()
})

test('Plan cannot be steered into an active writable turn or approved', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'work' })
  await f.started.promise
  assert.deepEqual(await f.manager.steer(f.thread.id, { text: 'consult', plan: true }), { steered: false })
  assert.equal(f.calls.steers.length, 0)
  f.finish.resolve()
  await once(f.manager, 'turn-finished')
  f.runtime.prompt = async (sessionId) => {
    assert.deepEqual(await f.manager.onPermission({ sessionId, options: [{ kind: 'allow_once', optionId: 'yes' }] }), { outcome: { outcome: 'cancelled' } })
    return { stopReason: 'end_turn' }
  }
  const done = once(f.manager, 'turn-finished')
  await f.manager.send(f.thread.id, { text: 'plan', plan: true })
  assert.equal((await done)[0].status, 'done')
})

test('queued Plan survives reload and cannot be steered before its own turn', async () => {
  let saved, status = 'running'
  const calls = []
  const options = { initial: {}, persist: (v) => { saved = JSON.stringify(v) }, changed() {}, thread: () => ({ status }), ready: () => true, report() {}, newId: () => ID,
    request: async (type, params) => { calls.push({ type, params }); status = 'running'; return { turnId: 'turn' } } }
  const outbox = new Outbox(options)
  outbox.enqueue('task', 'consult', [], false, true)
  assert.deepEqual(readQueues(saved.replace('"plan":true', '"plan":"invalid"')), {})
  const restored = new Outbox({ ...options, initial: readQueues(saved) })
  await restored.steer('task', ID)
  assert.equal(calls.length, 0)
  status = 'idle'
  await restored.flush('task')
  assert.equal(calls[0].type, 'thread.send')
  assert.equal(calls[0].params.plan, true)
})
