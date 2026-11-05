// Actual ACP/Cordis/MCP transports; all inference is a local deterministic stub.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import YAML from 'yaml'
import { AcpRuntime } from '../server/runtime.js'
import { appPaths } from '../server/paths.js'
import { homePatch, shippedPersona } from '../server/dsh-config.js'
import { localRoute } from '../server/local-llm.js'
import { TOOL_MODE_CONFIG } from '../server/ptc.js'
import { CACHE_DIAGNOSTICS_ENV } from '../server/gpt-cache-diagnostics.js'

async function fixture(t, diagnostics = false) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-mcp-start-'))
  const paths = appPaths(home), workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true }); await fs.mkdir(workspace)
  const events = new EventEmitter(), lists = [], closed = [], requests = [], queue = [], updates = []
  let call = 0
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/list') {
      lists.push({ name: url.searchParams.get('name'), pid: Number(url.searchParams.get('pid')), res, released: false })
      events.emit('change'); return
    }
    if (url.pathname === '/closed') {
      closed.push({ name: url.searchParams.get('name'), pid: Number(url.searchParams.get('pid')) })
      res.end('ok'); events.emit('change'); return
    }
    if (!url.pathname.startsWith('/v1/')) { res.writeHead(404); res.end(); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    requests.push(JSON.parse(raw))
    const plan = queue.shift()
    const base = { id: 'fixture-' + requests.length, object: 'chat.completion.chunk', created: 0, model: 'fixture' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + String.fromCharCode(10).repeat(2))
    if (plan) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + ++call, type: 'function', function: { name: plan.name, arguments: JSON.stringify(plan.args) } }] })
      send({}, 'tool_calls')
    } else { send({ role: 'assistant', content: 'fixture complete' }); send({}, 'stop') }
    res.end('data: [DONE]' + String.fromCharCode(10).repeat(2))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const control = 'http://127.0.0.1:' + server.address().port
  const script = path.join(home, 'fake-mcp.mjs')
  const lines = [
    'import readline from "node:readline"',
    'const name = process.argv[2], control = process.argv[3]',
    'const send = value => process.stdout.write(JSON.stringify(value)+String.fromCharCode(10))',
    'process.stdin.once("end",async()=>{try{await fetch(control+"/closed?name="+name+"&pid="+process.pid)}finally{process.exit(0)}})',
    'for await (const line of readline.createInterface({input:process.stdin})) {',
    'const request=JSON.parse(line); if(request.id===undefined)continue; let result;',
    'try { if(request.method==="initialize") result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name,version:"1"},instructions:"Fixture "+name};',
    'else if(request.method==="tools/list"){const r=await fetch(control+"/list?name="+name+"&pid="+process.pid);const plan=await r.json();if(plan.fail)throw new Error("fixture list failure");result={tools:[{name:"ping",description:"Fixture ping",inputSchema:{type:"object",properties:{}}}]};}',
    'else if(request.method==="tools/call") result={content:[{type:"text",text:name+"-pong"}]}; else result={};',
    'send({jsonrpc:"2.0",id:request.id,result}); } catch(error){send({jsonrpc:"2.0",id:request.id,error:{code:-32603,message:error.message}})}',
    '}',
  ]
  await fs.writeFile(script, lines.join(String.fromCharCode(10)))
  const rows = YAML.parse(homePatch({ localRoute: localRoute({ baseURL: control + '/v1', models: [{ id: 'fixture' }] }), subagentsEnabled: false, subagents: [], persona: await shippedPersona() }))
  rows.find(row => row.id === 'acp').config = { provider: 'local-llm', model: 'fixture' }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  const runtime = new AcpRuntime({ mode: 'workspace-write', paths, onUpdate: (_id, update) => updates.push(update), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  t.after(async () => {
    for (const item of lists) if (!item.released && !item.res.destroyed) item.res.end('{}')
    await runtime.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(home), os.tmpdir()); await fs.rm(home, { recursive: true, force: true })
  })
  const diagnosticsDir = path.join(home, 'diagnostics')
  const previous = process.env[CACHE_DIAGNOSTICS_ENV]
  try {
    if (diagnostics) process.env[CACHE_DIAGNOSTICS_ENV] = diagnosticsDir
    else delete process.env[CACHE_DIAGNOSTICS_ENV]
    await runtime.start()
  } finally {
    if (previous === undefined) delete process.env[CACHE_DIAGNOSTICS_ENV]
    else process.env[CACHE_DIAGNOSTICS_ENV] = previous
  }
  const wait = async predicate => {
    while (!predicate()) await once(events, 'change')
  }
  const release = (name, fail = false) => {
    const item = lists.find(item => item.name === name && !item.released)
    assert.ok(item, 'server has entered tools/list: ' + name)
    item.released = true; item.res.end(JSON.stringify({ fail }))
  }
  const servers = ['chrome', 'desktop'].map(name => ({ name, command: process.execPath, args: [script, name, control], env: [] }))
  const prompt = sessionId => runtime.prompt(sessionId, [{ type: 'text', text: 'fixture request' }])
  return { runtime, workspace, servers, lists, closed, requests, queue, updates, wait, release, prompt, diagnosticsDir }
}

test('real new/resume overlaps MCP discovery and preserves native/PTC capabilities and call targets', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const creating = f.runtime.newSession(f.workspace, f.servers)
  await f.wait(() => f.lists.length === 2)
  assert.equal(f.runtime.liveSessions.size, 0, 'unpublished until both discoveries finish')
  f.release('desktop'); f.release('chrome')
  const session = await creating
  f.queue.push({ name: 'mcp__chrome__ping', args: {} })
  await f.prompt(session.sessionId)
  const native = f.requests[0].tools.map(tool => tool.function.name)
  assert.ok(native.includes('mcp__chrome__ping')); assert.ok(native.includes('mcp__desktop__ping'))
  assert.match(JSON.stringify(f.requests[1].messages.filter(message => message.role === 'tool')), /chrome-pong/)
  await f.runtime.setOption(session.sessionId, TOOL_MODE_CONFIG, 'ptc')
  f.queue.push({ name: 'run_code', args: { code: 'return await tools.mcp__desktop__ping({})', description: 'Run local MCP fixture' } })
  await f.prompt(session.sessionId)
  assert.match(JSON.stringify(f.requests.at(-1).messages.filter(message => message.role === 'tool')), /desktop-pong/)
  const before = f.lists.length
  await f.runtime.closeSession(session.sessionId)
  await f.wait(() => f.closed.length === 2)
  const resuming = f.runtime.resumeSession(session.sessionId, f.workspace, f.servers)
  await f.wait(() => f.lists.length === before + 2)
  f.release('chrome'); f.release('desktop')
  await resuming
  await f.runtime.setOption(session.sessionId, TOOL_MODE_CONFIG, 'native')
  await f.prompt(session.sessionId)
  assert.deepEqual(f.requests.at(-1).tools.map(tool => tool.function.name), native, 'completion order does not change model-facing declarations')
  await f.runtime.closeSession(session.sessionId)
  await f.wait(() => f.closed.length === 4)
})

test('actual ACP diagnostics observe notification return without claiming UI delivery or copying text', { timeout: 30000 }, async t => {
  const f = await fixture(t, true)
  const session = await f.runtime.newSession(f.workspace, [])
  await f.prompt(session.sessionId)
  const answers = f.updates.filter(update => update.sessionUpdate === 'agent_message_chunk' && update.content?.text)
  assert.deepEqual(answers.map(update => update.content.text), ['fixture complete'])
  await f.runtime.stop()
  const files = await fs.readdir(f.diagnosticsDir)
  const records = (await Promise.all(files.map(file => fs.readFile(path.join(f.diagnosticsDir, file), 'utf8')))).flatMap(text => text.trim().split(String.fromCharCode(10)).map(JSON.parse))
  const delivery = records.find(record => record.event === 'delivery')
  assert.ok(delivery)
  assert.equal(delivery.deliveryStatus, 'unconfirmed')
  for (const key of ['firstTextMs', 'lastTextMs', 'firstNotifyMs', 'lastNotifyMs', 'lastNotifyReturnedMs', 'finishedMs']) assert.equal(typeof delivery.timing[key], 'number', key)
  assert.ok(delivery.timing.lastNotifyReturnedMs >= delivery.timing.lastNotifyMs)
  assert.doesNotMatch(JSON.stringify(records), /fixture complete|fixture request/)
})

test('real cancellation during discovery closes all stdio servers and permits a later session', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const creating = f.runtime.conn.connection.sendRequest('session/new', { cwd: f.workspace, mcpServers: f.servers }, undefined, { cancellationSignal: controller.signal })
  await f.wait(() => f.lists.length === 2)
  controller.abort(new Error('fixture cancellation'))
  await assert.rejects(creating)
  await f.wait(() => f.closed.length === 2)
  const session = await f.runtime.newSession(f.workspace, [])
  await f.runtime.closeSession(session.sessionId)
  assert.equal(f.requests.length, 0)
})

test('real discovery failure closes a pending stdio sibling before returning and the runtime recovers', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const creating = f.runtime.newSession(f.workspace, f.servers)
  await f.wait(() => f.lists.length === 2)
  f.release('chrome', true)
  await assert.rejects(creating, error => error.code === -32603 && error.message === 'Internal error')
  assert.equal(f.closed.length, 2, 'all spawned servers closed before the failed session returns')
  assert.equal(f.runtime.liveSessions.size, 0)
  const next = f.runtime.newSession(f.workspace, [])
  const session = await next
  assert.ok(session.sessionId)
  await f.runtime.closeSession(session.sessionId)
  assert.equal(f.requests.length, 0, 'setup failure never calls the model')
})
