// Real ACP + bundled PTC runtime; deterministic local responses, no provider API.
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { AcpRuntime, RuntimePool } from '../server/runtime.js'
import { TeamManager } from '../server/teams.js'
import { ThreadManager } from '../server/threads.js'
import { appPaths } from '../server/paths.js'
import { abPatch, homePatch, shippedPersona, teamChildPatch } from '../server/dsh-config.js'
import { localRoute } from '../server/local-llm.js'
import { TOOL_MODE_CONFIG, toolModeOption } from '../server/ptc.js'

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
  const rows = YAML.parse(homePatch({ localRoute: localRoute({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'ptc-fixture' }] }), subagentsEnabled: Boolean(profile), subagents, persona }))
  rows.find((row) => row.id === 'acp').config = { provider: 'local-llm', model: 'ptc-fixture' }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  const patches = []
  if (profile) {
    const file = path.join(home, 'role.patch.yml')
    await fs.writeFile(file, profile.startsWith('team') ? teamChildPatch({ subagents, persona }) : abPatch({ subagents, persona, writable: profile === 'ab-write', lean: profile !== 'ab-research' && profile !== 'plan', plan: profile === 'plan' }))
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
    const threads = new ThreadManager({ paths: f.paths, pool, catalog,
      getAccounts: async () => ({ localLlm: { configured: true } }), getTurnUsage: async () => null })
    const terminals = Object.assign(new EventEmitter(), { status: () => null })
    const agents = Object.assign(new EventEmitter(), { get: () => null, running: () => false })
    const teams = new TeamManager({ file: path.join(f.home, 'teams.json'), dir: path.join(f.home, 'teams'),
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

test('real Plan profile exposes reads but not writing or delegation', { timeout: 120_000 }, async (t) => {
  const f = await setup(t, 'read-only', 'plan')
  f.queue.push({ name: 'read', args: { file_path: 'input.txt' } })
  await f.prompt()
  assert.ok(f.updates.some((update) => update.toolCallId === 'call-1' && update.status === 'completed' && JSON.stringify(update).includes('PTC fixture content')), JSON.stringify(f.updates))
  const schemas = f.requests.at(-1).tools.map((tool) => tool.function.name)
  for (const name of ['write', 'edit', 'pwsh', 'bash', 'run_code', 'subagent', 'create_goal']) assert.ok(!schemas.includes(name), name)
  const system = f.requests.at(-1).messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
  assert.match(system, /Plan mode/)
  assert.equal(f.permissions.length, 0)
})

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
    if (profile.startsWith('ab')) {
      assert.match(text, /workflow[^}]*undefined/)
      assert.match(text, /goal[^}]*undefined/)
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
