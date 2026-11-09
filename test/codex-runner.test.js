import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexRunner } from '../server/codex-runner.js'
import { createCodexHandlers } from '../server/rpc-handlers-codex.js'

class FakeWorkServer extends EventEmitter {
  constructor() { super(); this.calls = []; this.responses = []; this.nextThread = 0; this.nextTurn = 0; this.active = 0; this.loaded = new Map(); this.account = { type: 'chatgpt', email: 'a@example.test', workspaceName: 'One' } }
  async use(fn) { this.active++; try { return await fn() } finally { this.active-- } }
  async rawRequest(method, params = {}) {
    this.calls.push({ method, params })
    switch (method) {
      case 'account/read': return { account: this.account }
      case 'model/list': return { data: [{ model: 'gpt-test', displayName: 'Test', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] }
      // Like the real app-server: a loaded conversation keeps its level and ignores resume's config; an unloaded one takes it from the config.
      case 'thread/start': { const id = `thread-${++this.nextThread}`; this.loaded.set(id, params.config?.model_reasoning_effort ?? null); return { thread: { id }, reasoningEffort: this.loaded.get(id) } }
      case 'thread/resume': { if (!this.loaded.has(params.threadId)) this.loaded.set(params.threadId, params.config?.model_reasoning_effort ?? null); return { thread: { id: params.threadId }, reasoningEffort: this.loaded.get(params.threadId) } }
      case 'thread/unsubscribe': this.loaded.delete(params.threadId); return { status: 'unsubscribed' }
      case 'turn/start': return { turn: { id: `turn-${++this.nextTurn}` } }
      default: return {}
    }
  }
  respond(id, result) { this.responses.push({ id, result }) }
  reject(id, error) { this.responses.push({ id, error }) }
  async stop() { this.emit('stopped', new Error('stopped')) }
  notify(method, params) { this.emit('notification', method, params) }
  complete(threadId, turnId, status = 'completed') { this.notify('turn/completed', { threadId, turn: { id: turnId, status, items: [] } }) }
}

async function waitFor(check) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fake Codex')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runner-'))
  const server = new FakeWorkServer()
  const runner = await new CodexRunner({ home: dir, attachmentsDir: dir, server, instructions: () => 'global instruction', stopTimeoutMs: 100, ...options }).load()
  t.after(async () => { await runner.shutdown(); await fs.rm(dir, { recursive: true, force: true }) })
  return { dir, server, runner }
}
async function start(runner, id, text = 'hello') {
  runner.run(id, text)
  await waitFor(() => runner.live.get(id)?.turnId)
  const live = runner.live.get(id)
  return { threadId: runner.get(id).sessionId, turnId: live.turnId }
}
async function finish(runner, server, id, ids, status = 'completed') {
  server.complete(ids.threadId, ids.turnId, status)
  await waitFor(() => !runner.running(id))
}

const inputQuestions = [
  { id: 'style', header: '方式', question: '方式を選択', isOther: true, isSecret: false, options: [{ label: 'A', description: '方式A' }, { label: 'B', description: '方式B' }] },
  { id: 'detail', header: '補足', question: '補足を入力', isOther: false, isSecret: true, options: null },
]

test('GP receives structured questions in read-only too and answers through RPC without persisting secrets', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir, permissionMode: 'read-only' })
  const ids = await start(runner, task.id)
  assert.equal(server.calls.find(call => call.method === 'thread/start').params.config['features.default_mode_request_user_input'], true)
  server.emit('request', { id: 77, method: 'item/tool/requestUserInput', params: { ...ids, questions: inputQuestions, isBlocking: true } })
  assert.equal(server.responses.length, 0)
  assert.equal(runner.get(task.id).pendingApproval, true)
  assert.deepEqual(runner.pendingPermissions(task.id), [{ requestId: '77', kind: 'user-input', title: 'Codex からの質問', questions: inputQuestions }])
  const handlers = createCodexHandlers({ codex: runner })
  const answers = { style: { answers: ['A'] }, detail: { answers: ['synthetic-secret'] } }
  assert.throws(() => runner.respondUserInput('other-task', '77', answers), /終了/)
  assert.throws(() => runner.respondPermission(task.id, '77', 'accept'), /回答/)
  for (const invalid of [null, [], { style: { answers: ['A'] } }, { ...answers, detail: { answers: [] } }, { ...answers, detail: { answers: [1] } }]) {
    assert.throws(() => runner.respondUserInput(task.id, '77', invalid), /回答/)
  }
  assert.equal(server.responses.length, 0)
  assert.deepEqual(handlers['codex.task.answer']({ taskId: task.id, requestId: '77', answers }), { accepted: true })
  assert.deepEqual(server.responses.at(-1), { id: 77, result: { answers } })
  assert.equal(runner.get(task.id).pendingApproval, false)
  assert.throws(() => runner.respondUserInput(task.id, '77', answers), /終了/)
  await finish(runner, server, task.id, ids)
  assert.ok(!(await fs.readFile(path.join(dir, 'codex-tasks', task.id + '.json'), 'utf8')).includes('synthetic-secret'))
})

test('GP questions support free text, skip, server resolution and interruption cleanup', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir })
  const ids = await start(runner, task.id)
  const ask = (id, questions = inputQuestions) => server.emit('request', { id, method: 'item/tool/requestUserInput', params: { ...ids, questions } })
  ask('free')
  const answers = { style: { answers: ['別の方式'] }, detail: { answers: ['補足'] } }
  runner.respondUserInput(task.id, 'free', answers)
  assert.deepEqual(server.responses.at(-1).result, { answers })
  ask('restricted', [{ ...inputQuestions[0], isOther: false }])
  assert.throws(() => runner.respondUserInput(task.id, 'restricted', { style: { answers: ['invalid'] } }), /回答/)
  runner.respondUserInput(task.id, 'restricted', {})
  assert.deepEqual(server.responses.at(-1), { id: 'restricted', result: { answers: {} } })
  ask('resolved')
  server.notify('serverRequest/resolved', { threadId: ids.threadId, requestId: 'resolved' })
  assert.equal(runner.pendingPermissions(task.id).length, 0)
  ask('interrupted')
  await finish(runner, server, task.id, ids, 'interrupted')
  assert.deepEqual(server.responses.at(-1), { id: 'interrupted', result: { answers: {} } })
  assert.equal(runner.pendingPermissions(task.id).length, 0)
})

test('unknown, stale and background-worker questions cannot create hidden waits', async t => {
  const { dir, server, runner } = await setup(t)
  for (const extra of [{ ab: { side: 'a' } }, { team: { childId: 'child' } }, {}]) {
    const task = await runner.create({ workspace: dir, ...extra })
    const ids = await start(runner, task.id)
    server.emit('request', { id: 'stale', method: 'item/tool/requestUserInput', params: { ...ids, turnId: extra.ab || extra.team ? ids.turnId : 'old-turn', questions: inputQuestions } })
    assert.deepEqual(server.responses.at(-1), { id: 'stale', result: { answers: {} } })
    assert.equal(runner.pendingPermissions(task.id).length, 0)
    if (extra.ab || extra.team) assert.equal(server.calls.filter(call => call.method === 'thread/start').at(-1).params.config['features.default_mode_request_user_input'], false)
    await finish(runner, server, task.id, ids)
  }
  server.emit('request', { id: 'unknown', method: 'item/tool/requestUserInput', params: { threadId: 'unknown', questions: inputQuestions } })
  assert.deepEqual(server.responses.at(-1), { id: 'unknown', result: { answers: {} } })
})

test('create and complete, strict selection, instructions and persistent thread resume', async t => {
  const { dir, server, runner } = await setup(t)
  await assert.rejects(runner.create({ workspace: dir, model: 'missing' }), /モデル/)
  await assert.rejects(runner.create({ workspace: dir, model: 'gpt-test', effort: 'max' }), /推論レベル/)
  const task = await runner.create({ workspace: dir, model: 'gpt-test', effort: 'high', instructions: 'task instruction', mcpServers: { test: { command: 'x' } } })
  const first = await start(runner, task.id)
  assert.equal(server.active, 1)
  const thread = server.calls.find(x => x.method === 'thread/start').params
  assert.equal(thread.model, 'gpt-test')
  assert.equal(thread.ephemeral, false)
  assert.equal(thread.developerInstructions, 'global instruction\n\ntask instruction')
  assert.deepEqual(thread.config.mcp_servers, { test: { command: 'x' } })
  // The chosen level is also the new conversation's level; a turn-only value applies weakly and made 'max' behave like medium to high.
  assert.equal(thread.config.model_reasoning_effort, 'high')
  const turn = server.calls.find(x => x.method === 'turn/start').params
  assert.equal(turn.effort, 'high')
  assert.equal(turn.model, 'gpt-test')
  server.notify('item/completed', { threadId: first.threadId, turnId: first.turnId, item: { id: 'answer', type: 'agentMessage', text: 'done' } })
  await finish(runner, server, task.id, first)
  assert.equal(runner.turns(task.id)[0].status, 'done')
  assert.equal(runner.turns(task.id)[0].items[0].text, 'done')
  const second = await start(runner, task.id, 'next')
  assert.equal(second.threadId, first.threadId)
  assert.equal(server.calls.filter(x => x.method === 'thread/start').length, 1)
  assert.equal(server.calls.find(x => x.method === 'thread/resume').params.threadId, first.threadId)
  await finish(runner, server, task.id, second)
})

test('a level changed after the conversation was created is applied to the conversation, not as a weak turn update', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir, model: 'gpt-test', effort: 'low' })
  await finish(runner, server, task.id, await start(runner, task.id))
  // Unchanged level: the loaded conversation is reused as is.
  await finish(runner, server, task.id, await start(runner, task.id))
  assert.equal(server.calls.filter(x => x.method === 'thread/unsubscribe').length, 0)
  for (const effort of ['high', 'low']) {
    await runner.update(task.id, { effort })
    const before = server.calls.length
    const ids = await start(runner, task.id)
    const sent = server.calls.slice(before).map(x => x.method)
    assert.deepEqual(sent.slice(sent.indexOf('thread/resume'), sent.indexOf('turn/start') + 1), ['thread/resume', 'thread/unsubscribe', 'thread/resume', 'turn/start'])
    assert.equal(server.loaded.get(ids.threadId), effort)
    assert.equal(server.calls.at(-1).params.effort, effort)
    await finish(runner, server, task.id, ids)
  }
  assert.equal(runner.turns(task.id).every(turn => turn.status === 'done'), true)
})

test('a level the conversation cannot take stops the turn instead of running at another level', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir, model: 'gpt-test', effort: 'low' })
  await finish(runner, server, task.id, await start(runner, task.id))
  await runner.update(task.id, { effort: 'high' })
  const raw = server.rawRequest.bind(server)
  server.rawRequest = async (method, params) => {
    const result = await raw(method, params)
    return method === 'thread/resume' ? { ...result, reasoningEffort: 'low' } : result
  }
  const before = server.calls.length
  runner.run(task.id, 'next')
  await waitFor(() => !runner.running(task.id))
  assert.match(runner.turns(task.id).at(-1).error?.message ?? runner.turns(task.id).at(-1).error, /推論レベル/)
  assert.equal(server.calls.slice(before).some(x => x.method === 'turn/start'), false)
})

test('steer sends one additional instruction and stop waits for completed interruption', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir })
  const ids = await start(runner, task.id)
  assert.equal(await runner.steer(task.id, 'extra'), true)
  const sent = server.calls.filter(x => x.method === 'turn/steer')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].params.expectedTurnId, ids.turnId)
  assert.equal(sent[0].params.input[0].text, 'extra')
  assert.equal(runner.turns(task.id)[0].items[0].text, 'extra')
  let stopped = false
  const stopping = runner.stop(task.id).then(() => { stopped = true })
  await waitFor(() => server.calls.some(x => x.method === 'turn/interrupt'))
  assert.equal(stopped, false)
  assert.equal(runner.running(task.id), true)
  server.complete(ids.threadId, ids.turnId, 'interrupted')
  await stopping
  assert.equal(runner.turns(task.id)[0].status, 'cancelled')
})

test('read-only and AB approval requests are declined; approvals belong to their task', async t => {
  const { dir, server, runner } = await setup(t)
  const ro = await runner.create({ workspace: dir, permissionMode: 'read-only' })
  const ab = await runner.create({ workspace: dir, ab: { side: 'a' } })
  const a = await runner.create({ workspace: dir })
  const b = await runner.create({ workspace: dir })
  const ids = await Promise.all([ro, ab, a, b].map(task => start(runner, task.id)))
  for (let i = 0; i < 4; i++) server.emit('request', { id: i + 1, method: 'item/commandExecution/requestApproval', params: { threadId: ids[i].threadId, turnId: ids[i].turnId, command: 'test' } })
  assert.deepEqual(server.responses.slice(0, 2), [{ id: 1, result: { decision: 'decline' } }, { id: 2, result: { decision: 'decline' } }])
  assert.equal(runner.pendingPermissions(a.id).length, 1)
  assert.throws(() => runner.respondPermission(b.id, '3', 'accept'), /承認/)
  runner.respondPermission(a.id, '3', 'decline')
  assert.deepEqual(server.responses.at(-1), { id: 3, result: { decision: 'decline' } })
  server.emit('request', { id: 9, method: 'unrecognized', params: { threadId: ids[2].threadId } })
  assert.equal(server.responses.at(-1).error.code, -32601)
  for (let i = 0; i < 4; i++) await finish(runner, server, [ro, ab, a, b][i].id, ids[i])
})

test('restart marks an in-flight persisted turn interrupted without resending it', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir })
  const ids = await start(runner, task.id)
  const server2 = new FakeWorkServer()
  const restored = await new CodexRunner({ home: dir, attachmentsDir: dir, server: server2 }).load()
  assert.equal(restored.get(task.id).status, 'stopped')
  assert.equal(restored.turns(task.id)[0].status, 'cancelled')
  assert.match(restored.turns(task.id)[0].error.message, /中断/)
  assert.equal(server2.calls.length, 0)
  const resumed = await start(restored, task.id, 'manual continuation')
  assert.equal(resumed.threadId, ids.threadId)
  assert.equal(server2.calls.filter(x => x.method === 'thread/start').length, 0)
  assert.equal(server2.calls.filter(x => x.method === 'turn/start').length, 1)
  await finish(restored, server2, task.id, resumed)
  await restored.shutdown()
  await finish(runner, server, task.id, ids)
})

test('thread notifications are isolated and total token usage is charged as per-turn delta', async t => {
  const { dir, server, runner } = await setup(t)
  const a = await runner.create({ workspace: dir })
  const b = await runner.create({ workspace: dir })
  const [first, other] = await Promise.all([start(runner, a.id), start(runner, b.id)])
  server.notify('item/agentMessage/delta', { threadId: first.threadId, turnId: first.turnId, itemId: 'a', delta: 'A' })
  server.notify('item/agentMessage/delta', { threadId: other.threadId, turnId: other.turnId, itemId: 'b', delta: 'B' })
  server.notify('thread/tokenUsage/updated', { threadId: first.threadId, turnId: first.turnId, tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, totalTokens: 110 }, modelContextWindow: 1000 } })
  await finish(runner, server, a.id, first)
  assert.deepEqual(runner.turns(a.id)[0].items.map(x => x.text), ['A'])
  assert.deepEqual(runner.turns(b.id)[0].items.map(x => x.text), ['B'])
  assert.equal(runner.turns(a.id)[0].usage.input, 80)
  const second = await start(runner, a.id, 'again')
  server.notify('thread/tokenUsage/updated', { threadId: second.threadId, turnId: second.turnId, tokenUsage: { total: { inputTokens: 160, cachedInputTokens: 30, outputTokens: 25, totalTokens: 185 }, modelContextWindow: 1000 } })
  await finish(runner, server, a.id, second)
  assert.equal(runner.turns(a.id)[1].usage.input, 50)
  assert.equal(runner.turns(a.id)[1].usage.cacheRead, 10)
  assert.equal(runner.turns(a.id)[1].usage.output, 15)
  await finish(runner, server, b.id, other)
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('transport stops with pending approval even when responding throws', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir })
  const ids = await start(runner, task.id)
  server.emit('request', { id: 17, method: 'item/commandExecution/requestApproval', params: { ...ids, command: 'cmd' } })
  assert.equal(runner.pendingPermissions(task.id).length, 1)
  const live = runner.live.get(task.id)
  server.child = null
  server.respond = () => { throw new Error('Codex transport closed') }
  server.emit('stopped', new Error('process exited'))
  await live.done.promise
  assert.equal(runner.running(task.id), false)
  assert.equal(runner.pendingPermissions(task.id).length, 0)
  assert.equal(runner.turns(task.id)[0].status, 'error')
})

test('stopped during initial save or thread start never starts a turn', async t => {
  for (const stage of ['save', 'thread/start']) {
    await t.test(stage, async t => {
      const { dir, server, runner } = await setup(t)
      const task = await runner.create({ workspace: dir })
      const gate = deferred(), entered = deferred(), executionEnded = deferred()
      t.after(() => gate.resolve())
      const use = server.use.bind(server)
      server.use = async fn => { try { return await use(fn) } finally { if (server.active === 0) executionEnded.resolve() } }
      if (stage === 'save') {
        const writer = runner.writers.get(task.id), flush = writer.flush.bind(writer)
        let first = true
        writer.flush = async () => {
          if (first) { first = false; entered.resolve(); await gate.promise }
          return flush()
        }
      } else {
        const raw = server.rawRequest.bind(server)
        server.rawRequest = async (method, params) => {
          const result = await raw(method, params)
          if (method === 'thread/start') { entered.resolve(); await gate.promise }
          return result
        }
      }
      runner.run(task.id, 'hello')
      await entered.promise
      const live = runner.live.get(task.id)
      server.emit('stopped', new Error('process exited'))
      await live.done.promise
      gate.resolve()
      await executionEnded.promise
      assert.equal(server.calls.filter(x => x.method === 'turn/start').length, 0)
      assert.equal(runner.turns(task.id)[0].status, 'error')
    })
  }
})

test('early completion retains live lock until turn/start response', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir })
  const gate = deferred(), entered = deferred()
  t.after(() => gate.resolve())
  const raw = server.rawRequest.bind(server)
  server.rawRequest = async (method, params) => {
    const result = await raw(method, params)
    if (method === 'turn/start') {
      server.complete(params.threadId, result.turn.id)
      entered.resolve()
      await gate.promise
    }
    return result
  }
  runner.run(task.id, 'first')
  await entered.promise
  assert.equal(runner.running(task.id), true)
  assert.throws(() => runner.run(task.id, 'duplicate'), /作業中/)
  assert.equal(runner.turns(task.id).length, 1)
  gate.resolve()
  await waitFor(() => !runner.running(task.id))
  assert.equal(runner.turns(task.id)[0].status, 'done')
  assert.equal(server.calls.filter(x => x.method === 'turn/start').length, 1)
})

test('missing usage invalidates baseline until the next observed total rebases', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir })
  const usage = (ids, input, output) => server.notify('thread/tokenUsage/updated', { threadId: ids.threadId, turnId: ids.turnId, tokenUsage: { total: { inputTokens: input, cachedInputTokens: 0, outputTokens: output, totalTokens: input + output } } })
  const a = await start(runner, task.id, 'one')
  usage(a, 100, 10)
  await finish(runner, server, task.id, a)
  const b = await start(runner, task.id, 'missing')
  await finish(runner, server, task.id, b)
  const c = await start(runner, task.id, 'rebase')
  usage(c, 300, 30)
  await finish(runner, server, task.id, c)
  assert.equal(runner.turns(task.id)[1].usage, undefined)
  assert.equal(runner.turns(task.id)[2].usage, undefined)
  const d = await start(runner, task.id, 'after rebase')
  usage(d, 350, 38)
  await finish(runner, server, task.id, d)
  assert.equal(runner.turns(task.id)[3].usage.input, 50)
  assert.equal(runner.turns(task.id)[3].usage.output, 8)
})

test('account identity is checked despite model cache and is hidden in summaries', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir })
  assert.equal('accountKey' in task, false)
  assert.equal('accountKey' in runner.get(task.id), false)
  assert.equal('accountKey' in runner.list()[0], false)
  const stored = JSON.parse(await fs.readFile(path.join(dir, 'codex-tasks', task.id + '.json'), 'utf8'))
  assert.match(stored.accountKey, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(stored).includes('a@example.test'))
  const listCount = server.calls.filter(x => x.method === 'model/list').length
  const reads = server.calls.filter(x => x.method === 'account/read').length
  await runner.models()
  assert.equal(server.calls.filter(x => x.method === 'account/read').length, reads + 1)
  assert.equal(server.calls.filter(x => x.method === 'model/list').length, listCount)
  const ids = await start(runner, task.id)
  await finish(runner, server, task.id, ids)
  for (const account of [
    { type: 'chatgpt', email: 'other@example.test', workspaceName: 'One' },
    { type: 'chatgpt', email: 'a@example.test', workspaceName: 'Two' },
  ]) {
    server.account = account
    const calls = server.calls.filter(x => x.method === 'thread/resume' || x.method === 'turn/start').length
    runner.run(task.id, 'must not resume')
    await waitFor(() => !runner.running(task.id))
    assert.match(runner.turns(task.id).at(-1).error.message, /サインイン先が変わりました/)
    assert.equal(server.calls.filter(x => x.method === 'thread/resume' || x.method === 'turn/start').length, calls)
  }
})

test('lean AB and research team restrict tools and network; other readonly modes retain network', async t => {
  for (const scenario of [
    { name: 'lean AB', ab: { writable: false, lean: true }, restricted: true },
    { name: 'research team', team: { executionMode: 'research' }, restricted: true },
    { name: 'non-lean AB', ab: { writable: false, lean: false }, restricted: false },
    { name: 'ordinary readonly', restricted: false },
  ]) {
    await t.test(scenario.name, async t => {
      const { dir, server, runner } = await setup(t)
      const task = await runner.create({ workspace: dir, permissionMode: 'read-only', ab: scenario.ab, team: scenario.team })
      const ids = await start(runner, task.id)
      const thread = server.calls.find(call => call.method === 'thread/start').params
      const turn = server.calls.find(call => call.method === 'turn/start').params
      assert.equal(turn.sandboxPolicy.type, 'readOnly')
      assert.equal(turn.sandboxPolicy.networkAccess, !scenario.restricted)
      if (scenario.restricted) {
        assert.equal(thread.config.web_search, 'disabled')
        assert.equal(thread.config['features.shell_tool'], false)
        assert.equal(thread.config['features.unified_exec'], false)
      } else {
        assert.equal(thread.config.web_search, 'cached')
        assert.equal(thread.config['features.shell_tool'], true)
        assert.equal(thread.config['features.unified_exec'], true)
      }
      await finish(runner, server, task.id, ids)
    })
  }
})

test('research team can resume the same thread with write configuration', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir, permissionMode: 'read-only', team: { executionMode: 'research' } })
  const first = await start(runner, task.id)
  const research = server.calls.find(call => call.method === 'thread/start').params
  assert.equal(research.config.web_search, 'disabled')
  assert.equal(research.config['features.shell_tool'], false)
  assert.equal(research.config['features.unified_exec'], false)
  assert.equal(server.calls.find(call => call.method === 'turn/start').params.sandboxPolicy.networkAccess, false)
  await finish(runner, server, task.id, first)
  await runner.configure(task.id, { permissionMode: 'workspace-write', team: { executionMode: 'write' } })
  const second = await start(runner, task.id, 'write')
  const resumed = server.calls.find(call => call.method === 'thread/resume').params
  const turn = server.calls.filter(call => call.method === 'turn/start').at(-1).params
  assert.equal(resumed.threadId, first.threadId)
  assert.equal(second.threadId, first.threadId)
  assert.equal(resumed.sandbox, 'workspace-write')
  assert.equal(resumed.config.web_search, 'cached')
  assert.equal(resumed.config['features.shell_tool'], true)
  assert.equal(resumed.config['features.unified_exec'], true)
  assert.equal(turn.sandboxPolicy.type, 'workspaceWrite')
  assert.equal(turn.sandboxPolicy.networkAccess, true)
  await finish(runner, server, task.id, second)
})

test('model reroute interrupts and reports error without attributing usage to the selected model', async t => {
  const { dir, server, runner } = await setup(t)
  const task = await runner.create({ workspace: dir, model: 'gpt-test', effort: 'low' })
  const ids = await start(runner, task.id)
  server.notify('thread/tokenUsage/updated', { ...ids, tokenUsage: { total: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } })
  server.notify('model/rerouted', { ...ids, fromModel: 'gpt-test', toModel: 'gpt-test', reason: 'test' })
  assert.equal(server.calls.filter(x => x.method === 'turn/interrupt').length, 0)
  server.notify('model/rerouted', { ...ids, fromModel: 'gpt-test', toModel: 'different-model', reason: 'test' })
  const interrupt = server.calls.filter(x => x.method === 'turn/interrupt')
  assert.equal(interrupt.length, 1)
  assert.deepEqual(interrupt[0].params, ids)
  const notice = runner.turns(task.id)[0].items.find(item => item.type === 'notice')
  assert.equal(notice.level, 'warning')
  assert.match(notice.text, /different-model/)
  await finish(runner, server, task.id, ids, 'interrupted')
  const turn = runner.turns(task.id)[0]
  assert.equal(turn.status, 'error')
  assert.match(turn.error.message, /different-model/)
  assert.equal(turn.usage, undefined)
  assert.equal(turn.totalScore.priced, 0)
  assert.equal(turn.totalScore.unpriced, 1)
})

test('model cache cannot return account A after account B list fails', async t => {
  const { server, runner } = await setup(t)
  const raw = server.rawRequest.bind(server)
  let failB = true
  server.rawRequest = async (method, params) => {
    const result = await raw(method, params)
    if (method !== 'model/list') return result
    if (server.account.email === 'b@example.test' && failB) throw new Error('model list failed')
    result.data[0].model = server.account.email === 'b@example.test' ? 'model-b' : 'model-a'
    return result
  }
  assert.equal((await runner.models())[0].id, 'model-a')
  server.account = { type: 'chatgpt', email: 'b@example.test', workspaceName: 'Two' }
  await assert.rejects(runner.models(), /model list failed/)
  failB = false
  assert.equal((await runner.models())[0].id, 'model-b')
  assert.equal(server.calls.filter(x => x.method === 'model/list').length, 3)
})

test('idle shutdown keeps the model list visible and still checks the account on reuse', async t => {
  const { server, runner } = await setup(t)
  const models = await runner.models()
  const events = []
  runner.on('models', list => events.push(list))
  server.emit('stopped', new Error('idle'), { idle: true })
  assert.deepEqual(runner.modelCache, models)
  assert.deepEqual(events, [])
  assert.deepEqual(await runner.models(), models)
  assert.equal(server.calls.filter(x => x.method === 'model/list').length, 1)
  server.account = null
  assert.deepEqual(await runner.models(), [])
  assert.deepEqual(runner.modelCache, [])
  assert.deepEqual(events, [[]])
})

test('stopped invalidates cached models and rejects a pending list from the old connection', async t => {
  const { server, runner } = await setup(t)
  await runner.models()
  await runner.models()
  assert.equal(server.calls.filter(x => x.method === 'model/list').length, 1)
  server.emit('stopped', new Error('connection lost'))
  await runner.models()
  assert.equal(server.calls.filter(x => x.method === 'model/list').length, 2)
  const gate = deferred(), entered = deferred()
  t.after(() => gate.resolve())
  const raw = server.rawRequest.bind(server)
  server.rawRequest = async (method, params) => {
    const result = await raw(method, params)
    if (method === 'model/list') { entered.resolve(); await gate.promise }
    return result
  }
  const pending = runner.models({ refresh: true })
  await entered.promise
  server.emit('stopped', new Error('connection lost again'))
  gate.resolve()
  await assert.rejects(pending, /接続状態が変わりました/)
  await runner.models()
  assert.equal(server.calls.filter(x => x.method === 'model/list').length, 4)
})

test('null account email never reuses cached models or resumes an unverifiable session', async t => {
  const { dir, server, runner } = await setup(t)
  server.account = { type: 'chatgpt', email: null, workspaceName: 'One' }
  await runner.models()
  await runner.models()
  assert.equal(server.calls.filter(x => x.method === 'model/list').length, 2)
  const task = await runner.create({ workspace: dir })
  const ids = await start(runner, task.id)
  await finish(runner, server, task.id, ids)
  const requests = server.calls.filter(x => x.method === 'turn/start').length
  runner.run(task.id, 'resume')
  await waitFor(() => !runner.running(task.id))
  assert.match(runner.turns(task.id).at(-1).error.message, /照合できません/)
  assert.equal(server.calls.filter(x => x.method === 'thread/resume').length, 0)
  assert.equal(server.calls.filter(x => x.method === 'turn/start').length, requests)
})

test('concurrent model selections retain the identity of their own returned list', async t => {
  const { dir, server, runner } = await setup(t)
  const gate = deferred(), entered = deferred()
  t.after(() => gate.resolve())
  const raw = server.rawRequest.bind(server)
  server.rawRequest = async (method, params) => {
    const email = server.account.email
    const result = await raw(method, params)
    if (method === 'model/list' && email === 'a@example.test') { entered.resolve(); await gate.promise }
    return result
  }
  const creatingA = runner.create({ workspace: dir })
  await entered.promise
  server.account = { type: 'chatgpt', email: 'b@example.test', workspaceName: 'Two' }
  const taskB = await runner.create({ workspace: dir })
  gate.resolve()
  const taskA = await creatingA
  const recordA = JSON.parse(await fs.readFile(path.join(dir, 'codex-tasks', taskA.id + '.json'), 'utf8'))
  const recordB = JSON.parse(await fs.readFile(path.join(dir, 'codex-tasks', taskB.id + '.json'), 'utf8'))
  const key = (email, workspace) => createHash('sha256').update(JSON.stringify([email, workspace])).digest('hex')
  assert.equal(recordA.accountKey, key('a@example.test', 'One'))
  assert.equal(recordB.accountKey, key('b@example.test', 'Two'))
  assert.equal('accountKey' in taskA, false)
  assert.equal('accountKey' in taskB, false)
})

const elicitation = (ids, serverName, kind = 'mcp_tool_call') => ({ ...ids, serverName, mode: 'form', _meta: { codex_approval_kind: kind, tool_name: 'subagent' } })

test('the subagent bridge tool is approved without asking; other MCP requests are still refused', async t => {
  const { dir, server, runner } = await setup(t, { trustedMcp: ['agent-desk-subagent'] })
  const task = await runner.create({ workspace: dir })
  const ids = await start(runner, task.id)
  server.emit('request', { id: 1, method: 'mcpServer/elicitation/request', params: elicitation(ids, 'agent-desk-subagent') })
  assert.deepEqual(server.responses.at(-1), { id: 1, result: { action: 'accept' } })
  assert.equal(runner.pendingPermissions(task.id).length, 0)
  // Another server, or something other than a tool call approval, is not ours to accept.
  server.emit('request', { id: 2, method: 'mcpServer/elicitation/request', params: elicitation(ids, 'imagegen') })
  assert.equal(server.responses.at(-1).id, 2)
  assert.equal(server.responses.at(-1).error.code, -32601)
  server.emit('request', { id: 3, method: 'mcpServer/elicitation/request', params: elicitation(ids, 'agent-desk-subagent', 'other') })
  assert.equal(server.responses.at(-1).error.code, -32601)
  await finish(runner, server, task.id, ids)
  // Without the server being trusted (a runner built without the bridge) nothing is accepted.
  const plain = await setup(t)
  const other = await plain.runner.create({ workspace: dir })
  const otherIds = await start(plain.runner, other.id)
  plain.server.emit('request', { id: 4, method: 'mcpServer/elicitation/request', params: elicitation(otherIds, 'agent-desk-subagent') })
  assert.equal(plain.server.responses.at(-1).error.code, -32601)
})

test('a bridged subagent session is hidden from the task list, cannot ask the user, and cannot approve its own tools', async t => {
  const { dir, server, runner } = await setup(t, { trustedMcp: ['agent-desk-subagent'] })
  const child = await runner.create({ workspace: dir, permissionMode: 'workspace-write', permissionPolicy: 'deny', mcpServers: {}, subagent: { parent: 'cl:abc' } })
  assert.deepEqual(runner.list().map(task => task.id), [])
  assert.deepEqual(runner.list({ includeOwned: true }).map(task => [task.id, task.subagent]), [[child.id, { parent: 'cl:abc' }]])
  const ids = await start(runner, child.id)
  const start_ = server.calls.find(call => call.method === 'thread/start')
  assert.equal(start_.params.config['features.default_mode_request_user_input'], false)
  assert.deepEqual(start_.params.config.mcp_servers, {})
  server.emit('request', { id: 5, method: 'item/tool/requestUserInput', params: { ...ids, questions: inputQuestions, isBlocking: true } })
  assert.deepEqual(server.responses.at(-1), { id: 5, result: { answers: {} } })
  server.emit('request', { id: 6, method: 'mcpServer/elicitation/request', params: elicitation(ids, 'agent-desk-subagent') })
  assert.equal(server.responses.at(-1).error.code, -32601)
  server.emit('request', { id: 7, method: 'item/commandExecution/requestApproval', params: { ...ids, command: 'rm -r x' } })
  assert.deepEqual(server.responses.at(-1), { id: 7, result: { decision: 'decline' } })
  assert.equal(runner.pendingPermissions(child.id).length, 0)
  await finish(runner, server, child.id, ids)
})

test('a task that mounts the subagent bridge is told to use it, and no other task gets that text', async t => {
  const { dir, server, runner } = await setup(t, { mcpGuidance: { 'agent-desk-subagent': 'use the bridge tool' } })
  const bridged = await runner.create({ workspace: dir, instructions: 'task instruction', mcpServers: { 'agent-desk-subagent': { command: 'x' } } })
  const first = await start(runner, bridged.id)
  assert.equal(server.calls.find(call => call.method === 'thread/start').params.developerInstructions, 'global instruction\n\ntask instruction\n\nuse the bridge tool')
  await finish(runner, server, bridged.id, first)
  // A conversation resumed later is told again: the instructions are not stored with it.
  const second = await start(runner, bridged.id)
  assert.match(server.calls.find(call => call.method === 'thread/resume').params.developerInstructions, /use the bridge tool$/)
  await finish(runner, server, bridged.id, second)
  const plain = await runner.create({ workspace: dir, mcpServers: { other: { command: 'x' } } })
  await start(runner, plain.id)
  assert.equal(server.calls.filter(call => call.method === 'thread/start').at(-1).params.developerInstructions, 'global instruction')
})
