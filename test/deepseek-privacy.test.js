// The real headless dsh against a local mock of the DeepSeek API; no real credentials or model calls.
// Shipped dsh uploads the whole session log (prompts, replies, tool output, paths)
// and the installed plugin list with every DeepSeek request, also to a non-official
// endpoint. Agent Desk turns both off in the home patch.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { CredentialStore, DEEPSEEK_REF } from '../server/credentials.js'
import { dshChildPatch, homePatch } from '../server/dsh-config.js'
import { appPaths } from '../server/paths.js'
import { runDshChild } from '../server/subagent-dsh.js'

test('DeepSeek requests carry no session log or plugin inventory', { timeout: 90000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-deepseek-'))
  const paths = appPaths(home)
  const workspace = path.join(home, 'workspace')
  const requests = []
  const model = 'deepseek-v4-flash'
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    requests.push({ url: req.url, body: JSON.parse(raw) })
    const events = [
      { type: 'message_start', message: { id: 'mock', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture reply' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.equal(path.dirname(home), os.tmpdir())
    await fs.rm(home, { recursive: true, force: true })
  })
  await fs.mkdir(paths.dshHome, { recursive: true })
  await fs.mkdir(workspace)
  await fs.writeFile(paths.homePatch, homePatch())
  const patchFile = paths.dshChildPatch('gp')
  const mock = `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${server.address().port}\n`
  await fs.writeFile(patchFile, dshChildPatch({ child: { provider: 'deepseek-official', model } }) + mock)
  await new CredentialStore(paths.credentials).setRef(DEEPSEEK_REF, 'fixture-not-a-real-key')

  const reply = await runDshChild({ paths, workspace, prompt: 'fixture prompt', mode: 'read-only', patchFile })
  assert.equal(reply, 'fixture reply')
  assert.ok(requests.length >= 1)
  for (const { body } of requests) {
    assert.equal(body.model, model)
    assert.equal(body.dsh_session_log, undefined)
    assert.equal(body.dsh_plugin_packages, undefined)
  }
})
