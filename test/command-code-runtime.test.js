// Real DSH/ACP against local mock endpoints; no provider account or model calls.
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
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
import { createThreadHandlers } from '../server/rpc-handlers-threads.js'
import { AcpRuntime } from '../server/runtime.js'
import { ThreadManager } from '../server/threads.js'
import { TOOL_MODE_CONFIG } from '../server/ptc.js'
import { turnUsage } from '../server/usage.js'

async function imageRuntime(t, modelId) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-command-image-'))
  const paths = appPaths(home)
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(paths.dshHome, { recursive: true })
  await fs.mkdir(workspace)
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ url: req.url, body: JSON.parse(raw) })
    const base = { id: 'mock', object: 'chat.completion.chunk', created: 0, model: modelId }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture reply' }, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const root = 'http://127.0.0.1:' + server.address().port + '/provider'
  const routes = commandCodeRoutes([{ id: modelId, name: 'Test', contextWindow: 32768, endpoint: 'chat' }], { root })
  const rows = YAML.parse(homePatch({ commandCodeRoutes: routes }))
  rows.find((row) => row.id === 'acp').config = { provider: 'command-code', model: modelId }
  await fs.writeFile(paths.homePatch, YAML.stringify(rows))
  await new CredentialStore(paths.credentials).setRef(COMMAND_CODE_REF, 'fixture-not-a-real-key')
  const runtime = new AcpRuntime({ mode: 'read-only', paths, onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  const cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup()
    await runtime.stop()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.equal(path.dirname(home), os.tmpdir())
    await fs.rm(home, { recursive: true, force: true })
  })
  return { paths, workspace, runtime, requests, cleanups }
}

for (const modelId of ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash-vision-exp']) test('real DSH sends a DeepSeek image attachment to the Command Code chat endpoint (' + modelId + ')', { timeout: 90000 }, async (t) => {
  const { workspace, runtime, requests } = await imageRuntime(t, modelId)
  const sharp = (await import('sharp')).default
  const image = (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ee2244' } }).png().toBuffer()).toString('base64')
  await runtime.start()
  const session = await runtime.newSession(workspace)
  const result = await runtime.prompt(session.sessionId, [
    { type: 'text', text: 'fixture image' },
    { type: 'image', mimeType: 'image/png', data: image },
  ])
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/provider/v1/chat/completions')
  assert.equal(requests[0].body.model, modelId)
  const user = requests[0].body.messages.find((message) => message.role === 'user')
  assert.ok(user?.content.some((part) => part.type === 'image_url' && part.image_url?.url === `data:image/png;base64,${image}`), 'image bytes and MIME reach the HTTP request')
})

test('a large PNG uploaded with the first message reaches a vision endpoint through real DSH', { timeout: 90_000 }, async (t) => {
  const modelId = 'deepseek/deepseek-v4.1-flash'
  const { paths, workspace, runtime, requests, cleanups } = await imageRuntime(t, modelId)
  const pool = Object.assign(new EventEmitter(), {
    get: () => runtime.start(), holderOf: (id) => runtime.liveSessions.has(id) ? runtime : null, status: () => ({}),
  })
  const threads = new ThreadManager({ paths, pool, catalog: { learn: () => false },
    getAccounts: async () => ({ commandCode: { configured: true } }), getTurnUsage: async () => null })
  cleanups.push(() => threads.shutdown())
  runtime.onUpdate = (id, update) => threads.onUpdate(id, update)
  const rpc = createThreadHandlers({ paths, threads, mutateSettings: async () => {} })
  await fs.mkdir(paths.attachmentsDir)

  // A real PNG that crosses the old regexp limit without needing a checked-in binary.
  const sharp = (await import('sharp')).default
  const width = 1400, height = 1250
  const png = await sharp({ create: { width, height, channels: 3, background: '#ee2244' } }).png({ compressionLevel: 0 }).toBuffer()
  assert.ok(png.length > 5 * 1024 * 1024)
  const image = await rpc['attachment.add']({ name: 'fixture.png', mimeType: 'image/png', data: png.toString('base64') })
  const text = 'Describe this image'
  const { thread } = await rpc['thread.create']({ workspace, model: JSON.stringify(['command-code', modelId]), permissionMode: 'read-only',
    toolMode: 'ptc', createId: '838129e4-4dd8-436f-bc34-28aff1277950', text, images: [image] })
  await threads.active.get(thread.id)?.done
  const { turns: [turn] } = await rpc['thread.get']({ threadId: thread.id })
  assert.equal(turn.status, 'done', JSON.stringify(turn.error))
  assert.deepEqual(turn.user.images, [image])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/provider/v1/chat/completions')
  const { content } = requests[0].body.messages.find((message) => message.role === 'user')
  assert.ok(content.some((part) => part.type === 'text' && part.text.includes(text)))
  const sent = content.find((part) => part.type === 'image_url')?.image_url?.url
  assert.ok(sent?.startsWith('data:image/'), 'the model request contains an inline image')
  // dsh may normalize PNG bytes before sending; check the decoded picture.
  const { data, info } = await sharp(Buffer.from(sent.slice(sent.indexOf(',') + 1), 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([info.width, info.height], [width, height])
  // Normalization may use lossy compression.
  assert.ok([238, 34, 68].every((value, index) => Math.abs(data[index] - value) <= 3), 'the image keeps its fixture color')
})

for (const endpoint of ['chat', 'messages']) for (const mode of ['unknown', 'default', 'low', 'xhigh', 'max', ...(endpoint === 'chat' ? ['ling-low', 'ling-medium', 'ling-high', 'ling1019-low', 'ling1019-medium', 'ling1019-high'] : [])]) {
  test('real DSH uses the Command Code ' + endpoint + ' route with credentials and ZDR (' + mode + ')', { timeout: 90000 }, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-command-runtime-'))
    const paths = appPaths(home)
    const workspace = path.join(home, 'workspace')
    await fs.mkdir(paths.dshHome, { recursive: true })
    await fs.mkdir(workspace)
    await fs.writeFile(path.join(workspace, 'evidence.txt'), 'fixture evidence')
    const requests = [], updates = []
    const modelId = mode === 'unknown' ? 'test-model' : mode.startsWith('ling1019-') ? 'inclusionai/ling-3.1-flash-1019' : mode.startsWith('ling-') ? 'inclusionai/ling-3.1-flash' : endpoint === 'messages' ? 'claude-sonnet-5-5' : mode === 'xhigh' ? 'Qwen/Qwen3.8-27B' : 'deepseek/deepseek-v4.1-flash'
    const effort = mode.startsWith('ling1019-') ? mode.slice(9) : mode.startsWith('ling-') ? mode.slice(5) : mode
    const server = http.createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (endpoint === 'chat') {
        const base = { id: 'mock', object: 'chat.completion.chunk', created: 0, model: modelId }
        const delta = requests.length === 1
          ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: 'evidence.txt' }) } }] }
          : { role: 'assistant', content: 'fixture reply' }
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 5 } } }) + '\n\n')
        res.end('data: [DONE]\n\n')
      } else {
        const send = (type, obj) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...obj }) + '\n\n')
        send('message_start', { message: { id: 'mock', type: 'message', role: 'assistant', model: modelId, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
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
    const routes = commandCodeRoutes([{ id: modelId, name: 'Test', contextWindow: 32768, endpoint }], { root, zdr: true })
    const rows = YAML.parse(homePatch({ commandCodeRoutes: routes }))
    rows.find((row) => row.id === 'acp').config = { provider, model: modelId }
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
    if (!['unknown', 'default'].includes(mode)) {
      const options = await runtime.setOption(session.sessionId, 'reasoning_effort', effort)
      assert.equal(options.find((option) => option.id === 'reasoning_effort')?.currentValue, effort)
    }
    await runtime.setOption(session.sessionId, TOOL_MODE_CONFIG, 'native')
    const since = Date.now() - 1000
    const result = await runtime.prompt(session.sessionId, [{ type: 'text', text: 'fixture prompt' }])
    assert.equal(result.stopReason, 'end_turn')
    assert.ok(JSON.stringify(updates).includes('fixture reply'))
    const usage = await turnUsage({ dshHome: paths.dshHome, sessionId: session.sessionId, since })
    assert.ok(usage?.input > 0 && usage.output > 0, 'real DSH session records token usage')
    assert.deepEqual(usage.models, [provider + '/' + modelId])
    assert.equal(usage.cost, null, 'Command Code equivalent is not a metered bill')
    if (mode === 'unknown' || mode.startsWith('ling1019-')) assert.ok(usage.score.unpriced > 0)
    else assert.ok(usage.score.priced > 0 && usage.score.unpriced === 0, 'known model gets an API equivalent')
    assert.equal(requests.length, 2)
    assert.match(JSON.stringify(requests[1].body.messages), /fixture evidence/)
    assert.equal(new URL(requests[0].url, root).pathname, endpoint === 'chat' ? '/provider/v1/chat/completions' : '/provider/v1/messages')
    assert.equal(requests[0].headers['x-cmd-zdr'], '1')
    assert.equal(endpoint === 'chat' ? requests[0].headers.authorization : requests[0].headers['x-api-key'], endpoint === 'chat' ? 'Bearer fixture-not-a-real-key' : 'fixture-not-a-real-key')
    assert.equal(requests[0].body.model, modelId)
    if (!['unknown', 'default'].includes(mode) && endpoint === 'chat') assert.equal(requests[0].body.reasoning_effort, effort)
    if (!['unknown', 'default'].includes(mode) && endpoint === 'messages') {
      assert.equal(requests[0].body.thinking?.type, 'adaptive')
      assert.equal(requests[0].body.output_config?.effort, mode)
    }
    if (['unknown', 'default'].includes(mode)) {
      assert.equal(requests[0].body.reasoning_effort, undefined)
      assert.equal(requests[0].body.output_config, undefined)
    }
    assert.ok(Array.isArray(requests[0].body.tools))
  })
}
