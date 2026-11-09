// The real headless child and a local mock provider; no real credentials or model calls.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { commandCodeRoutes } from '../server/command-code.js'
import { COMMAND_CODE_REF, CredentialStore } from '../server/credentials.js'
import { dshChildPatch, homePatch } from '../server/dsh-config.js'
import { appPaths } from '../server/paths.js'
import { runDshChild } from '../server/subagent-dsh.js'

test('bridged headless DSH uses the managed API credential', { timeout: 90000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-child-'))
  const paths = appPaths(home)
  const workspace = path.join(home, 'workspace')
  const requests = []
  const model = 'deepseek/deepseek-v4.1-flash'
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ authorization: req.headers.authorization, body: JSON.parse(raw) })
    const base = { id: 'mock', object: 'chat.completion.chunk', created: 0, model }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture reply' }, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
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
  const root = `http://127.0.0.1:${server.address().port}/provider`
  const routes = commandCodeRoutes([{ id: model, name: 'Test', contextWindow: 32768, endpoint: 'chat' }], { root })
  await fs.writeFile(paths.homePatch, homePatch({ commandCodeRoutes: routes }))
  const patchFile = paths.dshChildPatch('gp')
  await fs.writeFile(patchFile, dshChildPatch({ child: { provider: 'command-code', model, effort: 'max' } }))
  await new CredentialStore(paths.credentials).setRef(COMMAND_CODE_REF, 'fixture-not-a-real-key')

  const reply = await runDshChild({ paths, workspace, prompt: 'fixture prompt', mode: 'read-only', patchFile })
  assert.equal(reply, 'fixture reply')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].authorization, 'Bearer fixture-not-a-real-key')
  assert.equal(requests[0].body.model, model)
  assert.equal(requests[0].body.reasoning_effort, 'max')
  const toolNames = requests[0].body.tools.map((tool) => tool.function.name)
  assert.ok(!toolNames.includes('create_goal'), 'a one-shot child cannot create a persistent goal')
  assert.ok(!toolNames.includes('update_goal'))
  assert.match(JSON.stringify(requests[0].body.messages), /Approval prompts are disabled/)
})
