import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import { PLAN_INSTRUCTION } from '../server/thread-utils.js'
import { TOOL_MODE_CONFIG } from '../server/ptc.js'
import { createThreadHandlers } from '../server/rpc-handlers-threads.js'
import { fixture } from './helpers/thread-manager.js'
import { apply, SESSION_POLICY_CONFIG, sessionPolicyOption } from '../server/session-policy-plugin.js'
import { Outbox, readQueues } from '../web/src/outbox.ts'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const policy = (mode = 'workspace-write') => [{ id: SESSION_POLICY_CONFIG, currentValue: mode }]

test('Plan appends one scoped instruction without changing session, runtime, MCP or PTC', async (t) => {
  const f = await fixture(t, { getMcpServers: () => [{ name: 'chrome' }] })
  await f.manager.update(f.thread.id, { toolMode: 'ptc' })
  const keys = [], servers = [], prompts = []
  f.pool.get = async (key) => { keys.push(key); return f.runtime }
  const create = f.runtime.newSession.bind(f.runtime)
  f.runtime.newSession = async (cwd, mcp) => { servers.push(mcp); return { ...await create(cwd, mcp), configOptions: [{ id: TOOL_MODE_CONFIG, currentValue: 'ptc' }, { id: 'model', currentValue: f.thread.model }] } }
  f.runtime.prompt = async (id, blocks) => { prompts.push({ id, blocks }); return { stopReason: 'end_turn' } }
  const send = async (message) => {
    const done = once(f.manager, 'turn-finished')
    const receipt = await f.manager.send(f.thread.id, message)
    assert.equal((await done)[0].status, 'done')
    return receipt
  }
  await send({ text: 'first' })
  const receipt = await send({ text: 'consult', plan: true, messageId: ID })
  await send({ text: 'implement' })
  assert.deepEqual(keys, ['workspace-write', 'workspace-write', 'workspace-write'])
  assert.equal(new Set(prompts.map((entry) => entry.id)).size, 1)
  assert.deepEqual(servers, [[{ name: 'chrome' }]])
  assert.deepEqual(f.calls.closed, [])
  assert.equal(f.calls.sessions, 1)
  assert.deepEqual(prompts.map((entry) => entry.blocks[0].text), ['first', 'consult\n\n' + PLAN_INSTRUCTION, 'implement'])
  const stored = f.manager.threads.get(f.thread.id)
  assert.equal(stored.sessionPlan, undefined)
  assert.equal(stored.toolMode, 'ptc')
  assert.equal(stored.permissionMode, 'workspace-write')
  assert.equal((await f.manager.get(f.thread.id)).turns[1].user.text, 'consult')
  assert.equal((await f.manager.send(f.thread.id, { text: 'consult', plan: true, messageId: ID })).turnId, receipt.turnId)
  await assert.rejects(f.manager.send(f.thread.id, { text: 'consult', messageId: ID }), /messageId/)
  assert.equal(prompts.length, 3)
})

test('Plan suffix also reaches attachment-only messages after file references', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(f.paths.attachmentsDir, { recursive: true })
  const file = ID + '.png'
  await fs.writeFile(path.join(f.paths.attachmentsDir, file), 'fixture image')
  f.finish.resolve()
  const done = once(f.manager, 'turn-finished')
  await f.manager.send(f.thread.id, { images: [{ file, mimeType: 'image/png', name: 'example.png' }], plan: true })
  assert.equal((await done)[0].status, 'done')
  assert.equal(f.calls.prompts[0].blocks[0].text, PLAN_INSTRUCTION)
  assert.equal(f.calls.prompts[0].blocks[1].type, 'image')
})

test('Plan steering carries its suffix and stable receipt without changing the running turn', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'work' })
  await f.started.promise
  const message = { text: 'consult now', plan: true, messageId: ID }
  assert.equal((await f.manager.steer(f.thread.id, message)).steered, true)
  assert.equal((await f.manager.steer(f.thread.id, message)).steered, true)
  assert.equal(f.calls.steers.length, 1)
  assert.equal(f.calls.steers[0].blocks[0].text, 'consult now\n\n' + PLAN_INSTRUCTION)
  const item = (await f.manager.get(f.thread.id)).turns[0].items.find((entry) => entry.type === 'steer')
  assert.equal(item.plan, true)
  assert.equal(item.text, 'consult now')
  await assert.rejects(f.manager.steer(f.thread.id, { ...message, plan: false }), /messageId/)
})

test('Plan keeps ordinary permission approval behavior', async (t) => {
  const f = await fixture(t)
  f.manager.on('approval-needed', () => {
    const request = f.manager.pendingPermissions(f.thread.id)[0]
    f.manager.respondPermission(request.requestId, 'allow')
  })
  f.runtime.prompt = async (sessionId) => {
    const response = await f.manager.onPermission({ sessionId, toolCall: { title: 'write' }, options: [{ kind: 'allow_once', optionId: 'allow' }] })
    assert.deepEqual(response, { outcome: { outcome: 'selected', optionId: 'allow' } })
    return { stopReason: 'end_turn' }
  }
  const done = once(f.manager, 'turn-finished')
  await f.manager.send(f.thread.id, { text: 'consult', plan: true })
  assert.equal((await done)[0].status, 'done')
})

for (const sessionPlan of [true, false]) {
  test('legacy strict Plan restores the same session once (saved=' + sessionPlan + ')', async (t) => {
    const f = await fixture(t)
    Object.assign(f.manager.threads.get(f.thread.id), { sessionId: 'legacy', sessionPlan })
    f.runtime.liveSessions.add('legacy')
    let resumes = 0
    f.runtime.resumeSession = async (id) => { resumes++; f.runtime.liveSessions.add(id); return { configOptions: [...policy(), { id: 'model', currentValue: f.thread.model }] } }
    f.runtime.prompt = async () => ({ stopReason: 'end_turn' })
    const send = async (plan) => {
      const done = once(f.manager, 'turn-finished')
      await f.manager.send(f.thread.id, { text: 'continue', plan })
      assert.equal((await done)[0].status, 'done')
    }
    await send(true)
    await send(false)
    assert.equal(resumes, 1)
    assert.equal(f.calls.sessions, 0)
    assert.deepEqual(f.calls.closed, ['legacy'])
    assert.equal(f.manager.threads.get(f.thread.id).sessionId, 'legacy')
    assert.equal(f.manager.threads.get(f.thread.id).sessionPlan, undefined)
  })
}

for (const failure of ['resume', 'missing-policy', 'wrong-policy', 'close']) {
  test('legacy Plan migration fails closed without replacing history: ' + failure, async (t) => {
    const f = await fixture(t)
    Object.assign(f.manager.threads.get(f.thread.id), { sessionId: 'legacy', sessionPlan: true })
    f.runtime.liveSessions.add('legacy')
    if (failure === 'close') f.runtime.closeSession = async () => { throw new Error('close failed') }
    f.runtime.resumeSession = async (id) => {
      if (failure === 'resume') throw new Error('missing history')
      f.runtime.liveSessions.add(id)
      return { configOptions: failure === 'missing-policy' ? [] : policy('read-only') }
    }
    f.runtime.prompt = async () => assert.fail('must not prompt')
    const done = once(f.manager, 'turn-finished')
    await f.manager.send(f.thread.id, { text: 'continue', plan: true })
    assert.equal((await done)[0].status, 'error')
    assert.equal(f.manager.threads.get(f.thread.id).sessionId, 'legacy')
    assert.equal(f.manager.threads.get(f.thread.id).sessionPlan, true)
    assert.equal(f.calls.sessions, 0)
  })
}

test('restored policy is acknowledged only after its event is durable', async () => {
  let created, release, mode = 'read-only'
  const agent = { session: { append: (_type, data) => { mode = data.mode } } }
  const flushed = new Promise((resolve) => { release = resolve })
  const ctx = { on: (_event, handler) => { created = handler }, sandboxPolicy: { defaultMode: 'workspace-write', resolve: () => ({ mode }) }, sessions: { flush: () => flushed } }
  apply(ctx)
  const applying = created({ agent })
  assert.deepEqual(sessionPolicyOption(agent), [])
  release()
  await applying
  assert.equal(sessionPolicyOption(agent)[0].currentValue, 'workspace-write')
})

test('first-message RPC carries Plan and binds it to the create key', async (t) => {
  const f = await fixture(t)
  const handlers = createThreadHandlers({ paths: f.paths, threads: f.manager, mutateSettings: async () => {} })
  const params = { workspace: f.base, model: f.thread.model, text: 'consult', plan: true, createId: ID }
  const created = await handlers['thread.create'](params)
  await f.started.promise
  assert.equal(f.calls.prompts[0].blocks[0].text, 'consult\n\n' + PLAN_INSTRUCTION)
  assert.equal((await f.manager.get(created.thread.id)).turns[0].user.plan, true)
  await assert.rejects(handlers['thread.create']({ ...params, plan: false }), /異なる内容/)
})

test('queued Plan survives reload and can be sent or steered with its flag intact', async () => {
  let saved, status = 'running'
  const calls = []
  const options = { initial: {}, persist: (v) => { saved = JSON.stringify(v) }, changed() {}, thread: () => ({ status }), ready: () => true, report() {}, newId: () => ID,
    request: async (type, params) => { calls.push({ type, params }); status = 'running'; return { turnId: 'turn', steered: true } } }
  const outbox = new Outbox(options)
  outbox.enqueue('task', 'consult', [], false, true)
  const initial = readQueues(saved)
  await new Outbox({ ...options, initial }).steer('task', ID)
  assert.equal(calls[0].type, 'thread.steer')
  assert.equal(calls[0].params.plan, true)
  status = 'idle'
  await new Outbox({ ...options, initial }).flush('task')
  assert.equal(calls[1].type, 'thread.send')
  assert.equal(calls[1].params.plan, true)
})
