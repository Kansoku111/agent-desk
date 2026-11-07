// Real bundled Codex app-server, fake account and loopback Responses API only.
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { CodexWorkServer } from '../server/codex-work-server.js'
import { CodexRunner } from '../server/codex-runner.js'
import { setCatalogPricing } from '../server/usage.js'

test('real Codex notifications price each model response rather than the turn total', { timeout: 60000 }, async t => {
  const parent = path.resolve(os.tmpdir())
  const home = await fs.mkdtemp(path.join(parent, 'agent-desk-codex-usage-'))
  const cwd = path.join(home, 'workspace'); await fs.mkdir(cwd)
  let requests = 0, blocked = 0
  const mock = http.createServer(async (req, res) => {
    if (req.url !== '/v1/responses') { blocked++; res.writeHead(403).end(); return }
    let raw = Buffer.concat(await Array.fromAsync(req))
    if (req.headers['content-encoding'] === 'zstd') raw = zlib.zstdDecompressSync(raw)
    if (req.headers['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw)
    const body = JSON.parse(raw.toString('utf8'))
    requests++
    if (requests > 2) { res.writeHead(500).end(); return }
    const tool = { type: 'custom_tool_call', id: 'ct_local', call_id: 'call_local', name: 'exec', status: 'completed', input: 'text(\"local\")' }
    const item = { type: 'message', id: 'msg_local', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'offline', annotations: [] }] }
    const first = requests === 1, output = first ? tool : item
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'offline-test' })
    const send = data => res.write('data: ' + JSON.stringify(data) + '\n\n')
    send({ type: 'response.created', response: { id: 'resp_' + requests, object: 'response', created_at: 0, status: 'in_progress', model: body.model, output: [] } })
    send({ type: 'response.output_item.added', output_index: 0, item: first ? { ...tool, status: 'in_progress', input: '' } : { ...item, status: 'in_progress', content: [] } })
    if (first) {
      send({ type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: tool.id, delta: tool.input })
      send({ type: 'response.custom_tool_call_input.done', output_index: 0, item_id: tool.id, input: tool.input })
    } else {
      send({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      send({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'offline' })
      send({ type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text: 'offline' })
      send({ type: 'response.content_part.done', output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] })
    }
    send({ type: 'response.output_item.done', output_index: 0, item: output })
    send({ type: 'response.completed', response: { id: 'resp_' + requests, object: 'response', created_at: 0, status: 'completed', model: body.model, output: [output], usage: { input_tokens: 150000, output_tokens: 10, total_tokens: 150010, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
    res.end()
  })
  mock.on('connect', (_req, socket) => { blocked++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
  const origin = 'http://127.0.0.1:' + mock.address().port
  const overrides = [ 'model_provider=\"offline_usage\"', 'model_providers.offline_usage.name=\"Offline\"',
    'model_providers.offline_usage.base_url=' + JSON.stringify(origin + '/v1'), 'model_providers.offline_usage.env_key=\"OFFLINE_TOKEN\"',
    'model_providers.offline_usage.wire_api=\"responses\"', 'model_providers.offline_usage.requires_openai_auth=false',
    'model_providers.offline_usage.supports_websockets=false', 'model_providers.offline_usage.request_max_retries=0', 'model_providers.offline_usage.stream_max_retries=0' ].flatMap(x => ['-c', x])
  const actual = new CodexWorkServer({ home: path.join(home, 'codex-home'), cwd, spawn(command, args, options) {
    const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|CODEX_HOME|CODEX_MANAGED_BY_NPM)$/i.test(key)))
    Object.assign(env, { OFFLINE_TOKEN: 'dummy', HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, NO_PROXY: '127.0.0.1,localhost' })
    return spawn(command, [...overrides, ...args], { ...options, env })
  } })
  class Facade extends EventEmitter {
    constructor() { super(); for (const event of ['notification', 'request', 'stopped']) actual.on(event, (...args) => this.emit(event, ...args)) }
    use(fn) { return actual.use(fn) }
    rawRequest(method, params) {
      if (method === 'account/read') return Promise.resolve({ account: { type: 'chatgpt', email: 'mock@example.test' } })
      if (method === 'model/list') return Promise.resolve({ data: [{ model: 'gpt-6-luna', displayName: 'Mock', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] })
      return actual.rawRequest(method, params)
    }
    respond(id, result) { actual.respond(id, result) }
    reject(id, error) { actual.reject(id, error) }
    stop() { return actual.stop() }
  }
  const server = new Facade()
  setCatalogPricing({ 'openai-codex/gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }] } })
  const runner = await new CodexRunner({ home, attachmentsDir: home, server }).load()
  t.after(async () => { await runner.shutdown(); setCatalogPricing({}); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); assert.equal(path.dirname(home), parent); assert.match(path.basename(home), /^agent-desk-codex-usage-/); await fs.rm(home, { recursive: true, force: true }) })
  const task = await runner.create({ workspace: cwd, model: 'gpt-6-luna', effort: 'low', permissionMode: 'read-only' })
  const finished = once(runner, 'finished'); runner.run(task.id, 'Reply offline'); const [result] = await finished
  assert.equal(result.status, 'done')
  const usage = runner.turns(task.id)[0].usage
  assert.equal(usage.requests, 2)
  assert.equal(usage.requestsExact, true)
  assert.equal(usage.input, 300000)
  assert.equal(usage.output, 20)
  assert.ok(Math.abs(usage.score.points * 0.002 - 0.03001) < 1e-12)
  assert.equal(requests, 2)
  assert.equal(blocked, 0)
})
