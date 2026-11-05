import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { commandCodeRoutes } from '../server/command-code.js'
import { CredentialStore, COMMAND_CODE_REF } from '../server/credentials.js'
import { homePatch } from '../server/dsh-config.js'
import { appPaths } from '../server/paths.js'
import { AcpRuntime } from '../server/runtime.js'

const flash = 'deepseek/deepseek-v4.1-flash'
const model = (id, contextWindow, endpoint = 'chat') => ({ id, name: id, contextWindow, endpoint })

test('known models get their output budgets without changing others', () => {
  const routes = commandCodeRoutes([model(flash, 1000000), model('deepseek/deepseek-v4.1-flash-fast', 1000000), model('claude-test', 200000, 'messages'), model('claude-haiku-5-5', 1000000, 'messages')])
  assert.equal(routes['command-code'].models[0].maxTokens, 65536)
  assert.equal(routes['command-code'].models[1].maxTokens, 8192)
  assert.equal(routes['command-code-claude'].models[0].maxTokens, 8192)
  assert.equal(routes['command-code-claude'].models[1].maxTokens, 128000)
  assert.equal(commandCodeRoutes([model('claude-haiku-5-5', 200000, 'messages')])['command-code-claude'].models[0].maxTokens, 50000)
  assert.equal(routes['command-code'].defaultMaxTokens, 8192)
  assert.equal(commandCodeRoutes([model(flash, 100000)])['command-code'].models[0].maxTokens, 25000)
})

test('DSH sends the larger budget to the Command Code chat endpoint', { timeout: 90000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-command-output-'))
  const paths = appPaths(home)
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true })
  await fs.mkdir(workspace)
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push(JSON.parse(raw))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: 'mock', object: 'chat.completion.chunk', created: 0, model: flash }
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const routes = commandCodeRoutes([model(flash, 1000000)], { root: 'http://127.0.0.1:' + server.address().port + '/provider' })
  const rows = YAML.parse(homePatch({ commandCodeRoutes: routes }))
  rows.find((row) => row.id === 'acp').config = { provider: 'command-code', model: flash }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  await new CredentialStore(paths.credentials).setRef(COMMAND_CODE_REF, 'fixture-not-a-real-key')
  const runtime = new AcpRuntime({ mode: 'read-only', paths, onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  t.after(async () => {
    await runtime.stop()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.equal(path.dirname(home), os.tmpdir())
    await fs.rm(home, { recursive: true, force: true })
  })
  await runtime.start()
  const session = await runtime.newSession(workspace)
  await runtime.setOption(session.sessionId, 'reasoning_effort', 'max')
  const result = await runtime.prompt(session.sessionId, [{ type: 'text', text: 'fixture prompt' }])
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, flash)
  assert.equal(requests[0].reasoning_effort, 'max')
  assert.equal(requests[0].max_tokens, 65536)
})

test('DSH sends the Haiku output budget to the Messages endpoint', { timeout: 90000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-haiku-output-'))
  const paths = appPaths(home)
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true })
  await fs.mkdir(workspace)
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push(JSON.parse(raw))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, obj) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...obj }) + '\n\n')
    send('message_start', { message: { id: 'mock', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
    send('content_block_stop', { index: 0 })
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    send('message_stop', {})
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const routes = commandCodeRoutes([model('claude-haiku-5-5', 1000000, 'messages')], { root: 'http://127.0.0.1:' + server.address().port + '/provider' })
  const rows = YAML.parse(homePatch({ commandCodeRoutes: routes }))
  rows.find((row) => row.id === 'acp').config = { provider: 'command-code-claude', model: 'claude-haiku-5-5' }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  await new CredentialStore(paths.credentials).setRef(COMMAND_CODE_REF, 'fixture-not-a-real-key')
  const runtime = new AcpRuntime({ mode: 'read-only', paths, onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  t.after(async () => {
    await runtime.stop()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.equal(path.dirname(home), os.tmpdir())
    await fs.rm(home, { recursive: true, force: true })
  })
  await runtime.start()
  const session = await runtime.newSession(workspace)
  const result = await runtime.prompt(session.sessionId, [{ type: 'text', text: 'fixture prompt' }])
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'claude-haiku-5-5')
  assert.equal(requests[0].max_tokens, 128000)
})
