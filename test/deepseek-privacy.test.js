// The real headless dsh against a local mock of the DeepSeek API; no real credentials or model calls.
// Shipped dsh uploads the whole session log (prompts, replies, tool output, paths)
// and the installed plugin list with every DeepSeek request, also to a non-official
// endpoint. Agent Desk turns both off in the home patch.
// The checks below are allowlists, not a search for those two names: a dsh update
// that renames them or adds another field fails here instead of sending it silently.
// When this fails, find out what the new field carries before allowing it, and keep
// anything that holds conversation, files, paths or an inventory of the machine off.
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

// Anthropic Messages parameters; dsh sends DeepSeek requests in this format.
const MESSAGES_FIELDS = new Set(['model', 'messages', 'system', 'max_tokens', 'stream', 'thinking', 'tools',
  'tool_choice', 'output_config', 'temperature', 'top_p', 'top_k', 'stop_sequences'])
// Sent by dsh-llm-deepseek with no setting to stop them (docs/architecture.md):
// a random id kept in dsh-home/.anonymous-user-id and the session id.
const KNOWN_HEADERS = new Set(['x-deepseek-harness-user-id', 'x-deepseek-harness-session-id'])

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
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) })
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
  for (const { body, headers } of requests) {
    assert.equal(body.model, model)
    const extra = Object.keys(body).filter((key) => !MESSAGES_FIELDS.has(key))
    assert.deepEqual(extra, [], 'unexpected fields in a DeepSeek request')
    const tracking = Object.keys(headers).filter((name) => /^x-(deepseek|dsh)/i.test(name) && !KNOWN_HEADERS.has(name))
    assert.deepEqual(tracking, [], 'unexpected identification headers in a DeepSeek request')
  }
})
