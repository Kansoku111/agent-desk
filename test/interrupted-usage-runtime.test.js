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
