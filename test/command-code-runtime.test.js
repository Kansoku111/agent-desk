// Real DSH/ACP against local mock endpoints; no provider account or model calls.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { CredentialStore, COMMAND_CODE_REF } from '../server/credentials.js'
import { commandCodeRoutes } from '../server/command-code.js'
import { homePatch } from '../server/dsh-config.js'
import { appPaths } from '../server/paths.js'
import { AcpRuntime } from '../server/runtime.js'
import { TOOL_MODE_CONFIG } from '../server/ptc.js'

for (const endpoint of ['chat', 'messages']) {
  test('real DSH uses the Command Code ' + endpoint + ' route with credentials and ZDR', { timeout: 90000 }, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-command-runtime-'))
    const paths = appPaths(home)
    const workspace = path.join(home, 'workspace')
    await fs.mkdir(paths.dshHome, { recursive: true })
    await fs.mkdir(workspace)
    await fs.writeFile(path.join(workspace, 'evidence.txt'), 'fixture evidence')
    const requests = [], updates = []
    const server = http.createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (endpoint === 'chat') {
        const base = { id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'test-model' }
        const delta = requests.length === 1
          ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: 'evidence.txt' }) } }] }
          : { role: 'assistant', content: 'fixture reply' }
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }) + '\n\n')
        res.end('data: [DONE]\n\n')
      } else {
        const send = (type, obj) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...obj }) + '\n\n')
        send('message_start', { message: { id: 'mock', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
        if (requests.length === 1) {
          send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'read', input: {} } })
          send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: 'evidence.txt' }) } })
        } else {
          send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture reply' } })
        }
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
        send('message_stop', {})
        res.end()
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const root = 'http://127.0.0.1:' + server.address().port + '/provider'
    const provider = endpoint === 'chat' ? 'command-code' : 'command-code-claude'
    const routes = commandCodeRoutes([{ id: 'test-model', name: 'Test', contextWindow: 32768, endpoint }], { root, zdr: true })
    const rows = YAML.parse(homePatch({ commandCodeRoutes: routes }))
    rows.find((row) => row.id === 'acp').config = { provider, model: 'test-model' }
    await fs.writeFile(paths.homePatch, YAML.stringify(rows))
    await new CredentialStore(paths.credentials).setRef(COMMAND_CODE_REF, 'fixture-not-a-real-key')
    const runtime = new AcpRuntime({ mode: 'read-only', paths, onUpdate: (_id, update) => updates.push(update), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    t.after(async () => {
      await runtime.stop()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      assert.equal(path.dirname(home), os.tmpdir())
      await fs.rm(home, { recursive: true, force: true })
    })
    await runtime.start()
    const session = await runtime.newSession(workspace)
    await runtime.setOption(session.sessionId, TOOL_MODE_CONFIG, 'native')
    const result = await runtime.prompt(session.sessionId, [{ type: 'text', text: 'fixture prompt' }])
    assert.equal(result.stopReason, 'end_turn')
    assert.ok(JSON.stringify(updates).includes('fixture reply'))
    assert.equal(requests.length, 2)
    assert.match(JSON.stringify(requests[1].body.messages), /fixture evidence/)
    assert.equal(new URL(requests[0].url, root).pathname, endpoint === 'chat' ? '/provider/v1/chat/completions' : '/provider/v1/messages')
    assert.equal(requests[0].headers['x-cmd-zdr'], '1')
    assert.equal(endpoint === 'chat' ? requests[0].headers.authorization : requests[0].headers['x-api-key'], endpoint === 'chat' ? 'Bearer fixture-not-a-real-key' : 'fixture-not-a-real-key')
    assert.equal(requests[0].body.model, 'test-model')
    assert.ok(Array.isArray(requests[0].body.tools))
  })
}
