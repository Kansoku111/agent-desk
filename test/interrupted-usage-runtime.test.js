// Synthetic loopback API only: exercise the real dsh retry and durable-log path.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch, shippedPersona } from '../server/dsh-config.js'
import { localRoute } from '../server/local-llm.js'
import { appPaths } from '../server/paths.js'
import { AcpRuntime } from '../server/runtime.js'
import { decodeSessionLog, findSessionLog, turnUsage } from '../server/usage.js'

test('real dsh retry outcomes retain unavailable usage instead of silently costing zero', { timeout: 60000 }, async t => {
  const parent = path.resolve(os.tmpdir()), home = await fs.mkdtemp(path.join(parent, 'agent-desk-interrupted-runtime-'))
  const paths = appPaths(home), workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true }); await fs.mkdir(workspace)
  let calls = 0
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    if (++calls === 1) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fixture unavailable', type: 'server_error' } }))
      return
    }
    const base = { id: 'local-mock', object: 'chat.completion.chunk', created: 0, model: 'interrupted-fixture' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture reply' }, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const rows = YAML.parse(homePatch({ localRoute: localRoute({ baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', models: [{ id: 'interrupted-fixture' }] }), persona: await shippedPersona() }))
  rows.find(row => row.id === 'acp').config = { provider: 'local-llm', model: 'interrupted-fixture' }
  rows.find(row => row.id === 'llm-pi-ai').config.providers['local-llm'].retryPolicy = { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  const runtime = new AcpRuntime({ paths, mode: 'read-only', onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  t.after(async () => {
    await runtime.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(home), parent); assert.match(path.basename(home), /^agent-desk-interrupted-runtime-/)
    await fs.rm(home, { recursive: true, force: true })
  })
  await runtime.start()
  const session = await runtime.newSession(workspace).catch(error => { throw new Error(String(error) + '\n' + runtime.stderr, { cause: error }) }), since = Date.now() - 1000
  assert.equal((await runtime.prompt(session.sessionId, [{ type: 'text', text: 'fixture' }])).stopReason, 'end_turn', runtime.stderr)
  await runtime.stop()
  const file = await findSessionLog(paths.dshHome, session.sessionId)
  assert.ok(file)
  const events = decodeSessionLog(await fs.readFile(file))
  assert.equal(events.filter(e => e.type === 'assistant/attempt').length, 1)
  const total = await turnUsage({ dshHome: paths.dshHome, sessionId: session.sessionId, since, waitMs: 0 })
  assert.equal(calls, 2)
  assert.equal(total.requests, 2)
  assert.equal(total.interruptedRequests, 1)
  assert.equal(total.usageIncomplete, true)
  assert.equal(total.input, 100)
  assert.equal(total.output, 20)
  assert.ok(total.score.unpriced >= 1)
})

test('idle watchdog uses the existing retry policy without retrying cancellation', { timeout: 60000 }, async t => {
  const parent = path.resolve(os.tmpdir()), home = await fs.mkdtemp(path.join(parent, 'agent-desk-idle-runtime-'))
  const paths = appPaths(home), workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true }); await fs.mkdir(workspace)
  let calls = 0, mode = 'recover', requestSeen
  const base = { id: 'local-mock', object: 'chat.completion.chunk', created: 0, model: 'idle-fixture' }
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    calls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: mode === 'recover' && calls === 2 ? 'complete' : 'partial' }, finish_reason: null }] }) + '\n\n')
    requestSeen?.()
    if (mode === 'recover' && calls === 2) {
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      res.end('data: [DONE]\n\n')
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const rows = YAML.parse(homePatch({ localRoute: localRoute({ baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', models: [{ id: 'idle-fixture' }] }), persona: await shippedPersona() }))
  rows.find(row => row.id === 'acp').config = { provider: 'local-llm', model: 'idle-fixture' }
  const profile = rows.find(row => row.id === 'llm-pi-ai').config.providers['local-llm']
  // Leave headroom for loopback scheduling while the full real-runtime suite is busy.
  profile.streamIdleTimeoutMs = 1500
  profile.retryPolicy = { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  const runtime = new AcpRuntime({ paths, mode: 'read-only', onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  t.after(async () => {
    await runtime.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(home), parent); assert.match(path.basename(home), /^agent-desk-idle-runtime-/)
    await fs.rm(home, { recursive: true, force: true })
  })
  await runtime.start()
  const prompt = id => runtime.prompt(id, [{ type: 'text', text: 'fixture' }])
  const first = await runtime.newSession(workspace)
  assert.equal((await prompt(first.sessionId)).stopReason, 'end_turn', runtime.stderr)
  assert.equal(calls, 2, 'a stalled partial response is retried once')
  const firstLog = decodeSessionLog(await fs.readFile(await findSessionLog(paths.dshHome, first.sessionId)))
  assert.equal(firstLog.filter(e => e.type === 'assistant/attempt').length, 1)
  assert.equal(firstLog.filter(e => e.type === 'llm/retry').length, 1)

  mode = 'exhaust'; calls = 0
  const second = await runtime.newSession(workspace)
  await assert.rejects(prompt(second.sessionId), /idle timeout/i)
  assert.equal(calls, 2, 'retries stop at the configured limit')

  mode = 'cancel'; calls = 0
  const third = await runtime.newSession(workspace)
  const seen = new Promise(resolve => { requestSeen = resolve })
  const pending = prompt(third.sessionId)
  await seen
  await runtime.cancel(third.sessionId)
  const cancelled = await pending
  assert.equal(cancelled.stopReason, 'cancelled')
  assert.equal(calls, 1, 'user cancellation does not retry')
})

// The repetition guard stops a response mid-stream after an earlier call in it was already
// complete. A retry must not run that call: dsh executes tool calls only from a finished
// message, so the stopped response is kept as an attempt and the retry starts clean.
test('a response stopped by the repetition guard is retried without running its completed tool call', { timeout: 60000 }, async t => {
  const parent = path.resolve(os.tmpdir()), home = await fs.mkdtemp(path.join(parent, 'agent-desk-repeat-runtime-'))
  const paths = appPaths(home), workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true }); await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'input.txt'), 'fixture')
  let calls = 0
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    calls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = event => res.write('data: ' + JSON.stringify(event) + '\n\n')
    send({ type: 'response.created', response: { id: 'resp-' + calls, status: 'in_progress', output: [] } })
    if (calls === 1) {
      const tool = body.tools.find(entry => entry.name === 'read') ?? body.tools[0]
      const args = tool.name === 'read' ? JSON.stringify({ file_path: 'input.txt' }) : '{}'
      const done = { id: 'fc_done', type: 'function_call', call_id: 'call_done', name: tool.name, arguments: args, status: 'completed' }
      send({ type: 'response.output_item.added', output_index: 0, item: { ...done, arguments: '', status: 'in_progress' } })
      send({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_done', delta: args })
      send({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_done', arguments: args })
      send({ type: 'response.output_item.done', output_index: 0, item: done })
      send({ type: 'response.output_item.added', output_index: 1, item: { id: 'fc_loop', type: 'function_call', call_id: 'call_loop', name: tool.name, arguments: '', status: 'in_progress' } })
      send({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_loop', delta: '{"code":"x","data":[{"a":"b",' + '}]} (sic) '.repeat(20) })
      // How the guard's stop reaches the SDK: the stream fails with the guard's message.
      send({ type: 'error', code: 'stream', message: 'SIWC_TOOL_ARGUMENT_REPEAT: fixture loop' })
      res.end()
      return
    }
    const message = { id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'complete', annotations: [] }] }
    send({ type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } })
    send({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg', content_index: 0, delta: 'complete' })
    send({ type: 'response.output_item.done', output_index: 0, item: message })
    send({ type: 'response.completed', response: { id: 'resp-' + calls, status: 'completed', output: [message], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } })
    res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const rows = YAML.parse(homePatch({ localRoute: localRoute({ baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', models: [{ id: 'repeat-fixture' }] }), persona: await shippedPersona() }))
  rows.find(row => row.id === 'acp').config = { provider: 'local-llm', model: 'repeat-fixture' }
  const profile = rows.find(row => row.id === 'llm-pi-ai').config.providers['local-llm']
  // The SIWC route speaks the Responses API, where a call is complete before the response is.
  profile.api = 'openai-responses'
  delete profile.compat
  profile.retryPolicy = { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  const runtime = new AcpRuntime({ paths, mode: 'read-only', onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  t.after(async () => {
    await runtime.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(home), parent); assert.match(path.basename(home), /^agent-desk-repeat-runtime-/)
    await fs.rm(home, { recursive: true, force: true })
  })
  await runtime.start()
  const session = await runtime.newSession(workspace)
  assert.equal((await runtime.prompt(session.sessionId, [{ type: 'text', text: 'fixture' }])).stopReason, 'end_turn', runtime.stderr)
  assert.equal(calls, 2, 'the stopped response is retried once')
  const events = decodeSessionLog(await fs.readFile(await findSessionLog(paths.dshHome, session.sessionId)))
  const attempts = events.filter(e => e.type === 'assistant/attempt')
  assert.equal(attempts.length, 1)
  const ended = attempts[0].data.stream.filter(part => part.chunk?.type === 'block-end').map(part => part.chunk.block.type)
  assert.ok(ended.includes('tool-call'), 'the stopped response held a completed tool call: ' + ended.join(','))
  assert.equal(events.filter(e => e.type === 'tool/call' || e.type === 'tool/result').length, 0, 'no tool ran from the stopped response')
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 1)
})
