// Full local dsh/ACP path, synthetic loopback provider; no real model or credentials.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch, shippedPersona } from '../server/dsh-config.js'
import { appPaths } from '../server/paths.js'
import { localRoute } from '../server/local-llm.js'
import { AcpRuntime } from '../server/runtime.js'
import { decodeSessionLog, findSessionLog, turnUsage } from '../server/usage.js'

test('real dsh preserves reported reasoning in the durable session and turn summary', { timeout: 60000 }, async t => {
  const parent = path.resolve(os.tmpdir())
  const home = await fs.mkdtemp(path.join(parent, 'agent-desk-reasoning-runtime-'))
  const paths = appPaths(home), workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true }); await fs.mkdir(workspace)
  let calls = 0
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    calls++
    const base = { id: 'local-mock', object: 'chat.completion.chunk', created: 0, model: 'reasoning-fixture' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture reply' }, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 5 } } }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const rows = YAML.parse(homePatch({ localRoute: localRoute({ baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', models: [{ id: 'reasoning-fixture' }] }), persona: await shippedPersona() }))
  rows.find(row => row.id === 'acp').config = { provider: 'local-llm', model: 'reasoning-fixture' }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  const runtime = new AcpRuntime({ paths, mode: 'read-only', onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  t.after(async () => {
    await runtime.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(home), parent); assert.match(path.basename(home), /^agent-desk-reasoning-runtime-/)
    await fs.rm(home, { recursive: true, force: true })
  })
  await runtime.start()
  const session = await runtime.newSession(workspace), since = Date.now() - 1000
  assert.equal((await runtime.prompt(session.sessionId, [{ type: 'text', text: 'fixture' }])).stopReason, 'end_turn', runtime.stderr)
  await runtime.stop()
  const file = await findSessionLog(paths.dshHome, session.sessionId)
  assert.ok(file)
  const events = decodeSessionLog(await fs.readFile(file))
  const recorded = events.find(e => e.type === 'assistant/message' && e.data?.usage)?.data.usage
  assert.equal(recorded?.outputTokens, 20)
  assert.equal(recorded?.reasoningTokens, 5)
  const total = await turnUsage({ dshHome: paths.dshHome, sessionId: session.sessionId, since, waitMs: 0 })
  assert.equal(total?.output, 20)
  assert.equal(total?.reasoning, 5)
  assert.equal(calls, 1)
})
