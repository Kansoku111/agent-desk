// Real DSH against a local Messages endpoint; no provider account or model calls.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { CredentialStore, ANTHROPIC_REF } from '../server/credentials.js'
import { homePatch } from '../server/dsh-config.js'
import { configuredModelCatalog } from '../server/model-catalog.js'
import { appPaths } from '../server/paths.js'
import { AcpRuntime } from '../server/runtime.js'

const id = 'claude-fable-5-2'

test('Fable 5.2 reaches Messages with adaptive thinking and the selected effort', { timeout: 90000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-fable-'))
  const paths = appPaths(home)
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true })
  await fs.mkdir(workspace)
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ url: req.url, body: JSON.parse(raw) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, obj) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...obj }) + '\n\n')
    send('message_start', { message: { id: 'mock', type: 'message', role: 'assistant', model: id, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture reply' } })
    send('content_block_stop', { index: 0 })
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
    send('message_stop', {})
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { definitions } = await configuredModelCatalog()
  const rows = YAML.parse(homePatch({ catalogModels: definitions }))
  rows.find((row) => row.id === 'llm-pi-ai').config.providers.anthropic.baseURL = `http://127.0.0.1:${server.address().port}`
  rows.find((row) => row.id === 'acp').config = { provider: 'anthropic', model: id }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  await new CredentialStore(paths.credentials).setRef(ANTHROPIC_REF, 'fixture-not-a-real-key')
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
  const options = await runtime.setOption(session.sessionId, 'reasoning_effort', 'low')
  assert.equal(options.find((option) => option.id === 'reasoning_effort')?.currentValue, 'low')
  const result = await runtime.prompt(session.sessionId, [{ type: 'text', text: 'fixture prompt' }])
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(requests.length, 1)
  assert.equal(new URL(requests[0].url, 'http://localhost').pathname, '/v1/messages')
  assert.equal(requests[0].body.model, id)
  assert.equal(requests[0].body.thinking?.type, 'adaptive')
  assert.equal(requests[0].body.output_config?.effort, 'low')
  assert.equal(requests[0].body.temperature, undefined)
})
