// Real ACP + bundled PTC runtime; deterministic local responses, no provider API.
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import YAML from 'yaml'
import ts from 'typescript'
import { AcpRuntime, RuntimePool } from '../server/runtime.js'
import { TeamManager } from '../server/teams.js'
import { ThreadManager } from '../server/threads.js'
import { appPaths } from '../server/paths.js'
import { WEB_SEARCH_PLUGIN, abPatch, chatWebPatch, homePatch, shippedPersona, teamChildPatch } from '../server/dsh-config.js'
import { localRoute } from '../server/local-llm.js'
import { TOOL_MODE_CONFIG, toolModeOption } from '../server/ptc.js'
import { PLAN_INSTRUCTION } from '../server/thread-utils.js'

async function setup(t, mode, profile) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-ptc-'))
  const paths = appPaths(home)
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true })
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'input.txt'), 'PTC fixture content')
  const requests = [], queue = [], updates = []
  let call = 0
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push(JSON.parse(raw))
    const planned = queue.shift()
    const next = typeof planned === 'function' ? await planned(requests.at(-1)) : planned
    const base = { id: `reply-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: 'ptc-fixture' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (next) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${++call}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] })
      send({}, 'tool_calls')
    } else {
      send({ role: 'assistant', content: 'fixture done' })
      send({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const subagents = profile ? [{ provider: 'openai-codex', model: 'gpt-6.1-sol' }] : []
  const persona = await shippedPersona()
  const rows = YAML.parse(homePatch({ localRoute: localRoute({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'ptc-fixture' }] }), subagentsEnabled: Boolean(profile), subagents, persona,
    // As in production (server/index.js). Without it dsh falls back to DeepSeek's search, which
    // 0.2.2 hides on a route it cannot authenticate for, such as this local model.
    webSearch: { plugin: WEB_SEARCH_PLUGIN, credentials: paths.credentials } }))
  rows.find((row) => row.id === 'acp').config = { provider: 'local-llm', model: 'ptc-fixture' }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  const patches = []
  if (profile) {
    const file = path.join(home, 'role.patch.yml')
    await fs.writeFile(file, profile === 'chat-web' ? chatWebPatch() : profile.startsWith('team') ? teamChildPatch({ subagents, persona }) : abPatch({ subagents, persona, writable: profile === 'ab-write', lean: profile !== 'ab-research' }))
    patches.push(file)
  }
  const permissions = []
  const runtime = new AcpRuntime({ mode, paths, patches, onUpdate: (_id, update) => updates.push(update), onPermission: async (request) => {
    permissions.push(request)
    return { outcome: { outcome: 'cancelled' } }
  } })
  const runtimes = [runtime], cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup()
    for (const entry of runtimes) await entry.stop()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.equal(path.dirname(home), os.tmpdir())
    await fs.rm(home, { recursive: true, force: true })
  })
  await runtime.start()
  const session = await runtime.newSession(workspace)
  const prompt = () => runtime.prompt(session.sessionId, [{ type: 'text', text: 'fixture request' }])
  const run = async (code, extra = {}) => {
    const from = updates.length
    queue.push({ name: 'run_code', args: { code, description: 'Run deterministic local PTC fixture', ...extra } })
    const result = await prompt()
    assert.equal(result.stopReason, 'end_turn')
    return updates.slice(from)
  }
  return { runtime, session, prompt, run, requests, updates, permissions, workspace, home, queue, paths, patches, runtimes, cleanups }
}

test('web-only ACP sends only search and fetch tools with a short prompt', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'read-only', 'chat-web')
  await f.prompt()
  const request = f.requests.at(-1)
  assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ['web_fetch', 'web_search'])
  const system = request.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
  assert.ok(system.length < 6000, 'system prompt should stay small')
})

test('chat-web thread overrides saved PTC selection and sends only web tools', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'read-only', 'chat-web')
  const pool = Object.assign(new EventEmitter(), {
    get: () => f.runtime.start(), holderOf: (id) => f.runtime.liveSessions.has(id) ? f.runtime : null, status: () => ({}),
  })
  const threads = new ThreadManager({ paths: f.paths, pool, catalog: { learn: () => false },
    getAccounts: async () => ({ localLlm: { configured: true } }), getTurnUsage: async () => null })
  f.cleanups.push(() => threads.shutdown())
  f.runtime.onUpdate = (id, update) => threads.onUpdate(id, update)
  const thread = await threads.create({ workspace: f.workspace, model: '["local-llm","ptc-fixture"]', permissionMode: 'chat-web', toolMode: 'ptc' })
  await threads.send(thread.id, { text: 'hello' }, { userInitiated: true })
  await threads.active.get(thread.id).done
  assert.deepEqual(f.requests.at(-1).tools.map((tool) => tool.function.name).sort(), ['web_fetch', 'web_search'])
  const { turns } = await threads.get(thread.id)
  assert.equal(turns.at(-1).status, 'done')
})

test('real ACP reports the actual model used for fallback decisions', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'danger-full-access')
  const pool = Object.assign(new EventEmitter(), {
    get: () => f.runtime.start(), holderOf: (id) => f.runtime.liveSessions.has(id) ? f.runtime : null, status: () => ({}),
  })
  const threads = new ThreadManager({ paths: f.paths, pool, catalog: { learn: () => false },
    getAccounts: async () => ({ localLlm: { configured: true } }), getTurnUsage: async () => null })
  f.cleanups.push(() => threads.shutdown())
  f.runtime.onUpdate = (id, update) => threads.onUpdate(id, update)
  const model = '["local-llm","ptc-fixture"]'
  const thread = await threads.create({ workspace: f.workspace, model, permissionMode: 'danger-full-access', toolMode: 'native' })
  await threads.send(thread.id, { text: 'fixture request' }, { userInitiated: true })
  await threads.active.get(thread.id).done
  const { turns } = await threads.get(thread.id)
  assert.equal(turns[0].status, 'done')
  assert.equal(turns[0].executedModel, model)
})

for (const toolMode of ['native', 'ptc']) {
  test(`a child report admitted during runtime recycling resumes the leader once (${toolMode})`, { timeout: 120_000 }, async (t) => {
    const f = await setup(t, 'danger-full-access')
    const pool = Object.assign(new EventEmitter(), {
      get: () => f.runtime.start(),
      holderOf: (id) => f.runtime.liveSessions.has(id) ? f.runtime : null,
      status: () => ({}),
    })
    f.runtime.on('exit', (info) => pool.emit('exit', { key: 'danger-full-access', ...info }))
    const threads = new ThreadManager({ paths: f.paths, pool, catalog: { learn: () => false },
      getAccounts: async () => ({ localLlm: { configured: true } }), getTurnUsage: async () => null })
    f.cleanups.push(() => threads.shutdown())
    const collect = f.runtime.onUpdate
    f.runtime.onUpdate = (id, update) => { collect(id, update); threads.onUpdate(id, update) }
    // Same scheduling gate and admission path as a parked GPT team leader.
    threads.teamGoalWaiting = () => true
    const leader = await threads.create({ workspace: f.workspace, model: '["local-llm","ptc-fixture"]', permissionMode: 'danger-full-access', toolMode,
      team: { id: 'recycle-fixture', role: 'leader' } })
    await threads.send(leader.id, { text: 'leader-context-before-delegation' })
    await threads.active.get(leader.id).done
    const sessionId = threads.threads.get(leader.id).sessionId
    const child = f.runtime.child
    const before = f.requests.length
    // #pumpThread queues send before the last child's turn-finished listener
    // applies a deferred model/settings restart. Admission itself is async.
    const delivery = threads.send(leader.id, { text: '[Agent Desk チーム] child-report-after-delegation' })
    const recycled = f.runtime.stop()
    await delivery
    await threads.active.get(leader.id).done
    await recycled
    const view = await threads.get(leader.id)
    assert.deepEqual(view.turns.map((turn) => turn.status), ['done', 'done'], JSON.stringify(view.turns.at(-1).error))
    assert.equal(view.thread.sessionId, sessionId, 'resume full history, not a new carryover conversation')
    assert.equal(f.requests.length, before + 1, 'no report replay or duplicate model request')
    assert.match(JSON.stringify(f.requests.at(-1).messages), /leader-context-before-delegation/)
    assert.match(JSON.stringify(f.requests.at(-1).messages), /child-report-after-delegation/)
    assert.notEqual(f.runtime.child, child)
    assert.equal(f.runtime.state, 'ready')
  })
}

for (const toolMode of ['native', 'ptc']) {
  test(`team delivery and a deferred pool recycle preserve the leader's history (${toolMode})`, { timeout: 120_000 }, async (t) => {
    const f = await setup(t, 'danger-full-access')
    const pool = new RuntimePool({ paths: f.paths, onUpdate() {}, onPermission: async () => ({}) })
    pool.runtimes.set('danger-full-access', f.runtime)
    f.runtime.on('exit', (info) => pool.emit('exit', { key: 'danger-full-access', ...info }))
    // Route the GPT leader through the deterministic local model, not a provider API.
    const model = '["local-llm","ptc-fixture"]'
    const catalog = { learn: () => false, data: { models: [{ provider: 'openai-codex', id: 'ptc-fixture', value: model, name: 'Fixture' }] } }
    let teams
    const threads = new ThreadManager({ paths: f.paths, pool, catalog,
      getAccounts: async () => ({ localLlm: { configured: true } }), getTurnUsage: async () => null,
      getMcpServers: (thread) => { const server = teams.mcpServerFor(thread); return server ? [server] : [] } })
    const terminals = Object.assign(new EventEmitter(), { status: () => null })
    const agents = Object.assign(new EventEmitter(), { get: () => null, running: () => false })
    teams = new TeamManager({ file: path.join(f.home, 'teams.json'), dir: path.join(f.home, 'teams'),
      threads, terminals, agents, catalog, getSettings: () => ({ leaderProvider: 'gpt', toolMode,
        gptLeader: { model: 'ptc-fixture', effort: null }, gpt: { enabled: true } }),
      apiUrl: () => '', gatherMs: 0 })
    f.cleanups.push(() => threads.shutdown(), () => teams.stop(), () => pool.pause())
    const collect = f.runtime.onUpdate
    f.runtime.onUpdate = (id, update) => { collect(id, update); threads.onUpdate(id, update) }
    const { team: view, thread: leader } = await teams.create({ workspace: f.workspace })
    const team = teams.teams.get(view.id)
    await threads.send(leader.id, { text: 'leader-context-before-delegation' })
    await threads.active.get(leader.id).done
    if (toolMode === 'native') {
      const spawn = f.requests[0].tools.find((tool) => tool.function?.name.endsWith('spawn'))
      assert.ok(spawn, 'the actual team MCP spawn tool is available')
      assert.deepEqual(spawn.function.parameters.properties.effort.type, ['string', 'null'])
    }
    const sessionId = threads.threads.get(leader.id).sessionId
    const childThread = await threads.create({ workspace: f.workspace, model, permissionMode: 'danger-full-access',
      team: { id: team.id, childId: 'fixture-child' } })
    const child = { id: 'fixture-child', taskId: childThread.id, kind: 'thread', name: 'Worker', title: 'Fixture',
      provider: 'gpt', tier: 'low', model: 'ptc-fixture', closed: false, awaiting: true, pending: [], followups: [], reports: [],
      createdAt: Date.now(), updatedAt: Date.now() }
    team.children.push(child)
    // Simulate the child's completed turn; report delivery itself uses the real managers.
    threads.turns.set(childThread.id, [{ items: [{ type: 'agent', text: 'actual-child-report-after-delegation' }] }])
    const oldProcess = f.runtime.child
    const before = f.requests.length
    const leaderFinished = Promise.withResolvers()
    let stopped
    // TeamManager runs first and queues delivery. The next listener has the
    // same idle check and deferred-restart ordering as the application.
    threads.on('turn-finished', ({ threadId, status }) => {
      if (threadId === childThread.id) {
        assert.equal(threads.busy, false)
        stopped = pool.stopAll()
      } else if (threadId === leader.id) leaderFinished.resolve(status)
    })
    threads.emit('turn-finished', { threadId: childThread.id, status: 'done' })
    assert.ok(stopped)
    assert.equal(await leaderFinished.promise, 'done')
    await stopped
    const result = await threads.get(leader.id)
    assert.deepEqual(result.turns.map((turn) => turn.status), ['done', 'done'])
    assert.equal(result.thread.sessionId, sessionId)
    assert.equal(child.reports.length, 1)
    assert.equal(team.queue.length, 0)
    assert.equal(teams.summary(team).delivery, 'idle')
    assert.equal(f.requests.length, before + 1)
    assert.match(JSON.stringify(f.requests.at(-1).messages), /leader-context-before-delegation/)
    assert.match(JSON.stringify(f.requests.at(-1).messages), /actual-child-report-after-delegation/)
    assert.notEqual(f.runtime.child, oldProcess)
  })
}

for (const toolMode of ['native', 'ptc']) {
  test(`research → implementation preserves real ACP history and changes only that child's policy (${toolMode})`, { timeout: 120_000 }, async (t) => {
    const f = await setup(t, 'read-only', 'team-read')
    await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, toolMode)
    f.queue.push({ name: toolMode === 'ptc' ? 'run_code' : 'read', args: toolMode === 'ptc'
      ? { description: 'Read investigation evidence', code: 'return await tools.read({ file_path: "input.txt" });' }
      : { file_path: 'input.txt' } })
    await f.runtime.prompt(f.session.sessionId, [{ type: 'text', text: 'investigation-context-to-preserve' }])
    const write = (file, content) => f.queue.push({ name: toolMode === 'ptc' ? 'run_code' : 'write', args: toolMode === 'ptc'
      ? { description: 'Write scoped implementation', code: `return await tools.write({ file_path: ${JSON.stringify(file)}, content: ${JSON.stringify(content)} });` }
      : { file_path: file, content } })
    write('blocked.txt', 'must not write during research')
    await f.prompt()
    await assert.rejects(fs.stat(path.join(f.workspace, 'blocked.txt')), { code: 'ENOENT' })
    const writer = new AcpRuntime({ mode: 'danger-full-access', paths: f.paths, patches: f.patches,
      onUpdate: (_id, update) => f.updates.push(update), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    f.runtimes.push(writer)
    await writer.start()
    await f.runtime.closeSession(f.session.sessionId)
    await writer.resumeSession(f.session.sessionId, f.workspace)
    await writer.setOption(f.session.sessionId, TOOL_MODE_CONFIG, toolMode)
    const from = f.requests.length
    write('implementation.txt', 'same child implementation')
    await writer.prompt(f.session.sessionId, [{ type: 'text', text: 'implement using the investigation' }])
    assert.equal(await fs.readFile(path.join(f.workspace, 'implementation.txt'), 'utf8'), 'same child implementation')
    const input = JSON.stringify(f.requests[from].messages)
    assert.match(input, /investigation-context-to-preserve/)
    assert.match(input, /PTC fixture content/, 'actual tool results survive, not only the final research report')
    assert.match(input, /Current DSH file policy: danger-full-access/)
    assert.doesNotMatch(input, /This child session runs in read-only mode, independently/)
    await writer.stop()
    await writer.start()
    await writer.resumeSession(f.session.sessionId, f.workspace)
    await writer.setOption(f.session.sessionId, TOOL_MODE_CONFIG, toolMode)
    write('after-restart.txt', 'implementation survives restart')
    await writer.prompt(f.session.sessionId, [{ type: 'text', text: 'continue implementation after restart' }])
    assert.equal(await fs.readFile(path.join(f.workspace, 'after-restart.txt'), 'utf8'), 'implementation survives restart')
    const sibling = await f.runtime.newSession(f.workspace)
    await f.runtime.setOption(sibling.sessionId, TOOL_MODE_CONFIG, toolMode)
    write('sibling-blocked.txt', 'must remain read-only')
    await f.runtime.prompt(sibling.sessionId, [{ type: 'text', text: 'sibling research is still read-only' }])
    await assert.rejects(fs.stat(path.join(f.workspace, 'sibling-blocked.txt')), { code: 'ENOENT' })
    assert.equal(f.permissions.length, 0, 'no escalation prompt is used')
  })
}


for (const toolMode of ['native', 'ptc']) {
  test('explicit /goal is registered before the model, parks, resumes, completes and survives restart (' + toolMode + ')', { timeout: 120_000 }, async (t) => {
    const f = await setup(t, 'danger-full-access')
    const id = f.session.sessionId
    assert.equal(f.runtime.goalCommandSupported, true, 'ACP initialization attests the command hook')
    await f.runtime.setOption(id, TOOL_MODE_CONFIG, toolMode)
    await f.runtime.setGoalWaiting(id, true)
    const tool = (name, args) => ({ name: toolMode === 'ptc' ? 'run_code' : name, args: toolMode === 'ptc'
      ? { code: 'return await tools.' + name + '(' + JSON.stringify(args) + ');', description: 'Inspect explicit goal fixture' } : args })
    f.queue.push(tool('get_goal', {}))
    const objective = 'Finish explicit goal fixture without widening its scope'
    await f.runtime.prompt(id, [{ type: 'text', text: '/GOAL ' + objective }], objective)
    assert.equal(f.requests.length, 2, 'no create_goal tool call and no polling rounds')
    const output = JSON.stringify(f.requests.at(-1).messages.filter((entry) => entry.role === 'tool').at(-1).content)
    assert.match(output, /Finish explicit goal fixture/)
    assert.match(output, /armed/)
    assert.match(output, /roundsStarted[\s\S]{0,10}0/)
    const goalId = output.match(/goal-[a-z0-9-]+/)[0]
    const before = f.requests.length
    await assert.rejects(f.runtime.prompt(id, [{ type: 'text', text: '/goal replacement' }], 'replacement'), /既存の目標/)
    assert.equal(f.requests.length, before, 'a conflicting goal never reaches the model')
    await f.runtime.stop()
    await f.runtime.start()
    await f.runtime.resumeSession(id, f.workspace)
    await f.runtime.setOption(id, TOOL_MODE_CONFIG, toolMode)
    f.queue.push(tool('get_goal', {}))
    await f.runtime.prompt(id, [{ type: 'text', text: 'Read the persisted goal after restart without resuming it' }])
    const restored = JSON.stringify(f.requests.at(-1).messages.filter((entry) => entry.role === 'tool').at(-1).content)
    assert.match(restored, new RegExp(goalId))
    assert.match(restored, /disarmed/)
    // Resume in a direct human turn, then let the real autonomous round finish.
    f.queue.push(tool('update_goal', { goal_id: goalId, revision: 1, action: 'resume' }), undefined,
      tool('update_goal', { goal_id: goalId, revision: 2, action: 'complete' }))
    const from = f.requests.length
    await f.runtime.prompt(id, [{ type: 'text', text: 'Resume the same goal and finish it in the next round' }])
    assert.equal(f.requests.length, from + 4)
    assert.match(JSON.stringify(f.requests.at(-1).messages), /goal_round/)
    // A completed goal can be followed by a new explicit goal, and stop disarms it.
    await f.runtime.setGoalWaiting(id, true)
    f.queue.push(tool('get_goal', {}))
    await f.runtime.prompt(id, [{ type: 'text', text: '/goal next objective' }], 'next objective')
    const next = JSON.stringify(f.requests.at(-1).messages.filter((entry) => entry.role === 'tool').at(-1).content)
    assert.match(next, /next objective/)
    assert.equal(next.includes(goalId), false)
    await f.runtime.cancel(id)
    await f.runtime.setGoalWaiting(id, false)
    f.queue.push(tool('get_goal', {}))
    const stopped = f.requests.length
    await f.prompt()
    assert.equal(f.requests.length, stopped + 2)
    assert.match(JSON.stringify(f.requests.at(-1).messages.filter((entry) => entry.role === 'tool').at(-1).content), /disarmed/)
  })
}

for (const toolMode of ['native', 'ptc']) {
  test('team child retains a saved goal without autonomous rounds and accepts another request (' + toolMode + ')', { timeout: 120_000 }, async (t) => {
    const f = await setup(t, 'danger-full-access')
    const id = f.session.sessionId
    const objective = 'Previously saved child goal'
    await f.runtime.setGoalWaiting(id, true)
    await f.runtime.prompt(id, [{ type: 'text', text: 'Create the previous goal' }], objective)
    assert.equal(f.requests.length, 1)
    await f.runtime.stop()

    // Reopen a real persisted goal under the new child role, as after an app restart.
    const role = path.join(f.home, 'child-goal.patch.yml')
    await fs.writeFile(role, teamChildPatch())
    const child = new AcpRuntime({ mode: 'danger-full-access', paths: f.paths, patches: [role],
      onUpdate: (_id, update) => f.updates.push(update), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    f.runtimes.push(child)
    await child.start()
    await child.resumeSession(id, f.workspace)
    await child.setOption(id, TOOL_MODE_CONFIG, toolMode)
    if (toolMode === 'ptc') f.queue.push({ name: 'run_code', args: {
      description: 'Inspect child goal tools',
      code: 'return { create: typeof tools.create_goal, update: typeof tools.update_goal, get: typeof tools.get_goal };',
    } })
    const before = f.requests.length
    assert.equal((await child.prompt(id, [{ type: 'text', text: 'Browser is unavailable; report the blocker' }])).stopReason, 'end_turn')
    assert.equal(f.requests.length, before + (toolMode === 'ptc' ? 2 : 1))
    const request = f.requests.at(-1)
    if (toolMode === 'ptc') {
      const result = JSON.stringify(request.messages.filter((entry) => entry.role === 'tool').at(-1).content)
      assert.match(result, /create[^}]*undefined/)
      assert.match(result, /update[^}]*undefined/)
      assert.match(result, /get[^}]*undefined/)
    } else {
      const names = request.tools.map((entry) => entry.function.name)
      for (const name of ['create_goal', 'update_goal', 'get_goal']) assert.ok(!names.includes(name), name)
    }
    const reassigned = f.requests.length
    assert.equal((await child.prompt(id, [{ type: 'text', text: 'Browser is available; perform the measurement' }])).stopReason, 'end_turn')
    assert.equal(f.requests.length, reassigned + 1, 'only the explicit reassignment runs')
    await child.stop()

    // The old goal and conversation remain available; no goal round was admitted.
    await f.runtime.start()
    await f.runtime.resumeSession(id, f.workspace)
    f.queue.push({ name: 'get_goal', args: {} })
    const inspection = f.requests.length
    await f.runtime.prompt(id, [{ type: 'text', text: 'Inspect the saved goal' }])
    assert.equal(f.requests.length, inspection + 2)
    const latest = f.requests.at(-1)
    const goal = JSON.stringify(latest.messages.filter((entry) => entry.role === 'tool').at(-1).content)
    assert.match(goal, /Previously saved child goal/)
    assert.match(goal, /phase[\s\S]{0,20}active/)
    assert.match(goal, /activation[\s\S]{0,20}disarmed/)
    assert.match(goal, /roundsStarted[\s\S]{0,10}0/)
    assert.match(JSON.stringify(latest.messages), /Browser is unavailable/)
    assert.match(JSON.stringify(latest.messages), /Browser is available/)
  })
}

for (const toolMode of ['native', 'ptc']) {
  test('real team goal wait makes no automatic calls and accepts reports and user prompts (' + toolMode + ')', { timeout: 120_000 }, async (t) => {
    const f = await setup(t, 'danger-full-access')
    await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, toolMode)
    const tool = (name, args) => ({ name: toolMode === 'ptc' ? 'run_code' : name, args: toolMode === 'ptc'
      ? { code: 'return await tools.' + name + '(' + JSON.stringify(args) + ');', description: 'Exercise team goal scheduling' } : args })
    f.queue.push(tool('create_goal', { objective: 'Finish local fixture work after its child reports', max_goal_rounds: 3 }))
    // Simulate the server setting the wait before a delegated tool returns, while the parent is active.
    f.queue.push(async () => { await f.runtime.setGoalWaiting(f.session.sessionId, true) })
    assert.equal((await f.prompt()).stopReason, 'end_turn')
    assert.equal(f.requests.length, 2, 'no goal round after the parent says it is waiting')
    for (const message of ['User asks how it is going', 'Child report arrived while another child still works']) {
      f.queue.push(tool('get_goal', {}))
      const before = f.requests.length
      await f.runtime.prompt(f.session.sessionId, [{ type: 'text', text: message }])
      assert.equal(f.requests.length, before + 2, 'one explicit prompt only, not polling rounds')
      const outputs = f.requests.at(-1).messages.filter((entry) => entry.role === 'tool').map((entry) => typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content))
      const latest = outputs.at(-1)
      assert.match(latest, /phase[\s\S]{0,20}active/)
      assert.match(latest, /activation[\s\S]{0,20}armed/)
      assert.match(latest, /roundsStarted[\s\S]{0,10}0/)
    }
    const output = f.requests.at(-1).messages.filter((entry) => entry.role === 'tool').at(-1).content
    const goalId = JSON.stringify(output).match(/goal-[a-z0-9-]+/)[0]
    f.queue.push(tool('update_goal', { goal_id: goalId, revision: 1, action: 'complete' }))
    await f.runtime.setGoalWaiting(f.session.sessionId, false)
    const before = f.requests.length
    await f.runtime.prompt(f.session.sessionId, [{ type: 'text', text: 'All children reported; review their results and complete the goal' }])
    assert.equal(f.requests.length, before + 2)
    // Another session in the very same process must retain ordinary autonomous goal rounds.
    const sibling = await f.runtime.newSession(f.workspace)
    f.queue.push({ name: 'create_goal', args: { objective: 'Continue ordinary work without an eco wait', max_goal_rounds: 1 } })
    const from = f.requests.length
    await f.runtime.prompt(sibling.sessionId, [{ type: 'text', text: 'Create the goal and keep working until its round limit' }])
    assert.equal(f.requests.length, from + 3)
    assert.match(JSON.stringify(f.requests.at(-1).messages), /goal_round/)
  })
}


for (const toolMode of ['native', 'ptc']) {
  test('real answered-question steering releases only the accepted turn gate (' + toolMode + ')', { timeout: 120_000 }, async (t) => {
    const f = await setup(t, 'danger-full-access')
    await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, toolMode)
    await f.runtime.setGoalWaiting(f.session.sessionId, true)
    const args = { objective: 'Perform independent work after the human answers', max_goal_rounds: 1 }
    f.queue.push({ name: toolMode === 'ptc' ? 'run_code' : 'create_goal', args: toolMode === 'ptc'
      ? { description: 'Create a waiting goal', code: 'return await tools.create_goal(' + JSON.stringify(args) + ');' } : args })
    let entered, release
    const started = new Promise((resolve) => { entered = resolve })
    const ready = new Promise((resolve) => { release = resolve })
    f.queue.push(async () => { entered(); await ready })
    const prompt = f.prompt()
    await started
    const accepted = await f.runtime.steer(f.session.sessionId, [{ type: 'text', text: 'human-answer-for-atomic-admission' }], false)
    assert.equal(accepted, true)
    assert.equal(f.runtime.waitingSessions.has(f.session.sessionId), false)
    release()
    assert.equal((await prompt).stopReason, 'end_turn')
    assert.match(JSON.stringify(f.requests.at(-1).messages), /human-answer-for-atomic-admission/)
    assert.match(JSON.stringify(f.requests.at(-1).messages), /goal_round/, 'independent goal work continues, instead of getting stuck behind the old question')
    assert.ok(f.requests.length <= 5, 'the one-round budget is not reset by steering')
  })
}

test('a late steer into an idle parent cannot start an orphan model turn or clear its wait', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'danger-full-access')
  await f.runtime.setGoalWaiting(f.session.sessionId, true)
  await f.prompt()
  const before = f.requests.length
  await assert.rejects(f.runtime.steer(f.session.sessionId, [{ type: 'text', text: 'must not be admitted as a normal prompt' }], false), /steer-unavailable/)
  assert.equal(f.requests.length, before)
  assert.equal(f.runtime.waitingSessions.has(f.session.sessionId), true)
  await f.prompt()
  assert.equal(f.requests.length, before + 1, 'an explicit prompt is still admissible')
})

test('cancelling a parked parent disarms its goal without restarting it', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'danger-full-access')
  await f.runtime.setGoalWaiting(f.session.sessionId, true)
  f.queue.push({ name: 'create_goal', args: { objective: 'Wait for a child then finish', max_goal_rounds: 3 } })
  await f.prompt()
  assert.equal(f.requests.length, 2)
  await f.runtime.cancel(f.session.sessionId)
  await f.runtime.setGoalWaiting(f.session.sessionId, false)
  f.queue.push({ name: 'get_goal', args: {} })
  await f.prompt()
  assert.equal(f.requests.length, 4)
  const text = f.requests.at(-1).messages.filter((entry) => entry.role === 'tool').at(-1).content
  assert.match(text, /disarmed/)
  assert.match(text, /active/)
})

test('real ACP switches native → PTC → native, forwards internal tools, resumes and isolates sessions', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'danger-full-access')
  assert.equal(toolModeOption(f.session.configOptions).currentValue, 'native')
  await f.prompt()
  const schemas = () => f.requests.at(-1).tools.map((tool) => tool.function.name)
  assert.ok(schemas().includes('read'))
  assert.equal(schemas().includes('run_code'), false)
  await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
  const updates = await f.run('return await tools.read({ file_path: "input.txt" });')
  assert.deepEqual(schemas(), ['run_code'])
  const inner = updates.find((update) => update.title === 'read')
  assert.ok(inner, JSON.stringify(updates))
  assert.match(inner.toolCallId, /:ptc:1$/)
  assert.ok(inner._meta['agentDesk/ptc'].parentCallId)
  assert.match(JSON.stringify(updates.find((update) => update.toolCallId === inner.toolCallId && update.status === 'completed')), /PTC fixture content/)
  // Another root in the very same process retains native presentation.
  const other = await f.runtime.newSession(f.workspace)
  assert.equal(toolModeOption(other.configOptions).currentValue, 'native')
  await f.runtime.prompt(other.sessionId, [{ type: 'text', text: 'other root' }])
  assert.ok(schemas().includes('read'))
  await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'native')
  await f.prompt()
  assert.ok(schemas().includes('read'))
  assert.equal(schemas().includes('run_code'), false)
  const nativeSystem = f.requests.at(-1).messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
  assert.doesNotMatch(nativeSystem, /Only `run_code`|namespace tools/)
  await f.runtime.stop()
  await f.runtime.start()
  const resumed = await f.runtime.resumeSession(f.session.sessionId, f.workspace)
  assert.equal(toolModeOption(resumed.configOptions).currentValue, 'native')
  await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
  await f.prompt()
  assert.deepEqual(schemas(), ['run_code'])
  assert.ok(f.requests.at(-1).messages.some((message) => message.role === 'tool'), 'prior tool history survives switching and resume')
})

test('real ACP shares SDK output types while retaining every native binding', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'workspace-write')
  await f.prompt()
  const nativeNames = f.requests.at(-1).tools.map(tool => tool.function.name).sort()
  await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
  await f.prompt()
  const system = f.requests.at(-1).messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n')
  const fence = String.fromCharCode(96).repeat(3)
  const argsAt = system.indexOf('interface ToolArgsMap')
  const start = system.lastIndexOf(fence + 'ts\n', argsAt)
  const end = system.indexOf('\n' + fence, argsAt)
  assert.ok(argsAt >= 0 && start >= 0 && end > start)
  const source = system.slice(start + (fence + 'ts\n').length, end)
  const parsed = ts.createSourceFile('actual-ptc-sdk.ts', source, ts.ScriptTarget.ESNext, true)
  assert.equal(parsed.parseDiagnostics.length, 0)
  const args = parsed.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'ToolArgsMap')
  const outputs = parsed.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'ToolOutputMap')
  assert.deepEqual(args.members.map(member => member.name.text).sort(), nativeNames)
  assert.deepEqual(outputs.members.map(member => member.name.text).sort(), nativeNames)
  assert.ok(parsed.statements.some(node => ts.isTypeAliasDeclaration(node) && node.name.text.startsWith('SharedOutput')))
})

test('real PTC passes literal source as data without compiling, interpolating or leaking it across calls', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'workspace-write')
  await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
  const source = [
    "'use strict';",
    'const result = {text: "日本語"};',
    'process.stdout.write(`${JSON.stringify(result)}\\n`);',
    '// quotes: single \' double " backtick ` interpolation ${literal}',
    'globalThis.__ptcDataExecuted = true;',
  ].join('\n') + '\n' + '// literal data padding\n'.repeat(600)
  const files = [{ file_path: 'literal.cjs', content: source }, { file_path: 'other.txt', content: 'quotes \' " ` ${literal}\n日本語' }]
  // The old nested-template shape fails before any write; do not guess a repair.
  await f.run("await tools.write({file_path:'nested-must-not-run.cjs',content:`" + source + "`});")
  await assert.rejects(fs.stat(path.join(f.workspace, 'nested-must-not-run.cjs')))
  await f.run('const files = await input.get<ToolArgsMap["write"][]>(); for (const file of files) await tools.write(file); return {executed: Object.hasOwn(globalThis, "__ptcDataExecuted")};', { data: files })
  assert.equal(await fs.readFile(path.join(f.workspace, 'literal.cjs'), 'utf8'), source)
  const announced = f.updates.find(x => x.rawInput?.data)
  assert.deepEqual(announced?.rawInput?.data, files, 'execution/approval detail must retain the separate input data')
  assert.equal(await fs.readFile(path.join(f.workspace, 'other.txt'), 'utf8'), files[1].content)
  const request = f.requests.at(-1)
  assert.deepEqual(request.tools.map(x => x.function.name), ['run_code'])
  assert.ok(request.tools[0].function.parameters.properties.data)
  assert.ok(!request.tools[0].function.parameters.required.includes('data'))
  assert.deepEqual(Object.keys(request.tools[0].function.parameters.properties).slice(0, 3), ['code', 'description', 'data'])
  assert.deepEqual(request.tools[0].function.parameters.required, ['code', 'description'])
  const result = request.messages.filter(x => x.role === 'tool').at(-1).content
  assert.match(typeof result === 'string' ? result : JSON.stringify(result), /"executed":\s*false/)
  await f.run('const input = "legacy-local-name"; return input;')
  const legacy = f.requests.at(-1).messages.filter(x => x.role === 'tool').at(-1).content
  assert.match(typeof legacy === 'string' ? legacy : JSON.stringify(legacy), /legacy-local-name/)
  await f.run('return typeof input;')
  const absent = f.requests.at(-1).messages.filter(x => x.role === 'tool').at(-1).content
  assert.match(typeof absent === 'string' ? absent : JSON.stringify(absent), /undefined/)
})

test('PTC data accessor accepts no arguments and legacy empty containers without changing tools', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'workspace-write')
  await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
  for (const [i, args] of ['', '{}', '[]'].entries()) {
    const data = { file_path: `input-get-${i}.txt`, content: `literal-${i}` }
    await f.run(`return await tools.write(await input.get(${args}));`, { data })
    assert.equal(await fs.readFile(path.join(f.workspace, data.file_path), 'utf8'), data.content)
  }
  await f.run('try { await tools.working_directory(); return "unexpected-default"; } catch (error) { return error.message; }')
  const result = f.requests.at(-1).messages.filter(x => x.role === 'tool').at(-1).content
  assert.match(typeof result === 'string' ? result : JSON.stringify(result), /binding arguments must be lossless JSON/)
})

test('PTC rejects data-only and missing-description calls before execution and does not stage data', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'workspace-write')
  await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
  const data = { file_path: 'must-not-default-code.txt', content: 'must not execute' }
  for (const args of [{ data }, { code: 'return await tools.write(await input.get());', data }]) {
    f.queue.push({ name: 'run_code', args })
    await f.prompt()
    const result = f.requests.at(-1).messages.filter(x => x.role === 'tool').at(-1).content
    assert.match(typeof result === 'string' ? result : JSON.stringify(result), /missing required property/)
    await assert.rejects(fs.stat(path.join(f.workspace, data.file_path)))
  }
  await f.run('return typeof input;')
  const result = f.requests.at(-1).messages.filter(x => x.role === 'tool').at(-1).content
  assert.match(typeof result === 'string' ? result : JSON.stringify(result), /undefined/)
})

test('PTC data does not grant read-only sessions write permission', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'read-only')
  await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
  await f.run('return await tools.write(await input.get<ToolArgsMap["write"]>());', { data: { file_path: 'forbidden-data.txt', content: 'must not write' } })
  await assert.rejects(fs.stat(path.join(f.workspace, 'forbidden-data.txt')))
})

test('real PTC syntax diagnostics reach the model without executing tools and the session recovers', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'workspace-write')
  await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
  const marker = path.join(f.workspace, 'must-not-be-written.txt')
  await f.run('await tools.write({file_path:"must-not-be-written.txt",content:"SECRET_OTHER_LINE"});\nconst broken = {x: 1)', { data: { secret: 'SECRET_INPUT_DATA' } })
  const content = f.requests.at(-1).messages.filter(entry => entry.role === 'tool').at(-1).content
  const error = typeof content === 'string' ? content : JSON.stringify(content)
  assert.match(error, /code run failed/)
  assert.match(error, /line 2, column/)
  assert.match(error, /const broken/)
  assert.doesNotMatch(error, /SECRET_OTHER_LINE|SECRET_INPUT_DATA|node:internal|__dsh_program__/)
  await assert.rejects(fs.stat(marker))
  // A Japanese todo after an earlier error must not hide the actual location.
  await f.run('const before = 1; '.repeat(45) + 'const broken = {x: 1); ' + 'const todo = "確認する"; '.repeat(30))
  const longContent = f.requests.at(-1).messages.filter(entry => entry.role === 'tool').at(-1).content
  const longError = typeof longContent === 'string' ? longContent : JSON.stringify(longContent)
  assert.match(longError, /line 1, column/)
  assert.match(longError, /const broken = \{x: 1\)/)
  assert.ok(longError.length < 350)
  await f.run('console.log("syntax-recovery"); return {ok:true}')
  const recovered = f.requests.at(-1).messages.filter(entry => entry.role === 'tool').at(-1).content
  assert.match(typeof recovered === 'string' ? recovered : JSON.stringify(recovered), /syntax-recovery/)
})

test('real PTC timeout and cancellation settle, then the same ACP session can execute again', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'danger-full-access')
  await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
  const pidFile = path.join(f.workspace, 'pid.txt')
  const spinning = `await (await import('node:fs/promises')).writeFile(${JSON.stringify(pidFile)}, String(process.pid)); while (true) {}`
  const timed = await f.run(spinning, { timeoutMs: 1000 })
  assert.ok(timed.some((update) => update.status === 'failed'), JSON.stringify(timed))
  const timedPid = Number(await fs.readFile(pidFile, 'utf8'))
  assert.throws(() => process.kill(timedPid, 0), { code: 'ESRCH' })
  await fs.unlink(pidFile)
  f.queue.push({ name: 'run_code', args: { code: spinning, description: 'Wait for cancellation', timeoutMs: 30_000 } })
  const from = f.updates.length
  const pending = f.prompt()
  let cancelledPid
  for (let n = 0; n < 200 && !cancelledPid; n++) {
    cancelledPid = await fs.readFile(pidFile, 'utf8').then(Number, () => null)
    if (!cancelledPid) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(cancelledPid, 'PTC process reached the running program')
  assert.ok(f.updates.slice(from).some((update) => update.title === 'run_code'))
  await assert.rejects(f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'native'))
  await f.runtime.cancel(f.session.sessionId)
  assert.equal((await pending).stopReason, 'cancelled')
  assert.throws(() => process.kill(cancelledPid, 0), { code: 'ESRCH' })
  const next = await f.run('return 42;')
  assert.ok(next.some((update) => update.status === 'completed' && JSON.stringify(update).includes('42')), JSON.stringify(next))
})

for (const permissionMode of ['workspace-write', 'danger-full-access', 'read-only']) {
  for (const toolMode of ['native', 'ptc']) {
    test('Plan suffix preserves runtime, tools and history (' + permissionMode + ', ' + toolMode + ')', { timeout: 120_000 }, async (t) => {
      const f = await setup(t, permissionMode)
      const threads = new ThreadManager({ paths: f.paths, pool: Object.assign(new EventEmitter(), {
        get: async (key) => { assert.equal(key, permissionMode); return f.runtime.start() },
        holderOf: (id) => f.runtime.liveSessions.has(id) ? f.runtime : null, status: () => ({}),
      }), catalog: { learn: () => false }, getAccounts: async () => ({ localLlm: { configured: true } }), getTurnUsage: async () => null })
      f.cleanups.push(() => threads.shutdown())
      const collect = f.runtime.onUpdate
      f.runtime.onUpdate = (id, update) => { collect(id, update); threads.onUpdate(id, update) }
      const thread = await threads.create({ workspace: f.workspace, model: '["local-llm","ptc-fixture"]', permissionMode, toolMode })
      const send = async (text, plan) => {
        await threads.send(thread.id, { text, plan })
        await threads.active.get(thread.id).done
        const view = await threads.get(thread.id)
        assert.equal(view.turns.at(-1).status, 'done', JSON.stringify(view.turns.at(-1)))
        return view.thread.sessionId
      }
      f.queue.push({ name: toolMode === 'ptc' ? 'run_code' : 'read', args: toolMode === 'ptc'
        ? { description: 'Read original evidence', code: 'return await tools.read({ file_path: "input.txt" });' } : { file_path: 'input.txt' } })
      const id = await send('original-context-before-plan', false)
      const schemas = f.requests.at(-1).tools
      const process = f.runtime.child
      const from = f.requests.length
      // Deliberately non-compliant mock: prove Plan is a request, not an execution guard.
      f.queue.push({ name: toolMode === 'ptc' ? 'run_code' : 'write', args: toolMode === 'ptc'
        ? { description: 'Test ordinary file permissions', code: 'return await tools.write({ file_path: "plan-fixture.txt", content: "ordinary permission" });' }
        : { file_path: 'plan-fixture.txt', content: 'ordinary permission' } })
      assert.equal(await send('consult-without-editing', true), id)
      const messages = f.requests[from].messages
      assert.match(JSON.stringify(messages), /original-context-before-plan/)
      assert.match(JSON.stringify(messages), /PTC fixture content/)
      const lastUser = messages.findLast((message) => message.role === 'user')
      assert.ok(JSON.stringify(lastUser).includes(PLAN_INSTRUCTION))
      assert.deepEqual(f.requests[from].tools, schemas)
      assert.equal(f.runtime.child, process)
      if (permissionMode === 'read-only') await assert.rejects(fs.stat(path.join(f.workspace, 'plan-fixture.txt')), { code: 'ENOENT' })
      else assert.equal(await fs.readFile(path.join(f.workspace, 'plan-fixture.txt'), 'utf8'), 'ordinary permission')
      const off = f.requests.length
      assert.equal(await send('implement-after-plan', false), id)
      assert.ok(!JSON.stringify(f.requests[off].messages.findLast((message) => message.role === 'user')).includes(PLAN_INSTRUCTION))
      assert.equal(toolModeOption(threads.liveOptions.get(id)).currentValue, toolMode)
      assert.equal(f.runtime.child, process)
      assert.equal(threads.threads.get(thread.id).sessionPlan, undefined)
    })
  }
}


for (const [permissionMode, toolMode] of [['workspace-write', 'ptc'], ['danger-full-access', 'native']]) {
  test('legacy Plan restores saved read-only override (' + permissionMode + ', ' + toolMode + ')', { timeout: 120_000 }, async (t) => {
    const f = await setup(t, 'read-only')
    const plugin = path.join(f.home, 'legacy-policy.mjs')
    const patch = path.join(f.home, 'legacy-policy.patch.yml')
    await fs.writeFile(plugin, "export const inject = ['sessions']; export function apply(ctx) { ctx.on('agent/created', async ({agent}) => { agent.session.append('sandbox/mode', {mode: 'read-only'}); await ctx.sessions.flush(agent.session); }); }")
    await fs.writeFile(patch, YAML.stringify([{ insert: [{ id: 'legacy-policy', name: pathToFileURL(plugin).href }] }]))
    const legacy = new AcpRuntime({ mode: 'read-only', paths: f.paths, patches: [patch], onUpdate: (_id, update) => f.updates.push(update), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    const writer = new AcpRuntime({ mode: permissionMode, paths: f.paths, onUpdate() {}, onPermission: async () => assert.fail('restored session should write normally') })
    f.runtimes.push(legacy, writer)
    await legacy.start()
    const session = await legacy.newSession(f.workspace)
    await legacy.prompt(session.sessionId, [{ type: 'text', text: 'legacy-consultation-context' }])
    const threads = new ThreadManager({ paths: f.paths, pool: Object.assign(new EventEmitter(), {
      get: async () => writer.start(), holderOf: (id) => [legacy, writer].find((runtime) => runtime.liveSessions.has(id)), status: () => ({}),
    }), catalog: { learn: () => false }, getAccounts: async () => ({ localLlm: { configured: true } }), getTurnUsage: async () => null })
    f.cleanups.push(() => threads.shutdown())
    writer.onUpdate = (id, update) => threads.onUpdate(id, update)
    const thread = await threads.create({ workspace: f.workspace, model: '["local-llm","ptc-fixture"]', permissionMode, toolMode })
    Object.assign(threads.threads.get(thread.id), { sessionId: session.sessionId, sessionPlan: true })
    f.queue.push({ name: toolMode === 'ptc' ? 'run_code' : 'write', args: toolMode === 'ptc'
      ? { description: 'Verify restored permissions', code: 'return await tools.write({ file_path: "restored.txt", content: "restored" });' }
      : { file_path: 'restored.txt', content: 'restored' } })
    await threads.send(thread.id, { text: 'consult using the new suffix', plan: true })
    await threads.active.get(thread.id).done
    const view = await threads.get(thread.id)
    assert.equal(view.turns.at(-1).status, 'done', JSON.stringify(view.turns.at(-1)))
    assert.equal(view.thread.sessionId, session.sessionId)
    assert.equal(threads.threads.get(thread.id).sessionPlan, undefined)
    assert.match(JSON.stringify(f.requests.at(-1).messages), /legacy-consultation-context/)
    assert.equal(await fs.readFile(path.join(f.workspace, 'restored.txt'), 'utf8'), 'restored')
  })
}

for (const profile of ['ab-read', 'ab-research', 'ab-write', 'team', 'team-read']) {
  test(`real ${profile} profile executes PTC without reopening delegation or role writes`, { timeout: 120_000 }, async (t) => {
    const writable = profile === 'ab-write' || profile === 'team'
    const f = await setup(t, writable ? 'danger-full-access' : 'read-only', profile)
    f.queue.push({ name: 'read', args: { file_path: 'input.txt' } })
    await f.prompt()
    const system = f.requests.at(-1).messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
    assert.doesNotMatch(system, /Subagents on a fixed model:/)
    assert.equal(f.permissions.length, 0, 'native reads use standing role permissions')
    if (profile.startsWith('ab')) {
      assert.match(system, /Approval prompts are unavailable in AB/)
      assert.match(system, /Omit sandbox_permissions and justification/)
      assert.match(system, writable ? /already runs with danger-full-access/ : /worker in a read-only session/)
    }
    if (profile === 'team-read') {
      assert.match(system, /This child session runs in read-only mode, independently of the leader's permissions/)
      assert.match(system, /Omit sandbox_permissions and justification on run_code/)
    }
    await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
    // Reproduce the screenshot's initial investigation, without escalation controls.
    const reads = await f.run(profile === 'team-read'
      ? `await tools.todo_write({ todos: [{ content: 'Inspect source', status: 'in_progress' }] });
         await tools.working_directory({ cd: ${JSON.stringify(f.workspace)} });
         await tools.glob({ pattern: '*.txt', path: ${JSON.stringify(f.workspace)} });
         return await tools.read({ file_path: "input.txt" });`
      : 'return await tools.read({ file_path: "input.txt" });')
    assert.ok(reads.some((update) => update.title === 'read' && update.status === 'completed'))
    assert.equal(f.permissions.length, 0, 'read-only investigation does not require approval')
    if (profile === 'team-read') {
      assert.ok(!reads.some((update) => update.status === 'failed'), JSON.stringify(reads))
      const system = f.requests.at(-1).messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
      assert.match(system, /Omit sandbox_permissions and justification on run_code/)
      await f.runtime.stop()
      await f.runtime.start()
      await f.runtime.resumeSession(f.session.sessionId, f.workspace)
      // ThreadManager reapplies the saved presentation before every prompt.
      await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
      const resumed = await f.run('return await tools.read({ file_path: "input.txt" });')
      assert.ok(resumed.some((update) => update.title === 'read' && update.status === 'completed'))
      assert.equal(f.permissions.length, 0)
      const resumedSystem = f.requests.at(-1).messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
      assert.match(resumedSystem, /This child session runs in read-only mode/)
    }
    const absent = await f.run('return { subagent: typeof tools.subagent, workflow: typeof tools.workflow, goal: typeof tools.create_goal, write: typeof tools.write };')
    const text = JSON.stringify(absent)
    assert.match(text, /subagent[^}]*undefined/)
    assert.match(text, /goal[^}]*undefined/)
    if (profile.startsWith('ab')) {
      assert.match(text, /workflow[^}]*undefined/)
    }
    const target = path.join(f.workspace, 'role-write.txt')
    if (writable) {
      if (profile === 'ab-write') {
        const rejected = await f.run('return "must not execute";', { sandbox_permissions: 'danger-full-access', justification: 'Verify that AB still rejects escalation controls' })
        assert.ok(rejected.some(update => update.status === 'failed' && JSON.stringify(update).includes('AB: escalation is disabled.')))
        assert.equal(f.permissions.length, 0, 'AB guard rejects even redundant controls before asking for approval')
        const recovered = await f.run('return await tools.read({ file_path: "input.txt" });')
        assert.ok(recovered.some(update => update.title === 'read' && update.status === 'completed'))
      }
      const written = await f.run(`return await tools.write({ file_path: ${JSON.stringify(target)}, content: 'role write' });`)
      assert.equal(await fs.readFile(target, 'utf8'), 'role write')
      assert.ok(written.some((update) => update.title === 'write' && update.status === 'completed'))
    } else {
      const failed = await f.run(`await (await import('node:fs/promises')).writeFile(${JSON.stringify(target)}, 'forbidden');`)
      await assert.rejects(fs.stat(target), { code: 'ENOENT' })
      assert.ok(failed.some((update) => update.status === 'failed'))
      const escalation = await f.run(`await (await import('node:fs/promises')).writeFile(${JSON.stringify(target)}, 'must not escalate');`, { sandbox_permissions: 'danger-full-access', justification: 'Try escalation for a role test' })
      assert.ok(escalation.some((update) => update.status === 'failed'))
      assert.ok(f.permissions.length <= 1, 'any request was cancelled by the fixture, never approved')
    }
    await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'native')
    await f.prompt()
    const schemas = f.requests.at(-1).tools.map((tool) => tool.function.name)
    assert.ok(schemas.includes('read'))
    assert.ok(!schemas.includes('run_code'))
    assert.ok(!schemas.includes('subagent'))
    assert.ok(!schemas.includes('create_goal'))
    assert.ok(!schemas.includes('update_goal'))
  })
}

for (const mode of ['read-only', 'workspace-write']) {
  test(`real PTC direct Node writes respect ${mode} within fixture directories`, { timeout: 120_000 }, async (t) => {
    const f = await setup(t, mode)
    f.queue.push({ name: 'read', args: { file_path: 'input.txt' } })
    await f.prompt()
    assert.match(JSON.stringify(f.updates), /PTC fixture content/, 'native read returns the fixture content')
    assert.ok(!f.updates.some(update => update.status === 'failed'), JSON.stringify(f.updates))
    assert.equal(f.permissions.length, 0, 'ordinary native reads do not ask for escalation')
    await f.runtime.setOption(f.session.sessionId, TOOL_MODE_CONFIG, 'ptc')
    const target = path.join(f.workspace, 'inside.txt')
    const outside = path.join(f.home, 'outside.txt')
    const code = (file) => `const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(file)}, 'probe'); return 'wrote';`
    const inside = await f.run(code(target))
    if (mode === 'read-only') {
      await assert.rejects(fs.stat(target), { code: 'ENOENT' })
      assert.ok(inside.some((update) => update.status === 'failed'), JSON.stringify(inside))
    } else {
      assert.equal(await fs.readFile(target, 'utf8'), 'probe')
    }
    const denied = await f.run(code(outside))
    await assert.rejects(fs.stat(outside), { code: 'ENOENT' })
    assert.ok(denied.some((update) => update.status === 'failed'), JSON.stringify(denied))
    assert.equal(f.permissions.length, 0, 'direct Node probes did not request escalation')
    const registered = path.join(f.workspace, 'registered.txt')
    const inner = await f.run(`try { return await tools.write({ file_path: ${JSON.stringify(registered)}, content: 'registered probe' }); } catch (error) { return String(error); }`)
    const write = inner.find((update) => update.title === 'write' && update.sessionUpdate === 'tool_call_update')
    assert.ok(write, JSON.stringify(inner))
    assert.equal(write.status, mode === 'read-only' ? 'failed' : 'completed', JSON.stringify(inner))
    if (mode === 'read-only') await assert.rejects(fs.stat(registered), { code: 'ENOENT' })
    else assert.equal(await fs.readFile(registered, 'utf8'), 'registered probe')
  })
}

for (const toolMode of ['native', 'ptc']) {
  test('Codex and Claude skills load through the real skill tool (' + toolMode + ')', { timeout: 120_000 }, async (t) => {
    const f = await setup(t, 'danger-full-access')
    const workspace = path.join(f.home, 'skill-project')
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true })
    for (const directory of ['.codex', '.claude']) {
      const name = directory.slice(1) + '-fixture'
      const folder = path.join(workspace, directory, 'skills', name)
      await fs.mkdir(folder, { recursive: true })
      await fs.writeFile(path.join(folder, 'SKILL.md'), ['---', 'name: ' + name, 'description: deterministic skill fixture', '---', 'BODY_' + name].join('\n'))
    }
    const session = await f.runtime.newSession(workspace)
    await f.runtime.setOption(session.sessionId, TOOL_MODE_CONFIG, toolMode)
    if (toolMode === 'ptc') {
      f.queue.push({ name: 'run_code', args: { code: 'for (const name of ["codex-fixture", "claude-fixture"]) console.log(await tools.skill({name}))', description: 'Load local skill fixtures' } })
    } else {
      f.queue.push({ name: 'skill', args: { name: 'codex-fixture' } }, { name: 'skill', args: { name: 'claude-fixture' } })
    }
    const result = await f.runtime.prompt(session.sessionId, [{ type: 'text', text: 'Load the two fixture skills' }])
    assert.equal(result.stopReason, 'end_turn')
    const firstPrompt = JSON.stringify(f.requests[0].messages)
    assert.ok(firstPrompt.includes('codex-fixture'), 'Codex skill missing from model catalog')
    assert.ok(firstPrompt.includes('claude-fixture'), 'Claude skill missing from model catalog')
    const replies = JSON.stringify(f.requests.at(-1).messages)
    assert.match(replies, /BODY_codex-fixture/)
    assert.match(replies, /BODY_claude-fixture/)
    assert.doesNotMatch(replies, /unknown or no longer available/)
    assert.equal(f.permissions.length, 0)
  })
}
