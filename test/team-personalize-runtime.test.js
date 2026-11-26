// Real ACP runtime + local HTTP LLM: verifies per-session custom-instructions suppression and resume re-application.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { CUSTOM_INSTRUCTIONS_CONFIG, customInstructionsOption } from '../server/custom-instructions.js'
import { WEB_SEARCH_PLUGIN, homePatch, shippedPersona } from '../server/dsh-config.js'
import { localRoute } from '../server/local-llm.js'
import { appPaths } from '../server/paths.js'
import { AcpRuntime } from '../server/runtime.js'

const MARKER = 'UNIQUE_PERSONALIZE_MARKER_98765'

test('AcpRuntime toggles custom instructions per session without cross-session leakage and reapplies after restart', { timeout: 120_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-personalize-rt-'))
  const paths = appPaths(home)
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true })
  await fs.mkdir(workspace, { recursive: true })

  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push(JSON.parse(raw))
    const base = { id: `reply-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: 'personalize-fixture' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const persona = await shippedPersona()
  const rows = YAML.parse(homePatch({
    localRoute: localRoute({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'personalize-fixture' }] }),
    persona,
    webSearch: { plugin: WEB_SEARCH_PLUGIN, credentials: paths.credentials },
    instructions: MARKER,
  }))
  rows.find((row) => row.id === 'acp').config = { provider: 'local-llm', model: 'personalize-fixture' }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))

  let runtime = new AcpRuntime({
    mode: 'workspace-write',
    paths,
    onUpdate: () => {},
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  })
  t.after(async () => {
    await runtime.stop().catch(() => {})
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(home, { recursive: true, force: true })
  })

  const systemText = (req) => req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')

  await runtime.start()
  const sessionA = await runtime.newSession(workspace)
  const sessionB = await runtime.newSession(workspace)
  assert.equal(customInstructionsOption(sessionA.configOptions)?.currentValue, 'on')
  assert.equal(customInstructionsOption(sessionB.configOptions)?.currentValue, 'on')

  // Session A keeps global custom instructions.
  await runtime.prompt(sessionA.sessionId, [{ type: 'text', text: 'turn A1' }])
  assert.ok(systemText(requests.at(-1)).includes(MARKER))
  assert.ok(systemText(requests.at(-1)).includes('<user_instructions>'))

  // Session B turns global custom instructions off without affecting Session A.
  const optsB = await runtime.setOption(sessionB.sessionId, CUSTOM_INSTRUCTIONS_CONFIG, 'off')
  assert.equal(customInstructionsOption(optsB)?.currentValue, 'off')
  await runtime.prompt(sessionB.sessionId, [{ type: 'text', text: 'turn B1' }])
  assert.equal(systemText(requests.at(-1)).includes(MARKER), false)
  assert.equal(systemText(requests.at(-1)).includes('<user_instructions>'), false)

  // Session A still retains custom instructions.
  await runtime.prompt(sessionA.sessionId, [{ type: 'text', text: 'turn A2' }])
  assert.ok(systemText(requests.at(-1)).includes(MARKER))

  // Toggle Session B back on and off to verify clean disposal and re-shadowing.
  await runtime.setOption(sessionB.sessionId, CUSTOM_INSTRUCTIONS_CONFIG, 'on')
  await runtime.prompt(sessionB.sessionId, [{ type: 'text', text: 'turn B2' }])
  assert.ok(systemText(requests.at(-1)).includes(MARKER))

  await runtime.setOption(sessionB.sessionId, CUSTOM_INSTRUCTIONS_CONFIG, 'off')
  await runtime.prompt(sessionB.sessionId, [{ type: 'text', text: 'turn B3' }])
  assert.equal(systemText(requests.at(-1)).includes(MARKER), false)

  // Restart runtime, resume Session B, and confirm 'off' must be re-applied to suppress instructions.
  await runtime.stop()
  runtime = new AcpRuntime({
    mode: 'workspace-write',
    paths,
    onUpdate: () => {},
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  })
  await runtime.start()
  const resumed = await runtime.resumeSession(sessionB.sessionId, workspace)
  assert.equal(customInstructionsOption(resumed.configOptions)?.currentValue, 'on')
  const reapplied = await runtime.setOption(sessionB.sessionId, CUSTOM_INSTRUCTIONS_CONFIG, 'off')
  assert.equal(customInstructionsOption(reapplied)?.currentValue, 'off')
  await runtime.prompt(sessionB.sessionId, [{ type: 'text', text: 'turn B4' }])
  assert.equal(systemText(requests.at(-1)).includes(MARKER), false)
})
