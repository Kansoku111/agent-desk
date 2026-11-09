import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import readline from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { bridgeTool, handleBridgeMcp } from '../server/subagent-bridge-mcp.js'

const script = fileURLToPath(new URL('../server/subagent-bridge-mcp.js', import.meta.url))
const tool = bridgeTool({ workspace: 'C:\\project', label: 'Claude haiku', note: 'billed to the user' })
const text = (reply) => reply.result.content[0].text

test('the tool names who runs it and how it is paid, so the model knows what it delegates to', () => {
  assert.equal(tool.name, 'subagent')
  assert.match(tool.description, /Claude haiku/)
  assert.match(tool.description, /billed to the user/)
  assert.match(tool.description, /C:\\project/)
  assert.deepEqual(tool.inputSchema.required, ['prompt'])
})

test('the protocol handler lists the tool, runs a call and reports a failure as a tool error', async () => {
  const calls = []
  const options = { tool, enabled: () => true, call: async (prompt, signal) => { calls.push(prompt); assert.ok(signal instanceof AbortSignal); return 'done' } }
  assert.deepEqual((await handleBridgeMcp({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, options)).result.protocolVersion, '2025-06-18')
  assert.deepEqual((await handleBridgeMcp({ id: 2, method: 'tools/list' }, options)).result.tools, [tool])
  assert.equal(text(await handleBridgeMcp({ id: 3, method: 'tools/call', params: { name: 'subagent', arguments: { prompt: ' look ' } } }, options)), 'done')
  assert.deepEqual(calls, ['look'])
  const failed = await handleBridgeMcp({ id: 4, method: 'tools/call', params: { name: 'subagent', arguments: { prompt: 'x' } } },
    { ...options, call: async () => { throw new Error('usage limit') } })
  assert.equal(failed.result.isError, true)
  assert.equal(text(failed), 'usage limit')
  assert.equal(text(await handleBridgeMcp({ id: 5, method: 'tools/call', params: { name: 'subagent', arguments: { prompt: '  ' } } }, options)), 'prompt is required')
  assert.equal((await handleBridgeMcp({ id: 6, method: 'tools/call', params: { name: 'other', arguments: {} } }, options)).error.code, -32602)
  assert.equal((await handleBridgeMcp({ id: 7, method: 'nope' }, options)).error.code, -32601)
  assert.equal(await handleBridgeMcp({ method: 'notifications/initialized' }, options), null)
  assert.equal(calls.length, 1)
})

test('turning subagents off hides the tool and refuses a call made with a stale list', async () => {
  const options = { tool, enabled: () => false, call: async () => assert.fail('must not run') }
  assert.deepEqual((await handleBridgeMcp({ id: 1, method: 'tools/list' }, options)).result.tools, [])
  const reply = await handleBridgeMcp({ id: 2, method: 'tools/call', params: { name: 'subagent', arguments: { prompt: 'go' } } }, options)
  assert.equal(reply.result.isError, true)
  assert.match(text(reply), /disabled/)
})

test('cancelling a request aborts the call that is running for it', async () => {
  const signals = new Map()
  let started
  const running = new Promise((resolve) => { started = resolve })
  const call = handleBridgeMcp({ id: 9, method: 'tools/call', params: { name: 'subagent', arguments: { prompt: 'long' } } }, {
    tool, enabled: () => true, signals,
    call: (_prompt, signal) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(new Error('aborted'))) }),
  })
  await running
  assert.equal(await handleBridgeMcp({ method: 'notifications/cancelled', params: { requestId: 9 } }, { tool, enabled: () => true, call: async () => '', signals }), null)
  assert.equal(text(await call), 'aborted')
  assert.equal(signals.size, 0)
})

/** Starts the bridge script with its stdio wired to an async line reader. */
function start(t, env) {
  const child = spawn(process.execPath, [script, '--workspace', 'C:\\project', '--label', 'Claude haiku', '--note', 'billed'], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const closed = once(child, 'close')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed })
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const read = async () => JSON.parse((await lines.next()).value)
  return { child, closed, read, write: (message) => child.stdin.write(`${JSON.stringify(message)}\n`) }
}

test('the process ignores non-object input and answers a malformed request with Invalid Request', { timeout: 10_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-bridge-mcp-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const mcp = start(t, { AGENT_DESK_HOME: home })
  mcp.child.stdin.write(['null', '[]', '42', JSON.stringify({ id: 'invalid' }), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })].join('\n') + '\n')
  assert.deepEqual(await mcp.read(), { jsonrpc: '2.0', id: 'invalid', error: { code: -32600, message: 'Invalid Request' } })
  assert.deepEqual(await mcp.read(), { jsonrpc: '2.0', id: 1, result: {} })
  mcp.child.stdin.end()
  assert.equal((await mcp.closed)[0], 0)
})

test('with subagents off in the settings the process lists no tool and refuses a stale call', { timeout: 10_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-bridge-mcp-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ subagentsEnabled: false }))
  const mcp = start(t, { AGENT_DESK_HOME: home })
  mcp.write({ id: 1, method: 'tools/list' })
  assert.deepEqual((await mcp.read()).result.tools, [])
  mcp.write({ id: 2, method: 'tools/call', params: { name: 'subagent', arguments: { prompt: 'must not start' } } })
  const reply = await mcp.read()
  assert.equal(reply.result.isError, true)
  assert.match(text(reply), /disabled/)
  mcp.child.stdin.end()
  assert.equal((await mcp.closed)[0], 0)
})

test('a call reaches Agent Desk with the task\'s identity, and the answer comes back through the heartbeat lines', { timeout: 10_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-bridge-mcp-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const bodies = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      bodies.push(JSON.parse(body))
      const prompt = bodies.at(-1).prompt
      if (prompt === 'forbidden') return res.writeHead(403).end('forbidden')
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('\n\n')
      res.end(`${JSON.stringify(prompt === 'fail' ? { ok: false, error: 'Ran on: X\nusage limit' } : { ok: true, text: 'Ran on: X\n\nthe report' })}\n`)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const mcp = start(t, {
    AGENT_DESK_HOME: home, AGENT_DESK_SUBAGENT_URL: `http://127.0.0.1:${server.address().port}/api/subagent`,
    AGENT_DESK_SUBAGENT_PARENT: 'cl:abc', AGENT_DESK_SUBAGENT_TOKEN: 'tok',
  })
  const call = (id, prompt) => mcp.write({ id, method: 'tools/call', params: { name: 'subagent', arguments: { prompt } } })
  call(1, 'review it')
  const ok = await mcp.read()
  assert.equal(text(ok), 'Ran on: X\n\nthe report')
  assert.equal(ok.result.isError, undefined)
  assert.deepEqual(bodies[0], { parent: 'cl:abc', token: 'tok', prompt: 'review it' })
  call(2, 'fail')
  const failed = await mcp.read()
  assert.equal(failed.result.isError, true)
  assert.match(text(failed), /usage limit/)
  call(3, 'forbidden')
  const refused = await mcp.read()
  assert.equal(refused.result.isError, true)
  assert.match(text(refused), /not allowed/)
  mcp.child.stdin.end()
  assert.equal((await mcp.closed)[0], 0)
})
