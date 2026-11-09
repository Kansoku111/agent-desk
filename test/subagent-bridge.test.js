import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createRequestHandler } from '../server/http-routes.js'
import { BRIDGE_MCP_SERVER, SUBAGENT_TOOL_TIMEOUT_SEC, SubagentBridge } from '../server/subagent-bridge.js'
import { defaultRoutes } from '../server/subagent-routes.js'

const luna = JSON.stringify(['openai-codex', 'gpt-6-luna'])

/** A runner that finishes each session with `answer`, and remembers what it was asked. */
function fakeRunner(answer = { status: 'done', text: 'the report' }) {
  const runner = Object.assign(new EventEmitter(), {
    records: new Map(), created: [], runs: [], stopped: [], removed: [], sessions: [], answer,
    async create(options) {
      const id = `s${runner.created.length + 1}`
      runner.created.push(options)
      runner.records.set(id, options)
      runner.sessions.push({ id, subagent: options.subagent ?? null })
      return { id }
    },
    run(id, prompt) {
      runner.runs.push([id, prompt])
      setImmediate(() => runner.emit('finished', { id, ...runner.answer }))
    },
    stop(id) { runner.stopped.push(id); return Promise.resolve() },
    async remove(id) { runner.removed.push(id); runner.records.delete(id) },
    list: () => runner.sessions,
  })
  return runner
}

async function setup(t, { routes = {}, settings = {}, parents = {}, claude = fakeRunner(), codex = fakeRunner(), runDsh } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-bridge-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const live = { subagentsEnabled: true, subagentRoutes: { ...defaultRoutes(), ...routes }, ...settings }
  const patches = []
  const dshRuns = []
  const info = { workspace: 'C:\\project', mode: 'danger-full-access', ...parents }
  const bridge = await new SubagentBridge({
    file: path.join(dir, 'subagent-bridge.json'), paths: { home: dir }, settings: () => live, url: () => 'http://127.0.0.1:4000/api/subagent',
    parents: { dsh: () => info, cl: () => info, gp: () => ({ ...info, model: 'gpt-6.1-sol', effort: 'medium' }) },
    claude, codex, instructions: () => 'Be brief.',
    dshPatch: async (kind, child) => { patches.push([kind, child]); return 'child.patch.yml' },
    runDsh: runDsh ?? (async (options) => { dshRuns.push(options); return 'dsh report' }),
  }).load()
  return { bridge, live, claude, codex, patches, dshRuns, dir, file: path.join(dir, 'subagent-bridge.json') }
}

test('a call is authorized only with the token issued for that very task', async (t) => {
  const { bridge } = await setup(t)
  const token = (id) => bridge.mcpServer('gp', id, 'C:\\p').env.find((entry) => entry.name === 'AGENT_DESK_SUBAGENT_TOKEN').value
  assert.deepEqual(bridge.authorize('gp:task-1', token('task-1')), { kind: 'gp', id: 'task-1' })
  assert.deepEqual(bridge.authorize('gp:a:b', token('a:b')), { kind: 'gp', id: 'a:b' })
  assert.equal(bridge.authorize('gp:task-2', token('task-1')), null)
  assert.equal(bridge.authorize('cl:task-1', token('task-1')), null)
  for (const [parent, given] of [['gp:task-1', 'x'], ['gp:task-1', ''], ['gp:task-1', 5], ['gp:task-1', undefined], ['gp:', token('')], ['team:task-1', token('task-1')], [undefined, token('task-1')]]) {
    assert.equal(bridge.authorize(parent, given), null, String(parent))
  }
})

test('the secret survives a restart, so the tokens already handed to running tasks keep working', async (t) => {
  const first = await setup(t)
  const token = first.bridge.mcpServer('gp', 'a', 'C:\\p').env.find((entry) => entry.name === 'AGENT_DESK_SUBAGENT_TOKEN').value
  const again = await new SubagentBridge({ file: first.file, paths: { home: first.dir }, settings: () => first.live, url: () => '', parents: {}, claude: fakeRunner(), codex: fakeRunner(), dshPatch: async () => '' }).load()
  assert.deepEqual(again.authorize('gp:a', token), { kind: 'gp', id: 'a' })
  assert.match(JSON.parse(await fs.readFile(first.file, 'utf8')).secret, /^[0-9a-f]{64}$/)
})

test('children an exit left behind are removed when the bridge starts', async (t) => {
  const codex = fakeRunner()
  codex.sessions.push({ id: 'old', subagent: { parent: 'gp:x' } }, { id: 'task', subagent: null })
  const claude = fakeRunner()
  claude.records.set('old-claude', {})
  await setup(t, { codex, claude })
  assert.deepEqual(codex.removed, ['old'])
  assert.deepEqual(claude.removed, ['old-claude'])
})

test('only a route that leaves the task\'s own tools needs the bridge tool', async (t) => {
  const { bridge, live } = await setup(t)
  assert.equal(bridge.mcpServer('dsh', 'a', 'C:\\p'), null)
  assert.equal(bridge.mcpServer('cl', 'a', 'C:\\p'), null)
  // Codex has no subagent tools of its own, so it always has the bridge, and runs the task's own model by default.
  const own = bridge.mcpServer('gp', 'a', 'C:\\p')
  assert.equal(own.name, BRIDGE_MCP_SERVER)
  assert.equal(bridge.bridges('gp'), true)
  assert.equal(own.args[own.args.indexOf('--label') + 1], 'Codex gpt-6.1-sol')
  live.subagentRoutes = { ...live.subagentRoutes, dsh: { target: 'cl', model: 'claude:haiku', effort: 'low' }, cl: { target: 'dsh', model: luna, effort: null } }
  const server = bridge.mcpServer('dsh', 'a', 'C:\\p')
  assert.deepEqual(server.args.slice(1), ['--workspace', 'C:\\p', '--label', 'Claude Code haiku', '--note', 'billed the way the user\'s Claude Code is'])
  const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
  assert.equal(env.AGENT_DESK_SUBAGENT_URL, 'http://127.0.0.1:4000/api/subagent')
  assert.equal(env.AGENT_DESK_SUBAGENT_PARENT, 'dsh:a')
  assert.equal(Number(env.DSH_MCP_TOOL_TIMEOUT_MS ?? env[Object.keys(env).find((name) => /TIMEOUT/.test(name))]), SUBAGENT_TOOL_TIMEOUT_SEC * 1000)
  assert.match(bridge.mcpServer('cl', 'a', 'C:\\p').args.join(' '), /GPT gpt-6-luna/)
  // Off, there is no tool at all.
  live.subagentsEnabled = false
  assert.equal(bridge.mcpServer('gp', 'a', 'C:\\p'), null)
})

test('DSH asks Claude Code: its model and level, no wider than the task, and a header says who ran it', async (t) => {
  const { bridge, claude } = await setup(t, { routes: { dsh: { target: 'cl', model: 'claude:haiku', effort: 'low' } } })
  const text = await bridge.call({ parent: { kind: 'dsh', id: 'a' }, prompt: 'review it' })
  assert.equal(text, 'Ran on: Claude Code haiku (reasoning low)\n\nthe report')
  assert.equal(claude.created.length, 1)
  assert.equal(claude.created[0].model, 'haiku')
  assert.equal(claude.created[0].effort, 'low')
  assert.equal(claude.created[0].workspace, 'C:\\project')
  const args = claude.created[0].args
  // Full access: write tools stay; the child cannot start subagents; it knows it is one and the user's instructions.
  assert.ok(!args.includes('--tools'))
  assert.match(args.at(-1), /You are a subagent/)
  assert.match(args.at(-1), /Be brief\./)
  assert.deepEqual(claude.runs, [['s1', 'review it']])
  assert.deepEqual(claude.removed, ['s1'])
})

test('a read-only task only gets a read-only Claude Code child, and a workspace-only task none', async (t) => {
  const route = { dsh: { target: 'cl', model: 'claude:haiku', effort: null } }
  const readOnly = await setup(t, { routes: route, parents: { mode: 'read-only' } })
  await readOnly.bridge.call({ parent: { kind: 'dsh', id: 'a' }, prompt: 'look' })
  assert.ok(readOnly.claude.created[0].args.includes('--tools'))
  const limited = await setup(t, { routes: route, parents: { mode: 'workspace-write' } })
  await assert.rejects(limited.bridge.call({ parent: { kind: 'dsh', id: 'a' }, prompt: 'look' }), /Ran on: Claude Code haiku[\s\S]*unsandboxed/)
  assert.equal(limited.claude.created.length, 0)
})

test('Claude Code asks Codex: an unattended session of the task\'s mode that no one can approve or answer', async (t) => {
  const { bridge, codex } = await setup(t, { routes: { cl: { target: 'gp', model: 'codex:gpt-6-luna', effort: 'low' } }, parents: { mode: 'read-only' } })
  const text = await bridge.call({ parent: { kind: 'cl', id: 'a' }, prompt: 'check' })
  assert.equal(text, 'Ran on: Codex gpt-6-luna (reasoning low)\n\nthe report')
  const made = codex.created[0]
  assert.equal(made.model, 'gpt-6-luna')
  assert.equal(made.effort, 'low')
  assert.equal(made.permissionMode, 'read-only')
  assert.equal(made.permissionPolicy, 'deny')
  assert.deepEqual(made.mcpServers, {})
  assert.deepEqual(made.subagent, { parent: 'cl:a' })
  assert.deepEqual(codex.runs, [['s1', 'check']])
  assert.deepEqual(codex.removed, ['s1'])
})

test('a Codex task\'s subagent with no model of its own runs the task\'s model and level', async (t) => {
  const { bridge, codex } = await setup(t)
  assert.equal(await bridge.call({ parent: { kind: 'gp', id: 'a' }, prompt: 'x' }), 'Ran on: Codex gpt-6.1-sol (reasoning medium)\n\nthe report')
  assert.equal(codex.created[0].model, 'gpt-6.1-sol')
  assert.equal(codex.created[0].effort, 'medium')
})

test('Codex asks DSH: the chosen provider\'s model in a headless dsh, with the task\'s mode', async (t) => {
  const deepseek = JSON.stringify(['deepseek-official', 'deepseek-v4-flash'])
  const { bridge, patches, dshRuns } = await setup(t, { routes: { gp: { target: 'dsh', model: deepseek, effort: 'high' } }, parents: { mode: 'workspace-write' } })
  const text = await bridge.call({ parent: { kind: 'gp', id: 'a' }, prompt: 'compute' })
  assert.match(text, /^Ran on: DeepSeek deepseek-v4-flash \(reasoning high\)\n\ndsh report$/)
  assert.deepEqual(patches, [['gp', { provider: 'deepseek-official', model: 'deepseek-v4-flash', effort: 'high' }]])
  assert.equal(dshRuns.length, 1)
  assert.equal(dshRuns[0].mode, 'workspace-write')
  assert.equal(dshRuns[0].workspace, 'C:\\project')
  assert.equal(dshRuns[0].prompt, 'compute')
  assert.equal(dshRuns[0].patchFile, 'child.patch.yml')
})

test('a failure is returned with who ran it, and a usage limit says not to retry the same way', async (t) => {
  const route = { dsh: { target: 'cl', model: 'claude:haiku', effort: null } }
  const plain = await setup(t, { routes: route, claude: fakeRunner({ status: 'error', error: 'boom' }) })
  await assert.rejects(plain.bridge.call({ parent: { kind: 'dsh', id: 'a' }, prompt: 'x' }), (error) => error.message === 'Ran on: Claude Code haiku\nboom')
  assert.deepEqual(plain.claude.removed, ['s1'])
  const limited = await setup(t, { routes: route, claude: fakeRunner({ status: 'error', error: 'You have hit your limit' }) })
  await assert.rejects(limited.bridge.call({ parent: { kind: 'dsh', id: 'a' }, prompt: 'x' }), /usage limit of this model was reached/)
  const empty = await setup(t, { routes: route, claude: fakeRunner({ status: 'done', text: '' }) })
  assert.match(await empty.bridge.call({ parent: { kind: 'dsh', id: 'a' }, prompt: 'x' }), /returned no text/)
})

test('stopping the parent\'s call stops the child and removes it', async (t) => {
  const claude = fakeRunner()
  claude.run = (id, prompt) => { claude.runs.push([id, prompt]) }
  const { bridge } = await setup(t, { routes: { dsh: { target: 'cl', model: 'claude:haiku', effort: null } }, claude })
  const controller = new AbortController()
  const call = bridge.call({ parent: { kind: 'dsh', id: 'a' }, prompt: 'long', signal: controller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  claude.emit('finished', { id: 's1', status: 'interrupted', text: '', error: null })
  await assert.rejects(call, /did not finish \(interrupted\)/)
  assert.deepEqual(claude.stopped, ['s1'])
  assert.deepEqual(claude.removed, ['s1'])
})

test('a call is refused when subagents are off, the route went back to the task\'s own tools, or the task is gone', async (t) => {
  const { bridge, live } = await setup(t, { routes: { dsh: { target: 'cl', model: 'claude:haiku', effort: null } }, parents: {} })
  live.subagentsEnabled = false
  await assert.rejects(bridge.call({ parent: { kind: 'dsh', id: 'a' }, prompt: 'x' }), /disabled/)
  live.subagentsEnabled = true
  live.subagentRoutes = defaultRoutes()
  await assert.rejects(bridge.call({ parent: { kind: 'dsh', id: 'a' }, prompt: 'x' }), /setting changed/)
  live.subagentRoutes = { ...defaultRoutes(), dsh: { target: 'cl', model: 'claude:haiku', effort: null } }
  bridge.parents.dsh = () => null
  await assert.rejects(bridge.call({ parent: { kind: 'dsh', id: 'a' }, prompt: 'x' }), /not found/)
})

function endpoint(bridge) {
  return createRequestHandler({ paths: {}, subagentBridge: bridge, log() {} })
}
function request(body, method = 'POST') {
  return Object.assign(Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]), { url: '/api/subagent', method, headers: { host: 'localhost' } })
}
function response() {
  const res = new EventEmitter()
  return Object.assign(res, {
    status: null, body: '', writableEnded: false,
    writeHead(status) { res.status = status },
    write(chunk) { res.body += chunk },
    end(chunk = '') { res.body += chunk; res.writableEnded = true; res.emit('close') },
  })
}
const context = { remote: false, port: 1234, token: 'web-token', hostOk: () => true }

test('the endpoint runs a call for an authorized task and answers on its last line; others get 403', async (t) => {
  const { bridge } = await setup(t, { routes: { dsh: { target: 'cl', model: 'claude:haiku', effort: null } } })
  const token = bridge.mcpServer('dsh', 'a', 'C:\\p').env.find((entry) => entry.name === 'AGENT_DESK_SUBAGENT_TOKEN').value
  const handler = endpoint(bridge)
  const ok = response()
  await handler(request({ parent: 'dsh:a', token, prompt: 'go' }), ok, context)
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body.trim().split('\n').at(-1)), { ok: true, text: 'Ran on: Claude Code haiku\n\nthe report' })
  for (const body of [{ parent: 'dsh:a', token: 'bad', prompt: 'go' }, { parent: 'dsh:b', token, prompt: 'go' }, { parent: 'dsh:a', token }, 'not json']) {
    const denied = response()
    await handler(request(body), denied, context)
    assert.equal(denied.status, 403)
    assert.equal(denied.body, 'forbidden')
  }
  const remote = response()
  await handler(request({ parent: 'dsh:a', token, prompt: 'go' }), remote, { ...context, remote: true })
  assert.notEqual(remote.status, 200)
  const get = response()
  await handler(request('', 'GET'), get, context)
  assert.equal(get.status, 405)
})

test('the endpoint reports a failed child as ok:false and stops the child when the caller disconnects', async (t) => {
  const claude = fakeRunner({ status: 'error', error: 'boom' })
  const { bridge } = await setup(t, { routes: { dsh: { target: 'cl', model: 'claude:haiku', effort: null } }, claude })
  const token = bridge.mcpServer('dsh', 'a', 'C:\\p').env.find((entry) => entry.name === 'AGENT_DESK_SUBAGENT_TOKEN').value
  const failed = response()
  await endpoint(bridge)(request({ parent: 'dsh:a', token, prompt: 'go' }), failed, context)
  assert.deepEqual(JSON.parse(failed.body.trim()), { ok: false, error: 'Ran on: Claude Code haiku\nboom' })

  const hanging = fakeRunner()
  hanging.run = (id, prompt) => { hanging.runs.push([id, prompt]) }
  const second = await setup(t, { routes: { dsh: { target: 'cl', model: 'claude:haiku', effort: null } }, claude: hanging })
  const secondToken = second.bridge.mcpServer('dsh', 'a', 'C:\\p').env.find((entry) => entry.name === 'AGENT_DESK_SUBAGENT_TOKEN').value
  const res = response()
  const done = endpoint(second.bridge)(request({ parent: 'dsh:a', token: secondToken, prompt: 'go' }), res, context)
  await new Promise((resolve) => setTimeout(resolve, 20))
  res.emit('close')
  hanging.emit('finished', { id: 's1', status: 'interrupted', text: '', error: null })
  await done
  assert.deepEqual(hanging.stopped, ['s1'])
  assert.deepEqual(hanging.removed, ['s1'])
})
