import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import YAML from 'yaml'
import { abPatch } from '../server/dsh-config.js'
import { apply } from '../server/ab-policy-plugin.js'
import { RuntimePool } from '../server/runtime.js'
import { TOOL_MODE_CONFIG } from '../server/ptc.js'
import { createThreadHandlers } from '../server/rpc-handlers-threads.js'
import { fixture as baseFixture, deferred } from './helpers/thread-manager.js'
import { apply as applySessionPolicy, PLAN_POLICY_CONFIG, planPolicyOption } from '../server/plan-policy-plugin.js'
import { Outbox, readQueues } from '../web/src/outbox.ts'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

async function fixture(t, options) {
  const f = await baseFixture(t, options)
  let policy = 'normal:workspace-write'
  f.policyOptions = () => [{ id: PLAN_POLICY_CONFIG, currentValue: policy }, { id: 'model', currentValue: f.thread.model }]
  f.pool.get = async (key) => { policy = key === 'plan' ? 'plan:read-only' : `normal:${key.replace('team:', '')}`; return f.runtime }
  const create = f.runtime.newSession.bind(f.runtime)
  f.runtime.newSession = async (...args) => ({ ...await create(...args), configOptions: f.policyOptions() })
  f.runtime.resumeSession = async (sessionId) => { f.runtime.liveSessions.add(sessionId); return { configOptions: f.policyOptions() } }
  f.runtime.setOption = async () => f.policyOptions()
  return f
}

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

test('Plan is per turn and preserves the same session both ways, including after restart', async (t) => {
  const f = await fixture(t, { getMcpServers: () => [{ name: 'unsafe' }] })
  const keys = [], servers = [], prompts = []
  const get = f.pool.get
  f.pool.get = async (key) => { keys.push(key); return get(key) }
  const create = f.runtime.newSession.bind(f.runtime)
  const resume = f.runtime.resumeSession.bind(f.runtime)
  f.runtime.newSession = async (cwd, mcp) => { servers.push(mcp); return create(cwd, mcp) }
  f.runtime.resumeSession = async (id, cwd, mcp) => { servers.push(mcp); return resume(id, cwd, mcp) }
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
  assert.equal(prompts[0].sessionId, prompts[1].sessionId)
  assert.deepEqual(prompts[1].blocks, [{ type: 'text', text: 'consult' }])
  assert.equal((await f.manager.send(f.thread.id, { text: 'consult', plan: true, messageId: ID })).turnId, receipt.turnId)
  await assert.rejects(f.manager.send(f.thread.id, { text: 'consult', messageId: ID }), /messageId/)
  assert.equal((await f.manager.get(f.thread.id)).turns[1].user.plan, true)
  const planId = prompts[1].sessionId
  // Simulate an application restart: the saved session mode, not a live holder, decides the boundary.
  f.runtime.liveSessions.delete(planId)
  await send({ text: 'implement' })
  assert.equal(keys.at(-1), 'workspace-write')
  assert.equal(prompts[2].sessionId, planId)
  assert.deepEqual(prompts[2].blocks, [{ type: 'text', text: 'implement' }])
  assert.deepEqual(servers.at(-1), [{ name: 'unsafe' }])
  assert.equal(f.calls.sessions, 1)
  assert.equal(f.manager.threads.get(f.thread.id).sessionPlan, false)
  assert.equal(f.manager.threads.get(f.thread.id).permissionMode, 'workspace-write')
})

for (const plan of [true, false]) {
  test(`failed Plan migration keeps the ID and never creates a replacement (plan=${plan})`, async (t) => {
    const f = await fixture(t)
    f.runtime.prompt = async () => ({ stopReason: 'end_turn' })
    const send = async (value) => {
      const done = once(f.manager, 'turn-finished')
      await f.manager.send(f.thread.id, { text: 'request', plan: value })
      return (await done)[0]
    }
    assert.equal((await send(!plan)).status, 'done')
    const id = f.manager.threads.get(f.thread.id).sessionId
    const resume = f.runtime.resumeSession
    f.runtime.resumeSession = async () => { throw new Error('missing history') }
    assert.equal((await send(plan)).status, 'error')
    assert.equal(f.manager.threads.get(f.thread.id).sessionId, id)
    assert.equal(f.calls.sessions, 1)
    assert.equal(f.manager.threads.get(f.thread.id).carryover, undefined)
    f.runtime.resumeSession = resume
    assert.equal((await send(plan)).status, 'done')
    assert.equal(f.manager.threads.get(f.thread.id).sessionId, id)
    assert.equal(f.calls.sessions, 1)
  })

  for (const ack of [[], [{ id: PLAN_POLICY_CONFIG, currentValue: 'wrong-policy' }]]) {
    test(`missing or wrong policy acknowledgement stops the prompt (plan=${plan}, ack=${ack.length})`, async (t) => {
      const f = await fixture(t)
      let prompts = 0
      f.runtime.prompt = async () => { prompts++; return { stopReason: 'end_turn' } }
      let done = once(f.manager, 'turn-finished')
      await f.manager.send(f.thread.id, { text: 'initial', plan: !plan })
      assert.equal((await done)[0].status, 'done')
      const id = f.manager.threads.get(f.thread.id).sessionId
      f.runtime.resumeSession = async (id) => { f.runtime.liveSessions.add(id); return { configOptions: ack } }
      done = once(f.manager, 'turn-finished')
      await f.manager.send(f.thread.id, { text: 'must not prompt', plan })
      assert.equal((await done)[0].status, 'error')
      assert.equal(prompts, 1)
      assert.equal(f.manager.threads.get(f.thread.id).sessionId, id)
      assert.equal(f.runtime.liveSessions.has(id), false)
      assert.equal(f.calls.sessions, 1)
    })
  }
}

test('saved Plan sessions resume under the same ID after an application restart', async (t) => {
  const f = await fixture(t)
  f.runtime.prompt = async () => ({ stopReason: 'end_turn' })
  let done = once(f.manager, 'turn-finished')
  await f.manager.send(f.thread.id, { text: 'consult', plan: true })
  await done
  const id = f.manager.threads.get(f.thread.id).sessionId
  await f.manager.shutdown()
  f.runtime.liveSessions.clear()
  const restored = f.makeManager()
  await restored.load()
  assert.equal(restored.threads.get(f.thread.id).sessionPlan, true)
  done = once(restored, 'turn-finished')
  await restored.send(f.thread.id, { text: 'implement', plan: false })
  assert.equal((await done)[0].status, 'done')
  assert.equal(restored.threads.get(f.thread.id).sessionId, id)
  assert.equal(restored.threads.get(f.thread.id).sessionPlan, false)
  assert.equal(f.calls.sessions, 1)
})

test('Plan migration refuses to resume if closing the previous holder fails', async (t) => {
  const f = await fixture(t)
  f.runtime.prompt = async () => ({ stopReason: 'end_turn' })
  let done = once(f.manager, 'turn-finished')
  await f.manager.send(f.thread.id, { text: 'initial' })
  await done
  f.runtime.closeSession = async () => { throw new Error('close failed') }
  f.runtime.resumeSession = async () => assert.fail('must close old session first')
  done = once(f.manager, 'turn-finished')
  await f.manager.send(f.thread.id, { text: 'consult', plan: true })
  assert.equal((await done)[0].status, 'error')
  assert.equal(f.calls.sessions, 1)
})

test('failed migration persistence prevents prompting and retry keeps the same session', async (t) => {
  const f = await fixture(t)
  let prompts = 0
  f.runtime.prompt = async () => { prompts++; return { stopReason: 'end_turn' } }
  const flush = f.manager.indexWriter.flush.bind(f.manager.indexWriter)
  let writes = 0
  f.manager.indexWriter.flush = async () => { if (++writes === 3) throw new Error('index flush failed'); return flush() }
  let done = once(f.manager, 'turn-finished')
  await f.manager.send(f.thread.id, { text: 'consult', plan: true })
  assert.equal((await done)[0].status, 'error')
  const id = f.manager.threads.get(f.thread.id).sessionId
  assert.ok(id)
  assert.equal(prompts, 0)
  f.manager.indexWriter.flush = flush
  done = once(f.manager, 'turn-finished')
  await f.manager.send(f.thread.id, { text: 'retry', plan: true })
  assert.equal((await done)[0].status, 'done')
  assert.equal(f.manager.threads.get(f.thread.id).sessionId, id)
  assert.equal(f.calls.sessions, 1)
})

test('removal during Plan resume waits and closes the migrated session', async (t) => {
  const f = await fixture(t)
  f.runtime.prompt = async () => ({ stopReason: 'end_turn' })
  const done = once(f.manager, 'turn-finished')
  await f.manager.send(f.thread.id, { text: 'initial' })
  await done
  const started = deferred(), resume = deferred()
  const resumeSession = f.runtime.resumeSession
  f.runtime.resumeSession = async (...args) => { started.resolve(); await resume.promise; return resumeSession(...args) }
  await f.manager.send(f.thread.id, { text: 'consult', plan: true })
  await started.promise
  const removing = f.manager.remove(f.thread.id)
  resume.resolve()
  await removing
  assert.equal(f.manager.threads.has(f.thread.id), false)
  assert.equal(f.runtime.liveSessions.size, 0)
  assert.equal(f.calls.sessions, 1)
})

test('session policy acknowledgement waits for durable mode application', async () => {
  let created, release
  const agent = { session: { append: (_type, data) => { mode = data.mode } } }
  let mode = 'danger-full-access'
  const flushed = new Promise((resolve) => { release = resolve })
  const ctx = { on: (_event, handler) => { created = handler }, sandboxPolicy: { defaultMode: 'read-only', resolve: () => ({ mode }) }, sessions: { flush: () => flushed } }
  applySessionPolicy(ctx, { plan: true })
  const applying = created({ agent })
  assert.deepEqual(planPolicyOption(agent), [])
  release()
  await applying
  assert.equal(planPolicyOption(agent)[0].currentValue, 'plan:read-only')
  const failedAgent = { session: { append() {} } }
  ctx.sessions.flush = async () => { throw new Error('flush failed') }
  mode = 'danger-full-access'
  await assert.rejects(created({ agent: failedAgent }), /flush failed/)
  assert.deepEqual(planPolicyOption(failedAgent), [])
})

test('Plan forces native tools without changing the saved PTC choice, including team tasks', async (t) => {
  const f = await fixture(t)
  const thread = await f.manager.create({ workspace: f.base, model: f.thread.model, toolMode: 'ptc', team: { id: 'team', childId: 'child' } })
  const selected = []
  const options = (value) => [{ id: TOOL_MODE_CONFIG, currentValue: value }, ...f.policyOptions()]
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
