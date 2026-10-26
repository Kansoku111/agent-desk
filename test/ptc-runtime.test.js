// Real ACP + bundled PTC runtime; deterministic local responses, no provider API.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { AcpRuntime } from '../server/runtime.js'
import { appPaths } from '../server/paths.js'
import { homePatch } from '../server/dsh-config.js'
import { localRoute } from '../server/local-llm.js'
import { TOOL_MODE_CONFIG, toolModeOption } from '../server/ptc.js'

async function setup(t, mode) {
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
    const next = queue.shift()
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
  const rows = YAML.parse(homePatch({ localRoute: localRoute({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'ptc-fixture' }] }), subagentsEnabled: false }))
  rows.find((row) => row.id === 'acp').config = { provider: 'local-llm', model: 'ptc-fixture' }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  const permissions = []
  const runtime = new AcpRuntime({ mode, paths, onUpdate: (_id, update) => updates.push(update), onPermission: async (request) => {
    permissions.push(request)
    return { outcome: { outcome: 'cancelled' } }
  } })
  t.after(async () => {
    await runtime.stop()
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
  return { runtime, session, prompt, run, requests, updates, permissions, workspace, home, queue }
}

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

for (const mode of ['read-only', 'workspace-write']) {
  test(`real PTC direct Node writes respect ${mode} within fixture directories`, { timeout: 120_000 }, async (t) => {
    const f = await setup(t, mode)
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
