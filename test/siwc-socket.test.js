import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { createCacheDiagnostics } from '../server/gpt-cache-diagnostics.js'
import { SIWC_RESOURCE } from '../server/siwc-client.js'
import { requireCompleted, withSiwc } from '../server/siwc-request.js'
import { configuredSiwcSocket, createSiwcSocket, SIWC_SOCKET_URL } from '../server/siwc-socket.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REQUEST_URL = `${SIWC_RESOURCE}/responses`
const COMPLETED = [
  { type: 'response.created', response: { id: 'r1' } },
  { type: 'response.output_text.delta', delta: '答え' },
  { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 5, output_tokens: 1 } } },
]
const model = { id: 'gpt-6-luna', provider: 'openai-codex', api: 'openai-responses', baseUrl: SIWC_RESOURCE, reasoning: true }

/** A real local WebSocket server; `reply(message, socket)` scripts each request. */
async function server(t, reply = (_, socket) => { for (const event of COMPLETED) socket.send(JSON.stringify(event)) }) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(wss, 'listening')
  const state = { connections: [], requests: [], reply, closed: 0 }
  wss.on('connection', (socket, request) => {
    state.connections.push({ authorization: request.headers.authorization, agent: request.headers['user-agent'] })
    socket.on('close', () => state.closed++)
    socket.on('message', data => {
      const message = JSON.parse(data.toString())
      state.requests.push(message)
      state.reply(message, socket)
    })
  })
  t.after(() => new Promise(resolve => {
    for (const client of wss.clients) client.terminate()
    wss.close(resolve)
  }))
  return { ...state, state, url: `ws://127.0.0.1:${wss.address().port}` }
}
function pipe(t, local, options) {
  const socket = createSiwcSocket({ url: local.url, ...options })
  t.after(() => socket.close())
  return socket
}
function request(signal, body = { model: 'gpt-6-luna', stream: true, store: false, input: [{ role: 'user', content: 'こんにちは' }] }, token = 'Bearer token-1') {
  return { method: 'POST', headers: new Headers({ authorization: token, 'user-agent': 'Agent-Desk-SIWC/0.1', 'content-type': 'application/json' }), body: JSON.stringify(body), signal }
}
function httpSpy(response = () => new Response('http-body')) {
  const calls = []
  const http = async (url, init) => {
    calls.push({ url, init })
    return response()
  }
  return { calls, http }
}
const parseSse = text => text.split('\n\n').filter(Boolean).map(block => JSON.parse(block.split('\n').find(line => line.startsWith('data:')).slice(5)))

test('the pipe targets the official endpoint', () => {
  assert.equal(SIWC_SOCKET_URL, 'wss://api.openai.com/v1/responses')
})

test('a request reaches the socket unchanged except transport fields and returns the same SSE stream', async t => {
  const local = await server(t)
  const { http, calls } = httpSpy()
  const used = []
  const socket = pipe(t, local)
  const init = request(undefined, { model: 'gpt-6-luna', stream: true, background: false, store: false, input: [{ role: 'user', content: 'こんにちは' }], prompt_cache_key: 'k' })
  const response = await socket.send(REQUEST_URL, init, { key: 's1', http, used: kind => used.push(kind) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const text = await requireCompleted(response).text()
  assert.match(text, /^event: response\.created\ndata: /)
  assert.deepEqual(parseSse(text), COMPLETED)
  assert.deepEqual(local.state.requests, [{ type: 'response.create', model: 'gpt-6-luna', store: false, input: [{ role: 'user', content: 'こんにちは' }], prompt_cache_key: 'k' }])
  assert.deepEqual(local.state.connections, [{ authorization: 'Bearer token-1', agent: 'Agent-Desk-SIWC/0.1' }])
  assert.deepEqual(used, ['websocket'])
  assert.equal(calls.length, 0)
})

test('later requests reuse the connection and still send the whole input', async t => {
  const local = await server(t)
  const socket = pipe(t, local)
  const { http } = httpSpy()
  const input = [{ role: 'user', content: 'a' }]
  await (await socket.send(REQUEST_URL, request(undefined, { input }), { key: 's1', http })).text()
  const longer = [...input, { type: 'function_call_output', call_id: 'c', output: 'x' }]
  await (await socket.send(REQUEST_URL, request(undefined, { input: longer }), { key: 's1', http })).text()
  assert.equal(local.state.connections.length, 1)
  assert.deepEqual(local.state.requests.map(item => item.input), [input, longer])
  assert.ok(local.state.requests.every(item => !('previous_response_id' in item)))
})

test('sessions do not share a connection, and a new token never uses the old one', async t => {
  const local = await server(t)
  const socket = pipe(t, local)
  const { http } = httpSpy()
  await (await socket.send(REQUEST_URL, request(), { key: 's1', http })).text()
  await (await socket.send(REQUEST_URL, request(), { key: 's2', http })).text()
  assert.equal(local.state.connections.length, 2)
  await (await socket.send(REQUEST_URL, request(undefined, undefined, 'Bearer token-2'), { key: 's1', http })).text()
  assert.equal(local.state.connections.length, 3)
  assert.equal(local.state.connections[2].authorization, 'Bearer token-2')
})

test('a connection past the service age limit is replaced before it can fail a request', async t => {
  const local = await server(t)
  let clock = 1_000
  const socket = pipe(t, local, { now: () => clock, maxAgeMs: 100 })
  const { http } = httpSpy()
  await (await socket.send(REQUEST_URL, request(), { key: 's1', http })).text()
  clock += 100
  await (await socket.send(REQUEST_URL, request(), { key: 's1', http })).text()
  assert.equal(local.state.connections.length, 2)
})

test('calls without a session and calls overlapping a busy session stay on HTTP', async t => {
  const local = await server(t, (_, client) => { client.send(JSON.stringify(COMPLETED[0])) })
  const socket = pipe(t, local)
  const { http, calls } = httpSpy()
  const used = []
  await socket.send(REQUEST_URL, request(), { key: undefined, http, used: kind => used.push(kind) })
  assert.equal(local.state.connections.length, 0)
  const first = await socket.send(REQUEST_URL, request(), { key: 's1', http })
  await socket.send(REQUEST_URL, request(), { key: 's1', http, used: kind => used.push(kind) })
  assert.deepEqual(used, ['http', 'http'])
  assert.equal(calls.length, 2)
  assert.equal(local.state.requests.length, 1)
  await first.body.cancel()
})

test('a refused connection falls back to HTTP and is not retried during the cooldown', async () => {
  let clock = 1_000, attempts = 0
  const socket = createSiwcSocket({
    now: () => clock,
    cooldownMs: 50,
    open: async () => {
      attempts++
      throw new Error('unexpected server response: 403')
    }
  })
  const { http, calls } = httpSpy()
  const used = []
  const options = { key: 's1', http, used: kind => used.push(kind) }
  assert.equal(await (await socket.send(REQUEST_URL, request(), options)).text(), 'http-body')
  await socket.send(REQUEST_URL, request(), options)
  assert.equal(attempts, 1)
  clock += 50
  await socket.send(REQUEST_URL, request(), options)
  assert.equal(attempts, 2)
  assert.deepEqual(used, ['http', 'http', 'http'])
  assert.equal(calls.length, 3)
})

test('a message over the service size limit goes to HTTP, and larger ones skip the failed attempt', async t => {
  const local = await server(t, (_, client) => client.close(1009))
  const socket = pipe(t, local)
  const { http, calls } = httpSpy()
  const big = { input: [{ role: 'user', content: 'x'.repeat(1000) }] }
  assert.equal(await (await socket.send(REQUEST_URL, request(undefined, big), { key: 's1', http })).text(), 'http-body')
  await socket.send(REQUEST_URL, request(undefined, big), { key: 's1', http })
  assert.equal(local.state.requests.length, 1)
  assert.equal(calls.length, 2)
  local.state.reply = (_, client) => { for (const event of COMPLETED) client.send(JSON.stringify(event)) }
  const small = await socket.send(REQUEST_URL, request(undefined, { input: [] }), { key: 's1', http })
  assert.equal(small.headers.get('content-type'), 'text/event-stream')
  await small.text()
})

test('a close before any event falls back to HTTP; only a new socket failing starts the cooldown', async t => {
  const local = await server(t)
  const socket = pipe(t, local)
  const { http, calls } = httpSpy()
  await (await socket.send(REQUEST_URL, request(), { key: 's1', http })).text()
  local.state.reply = (_, client) => client.terminate()
  assert.equal(await (await socket.send(REQUEST_URL, request(), { key: 's1', http })).text(), 'http-body')
  assert.equal(calls.length, 1)
  local.state.reply = (_, client) => { for (const event of COMPLETED) client.send(JSON.stringify(event)) }
  const next = await socket.send(REQUEST_URL, request(), { key: 's1', http })
  assert.equal(next.headers.get('content-type'), 'text/event-stream')
  await next.text()
  assert.equal(local.state.connections.length, 2)
  local.state.reply = (_, client) => client.terminate()
  await socket.send(REQUEST_URL, request(), { key: 'fresh', http })
  await socket.send(REQUEST_URL, request(), { key: 'other', http })
  assert.equal(local.state.connections.length, 3)
})

test('a socket that looks open but never answers gives way to HTTP instead of waiting out the stream limit', async t => {
  const local = await server(t)
  const socket = pipe(t, local, { firstEventMs: 30 })
  const { http, calls } = httpSpy()
  await (await socket.send(REQUEST_URL, request(), { key: 's1', http })).text()
  local.state.reply = () => {}
  assert.equal(await (await socket.send(REQUEST_URL, request(), { key: 's1', http })).text(), 'http-body')
  assert.equal(calls.length, 1)
  while (!local.state.closed) await new Promise(resolve => setTimeout(resolve, 5))
  local.state.reply = (_, client) => { for (const event of COMPLETED) client.send(JSON.stringify(event)) }
  const next = await socket.send(REQUEST_URL, request(), { key: 's1', http })
  assert.equal(next.headers.get('content-type'), 'text/event-stream', 'a reused socket going quiet does not cool the pipe down')
  await next.text()
  assert.equal(local.state.connections.length, 2)
})

test('errors keep their HTTP meaning: status, retry headers and the usage-limit rewrite', async t => {
  const limit = { type: 'error', status: 429, headers: { 'retry-after': '7', authorization: 'never' }, error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'raw' } }
  const local = await server(t, (_, client) => client.send(JSON.stringify(limit)))
  const options = withSiwc(model, { sessionId: 's1' }, { client: { auth: async () => ({ access_token: 'token-1' }) }, diagnostics: null, socket: pipe(t, local) })
  const response = await options.fetch(REQUEST_URL, { method: 'POST', body: JSON.stringify({ input: [], stream: true }) })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '7')
  assert.equal(response.headers.get('authorization'), null)
  assert.match((await response.json()).error.message, /利用上限/)
})

test('a server error surfaces as that status and the connection is not reused', async t => {
  const local = await server(t, (_, client) => client.send(JSON.stringify({ type: 'error', status: 503, error: { message: 'busy' } })))
  const socket = pipe(t, local)
  const { http, calls } = httpSpy()
  const response = await socket.send(REQUEST_URL, request(), { key: 's1', http })
  assert.equal(response.status, 503)
  assert.equal(calls.length, 0)
  while (!local.state.closed) await new Promise(resolve => setTimeout(resolve, 5))
  await socket.send(REQUEST_URL, request(), { key: 's1', http })
  assert.equal(local.state.connections.length, 2)
})

test('a 400 from the socket is answered by HTTP, so a pipe-only rejection cannot fail the request', async t => {
  const local = await server(t, (_, client) => client.send(JSON.stringify({ type: 'error', status: 400, error: { message: 'not on this transport' } })))
  const socket = pipe(t, local)
  const { http, calls } = httpSpy(() => new Response('{"error":{"message":"real answer"}}', { status: 400 }))
  const used = []
  const response = await socket.send(REQUEST_URL, request(), { key: 's1', http, used: kind => used.push(kind) })
  assert.equal(await response.text(), '{"error":{"message":"real answer"}}')
  assert.equal(calls.length, 1)
  await socket.send(REQUEST_URL, request(), { key: 's1', http, used: kind => used.push(kind) })
  assert.equal(local.state.requests.length, 1, 'no repeat attempt during the cooldown')
  assert.deepEqual(used, ['http', 'http'])
})

test('the 60-minute limit error is retried on HTTP', async t => {
  const local = await server(t, (_, client) => client.send(JSON.stringify({ type: 'error', status: 400, error: { code: 'websocket_connection_limit_reached', message: 'limit' } })))
  const socket = pipe(t, local)
  const { http, calls } = httpSpy()
  assert.equal(await (await socket.send(REQUEST_URL, request(), { key: 's1', http })).text(), 'http-body')
  assert.equal(calls.length, 1)
})

test('a close mid-response is the same retryable interruption as HTTP', async t => {
  const local = await server(t, (_, client) => {
    client.send(JSON.stringify(COMPLETED[1]))
    setTimeout(() => client.terminate(), 10)
  })
  const socket = pipe(t, local)
  const { http, calls } = httpSpy()
  const response = requireCompleted(await socket.send(REQUEST_URL, request(), { key: 's1', http }))
  await assert.rejects(response.text(), /SIWC stream did not complete \(interrupted\)/)
  assert.equal(calls.length, 0)
})

test('an error event mid-response reaches the SDK and the connection is dropped', async t => {
  const local = await server(t, (_, client) => {
    client.send(JSON.stringify(COMPLETED[1]))
    client.send(JSON.stringify({ type: 'error', status: 500, error: { message: 'boom' } }))
  })
  const socket = pipe(t, local)
  const { http } = httpSpy()
  const events = parseSse(await (await socket.send(REQUEST_URL, request(), { key: 's1', http })).text())
  assert.equal(events.at(-1).type, 'error')
  await socket.send(REQUEST_URL, request(), { key: 's1', http }).then(response => response.text())
  assert.equal(local.state.connections.length, 2)
})

test('aborting before the first event rejects like fetch and closes the connection', async t => {
  const local = await server(t, () => {})
  const socket = pipe(t, local)
  const { http, calls } = httpSpy()
  const controller = new AbortController()
  const reason = new Error('stopped')
  const pending = socket.send(REQUEST_URL, request(controller.signal), { key: 's1', http })
  while (!local.state.requests.length) await new Promise(resolve => setTimeout(resolve, 5))
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  assert.equal(calls.length, 0)
  while (!local.state.closed) await new Promise(resolve => setTimeout(resolve, 5))
})

test('aborting mid-response errors the stream and closes the connection, so generation stops', async t => {
  const local = await server(t, (_, client) => client.send(JSON.stringify(COMPLETED[0])))
  const socket = pipe(t, local)
  const { http } = httpSpy()
  const controller = new AbortController()
  const reason = new Error('stopped')
  const response = await socket.send(REQUEST_URL, request(controller.signal), { key: 's1', http })
  const reader = response.body.getReader()
  await reader.read()
  controller.abort(reason)
  await assert.rejects(reader.read(), error => error === reason)
  while (!local.state.closed) await new Promise(resolve => setTimeout(resolve, 5))
})

test('a reader cancelling mid-response closes the connection, and a later session request reconnects', async t => {
  const local = await server(t, (_, client) => client.send(JSON.stringify(COMPLETED[0])))
  const socket = pipe(t, local)
  const { http } = httpSpy()
  const response = await socket.send(REQUEST_URL, request(), { key: 's1', http })
  await response.body.cancel()
  while (!local.state.closed) await new Promise(resolve => setTimeout(resolve, 5))
  await socket.send(REQUEST_URL, request(), { key: 's1', http }).then(next => next.body.cancel())
  assert.equal(local.state.connections.length, 2)
})

test('a connection idle past the limit is closed', async t => {
  const local = await server(t)
  const socket = pipe(t, local, { idleMs: 20 })
  const { http } = httpSpy()
  await (await socket.send(REQUEST_URL, request(), { key: 's1', http })).text()
  while (!local.state.closed) await new Promise(resolve => setTimeout(resolve, 5))
})

test('withSiwc sends through the pipe with the latest token, and diagnostics record the transport', async t => {
  const local = await server(t)
  const records = []
  const diagnostics = createCacheDiagnostics({ write: line => records.push(JSON.parse(line)), onStop() {} })
  const options = withSiwc(model, { sessionId: 's1' }, { client: { auth: async () => ({ access_token: 'token-1' }) }, diagnostics, socket: pipe(t, local) })
  const response = await options.fetch(REQUEST_URL, { method: 'POST', body: JSON.stringify({ input: [{ role: 'system', content: 'x' }], temperature: 1, stream: true }) })
  await response.text()
  await diagnostics.flush()
  assert.equal(local.state.connections[0].authorization, 'Bearer token-1')
  assert.equal(local.state.connections[0].agent, 'Agent-Desk-SIWC/0.1')
  assert.equal(local.state.requests[0].temperature, undefined)
  assert.equal(local.state.requests[0].input[0].role, 'developer')
  const result = records.find(record => record.event === 'result')
  assert.equal(result.transport, 'websocket')
  assert.equal(result.outcome, 'completed')
  assert.ok(result.timing.firstEventMs !== null)
  assert.equal(JSON.stringify(records).includes('token-1'), false)
})

test('a supplied fetch owns the transport, and the environment switch selects HTTP', async () => {
  const sent = []
  const options = withSiwc(model, { sessionId: 's1' }, {
    client: { auth: async () => ({ access_token: 'token-1' }) },
    diagnostics: null,
    fetch: async (_url, init) => {
      sent.push(init.body)
      return new Response('data: {"type":"response.completed"}\n\n')
    }
  })
  await (await options.fetch(REQUEST_URL, { method: 'POST', body: '{"input":[]}' })).text()
  assert.equal(sent.length, 1)
  const before = process.env.AGENT_DESK_SIWC_TRANSPORT
  try {
    process.env.AGENT_DESK_SIWC_TRANSPORT = 'http'
    assert.equal(configuredSiwcSocket(), null)
    delete process.env.AGENT_DESK_SIWC_TRANSPORT
    assert.ok(configuredSiwcSocket())
  } finally {
    if (before === undefined) delete process.env.AGENT_DESK_SIWC_TRANSPORT
    else process.env.AGENT_DESK_SIWC_TRANSPORT = before
  }
})

test('an idle connection does not keep a finished process alive', async t => {
  const local = await server(t)
  const module = pathToFileURL(path.join(ROOT, 'server/siwc-socket.js')).href
  const script = `
    import { createSiwcSocket } from ${JSON.stringify(module)}
    const socket = createSiwcSocket({ url: ${JSON.stringify(local.url)} })
    const response = await socket.send('x', { body: '{"input":[]}', headers: { authorization: 'Bearer t', 'user-agent': 'u' } }, { key: 's', http: fetch })
    await response.text()
    console.log('done')
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => child.kill())
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  const [code] = await Promise.race([
    once(child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('process stayed alive on the idle socket')), 8000).unref()),
  ])
  assert.equal(code, 0)
  assert.match(output, /done/)
})
