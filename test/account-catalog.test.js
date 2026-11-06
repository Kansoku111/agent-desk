import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { test } from 'node:test'
import WebSocket from 'ws'
import { Catalog } from '../server/catalog.js'
import { readOpenCodeCatalog } from '../server/model-catalog.js'
import { openCodeModels } from '../server/opencode-go-catalog.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const tick = () => new Promise((resolve) => setTimeout(resolve, 50))

test('catalog does not accept a runtime snapshot that predates a key change', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-catalog-signature-'))
  let catalog
  t.after(async () => {
    await catalog?.flush()
    await fs.rm(home, { recursive: true, force: true })
  })
  const signature = (deepseek) => JSON.stringify({ deepseek, added: [] })
  const options = (withDeepSeek) => [{
    id: 'model',
    options: [
      { group: 'openai-codex', options: [{ value: '["openai-codex","gpt-6-luna"]', name: 'GPT 6 Luna' }] },
      ...(withDeepSeek ? [{ group: 'deepseek-official', options: [{ value: '["deepseek-official","deepseek-chat"]', name: 'DeepSeek Chat' }] }] : []),
    ],
  }]
  catalog = await new Catalog(path.join(home, 'catalog.json'), signature(true)).load()
  catalog.learn(options(false))
  assert.equal(catalog.stale, true)
  assert.ok(catalog.data.models.some((model) => model.provider === 'openai-codex'))
  catalog.learn(options(true))
  assert.equal(catalog.stale, false)
  assert.ok(catalog.data.models.some((model) => model.provider === 'deepseek-official'))

  catalog.setSignature(signature(false))
  catalog.learn(options(true))
  assert.equal(catalog.stale, true)
  catalog.learn(options(false))
  assert.equal(catalog.stale, false)
  assert.ok(catalog.data.models.every((model) => model.provider !== 'deepseek-official'))
})

test('old OpenCode Go snapshots cannot complete or undo a model-list refresh', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-go-signature-'))
  let catalog
  t.after(async () => {
    await catalog?.flush()
    await fs.rm(home, { recursive: true, force: true })
  })
  const signature = (ids) => JSON.stringify({ opencodeGo: true, opencodeGoModels: ids })
  const options = (ids) => [{ id: 'model', options: [{ group: 'opencode-go', options: ids.map((id) => ({ value: JSON.stringify(['opencode-go', id]), name: id })) }] }]
  catalog = await new Catalog(path.join(home, 'catalog.json'), signature(['glm-5.3', 'space-bunny'])).load()
  catalog.learn(options(['space-bunny', 'glm-5.3']))
  catalog.setSignature(signature(['glm-5.3']))
  catalog.learn(options(['glm-5.3', 'space-bunny']))
  assert.equal(catalog.stale, true)
  catalog.learn(options(['glm-5.3']))
  assert.equal(catalog.stale, false)
  assert.equal(catalog.learn(options(['glm-5.3', 'space-bunny'])), false)
  assert.deepEqual(catalog.data.models.map((model) => model.id), ['glm-5.3'])
  // Re-enabling the full catalog must not accept the old narrowed snapshot either.
  catalog.setSignature(signature(['glm-5.3', 'space-bunny']))
  catalog.learn(options(['glm-5.3']))
  assert.equal(catalog.stale, true)
  catalog.setSignature(signature(['glm-5.3', 'glm-5.3-20261024']))
  catalog.learn(options(['glm-5.3', 'glm-5.3-20261024']))
  assert.equal(catalog.stale, false)
})

/**
 * Saves and removes a key through the real save handler, runtimes and
 * discovery, with no real provider inference or credentials. Public probes are
 * mocked; an optional local test server may handle fixture model requests.
 */
async function keyRefreshesCatalog(t, { provider, account, catalogProvider, probe, probeBody = '{"data":[]}', settings = { modelAutoUpdate: false }, savedUpdates = null, afterAdded = null, afterRemoved = null, registryBody = null, expectedCheck = 'valid', localBase = null, injectRuntimeFailure = false }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-account-catalog-'))
  const hook = path.join(home, 'offline-fetch.mjs')
  const probeFile = path.join(home, 'probe-response.json')
  const faultFile = path.join(home, 'fail-runtime-warm')
  const runtimeUrl = pathToFileURL(path.join(root, 'server', 'runtime.js')).href
  const faultHook = injectRuntimeFailure ? `const { existsSync, readFileSync } = await import('node:fs');
    const { AcpRuntime } = await import(${JSON.stringify(runtimeUrl)});
    const fault = () => existsSync(${JSON.stringify(faultFile)}) ? readFileSync(${JSON.stringify(faultFile)}, 'utf8') : '';
    const newSession = AcpRuntime.prototype.newSession;
    AcpRuntime.prototype.newSession = function (...args) {
      if (fault() === 'fail') throw new Error('fixture runtime warm failed');
      return newSession.apply(this, args);
    };
    const setOption = AcpRuntime.prototype.setOption;
    AcpRuntime.prototype.setOption = function (...args) {
      if (fault() === 'effort' && args[1] === 'model' && args[2].includes('deepseek/deepseek-v4.1-flash')) throw new Error('fixture option failed');
      if (fault() === 'hold' && args[1] === 'model' && args[2].includes('deepseek/deepseek-v4.1-flash')) {
        return globalThis.fetch(${JSON.stringify(localBase + '/warm-gate')}).then(() => setOption.apply(this, args));
      }
      return setOption.apply(this, args);
    };` : ''
  await fs.writeFile(probeFile, probeBody)
  await fs.writeFile(hook, `import { readFile } from 'node:fs/promises';
  ${faultHook}
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (${JSON.stringify(localBase)} && String(url).startsWith(${JSON.stringify(localBase)})) return realFetch(url, init);
    if (String(url) === ${JSON.stringify(probe)}) return new Response(await readFile(${JSON.stringify(probeFile)}, 'utf8'), { status: 200 });
    if (String(url) === 'https://models.opencode.ai/api.json' && ${JSON.stringify(registryBody !== null)}) return Response.json(${JSON.stringify(registryBody)});
    throw new Error('offline account-catalog test');
  }`)
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify(settings))
  if (savedUpdates) await fs.writeFile(path.join(home, 'model-updates.json'), JSON.stringify(savedUpdates))
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, 'server/index.js', '--no-open', '--port', '0'], {
    cwd: root, env: { ...process.env, AGENT_DESK_HOME: home },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', info, ws
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  t.after(async () => {
    ws?.terminate()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      if (info) await fetch(`http://127.0.0.1:${info.port}/api/quit?t=${info.token}`, {
        method: 'POST', signal: AbortSignal.timeout(2000),
      }).catch(() => {})
      const fallback = setTimeout(() => child.kill(), 5000)
      await exited
      clearTimeout(fallback)
    }
    assert.equal(path.dirname(home), os.tmpdir())
    assert.ok(path.basename(home).startsWith('agent-desk-account-catalog-'))
    await fs.rm(home, { recursive: true, force: true })
  })
  for (let i = 0; i < 200; i++) {
    assert.equal(child.exitCode, null, output)
    try { info = JSON.parse(await fs.readFile(path.join(home, 'server.json'), 'utf8')); break } catch {}
    await tick()
  }
  assert.ok(info, output)
  const origin = `http://127.0.0.1:${info.port}`
  ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?t=${info.token}`, { origin })
  const replies = new Map(), updates = []
  let sequence = 0, helloResolve
  const hello = new Promise((resolve) => { helloResolve = resolve })
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    if (frame.event === 'hello') helloResolve(frame.state)
    if (frame.event === 'modelUpdate') updates.push(frame.modelUpdate)
    if (replies.has(frame.id)) { replies.get(frame.id)(frame); replies.delete(frame.id) }
  })
  await hello
  const request = async (type, params = {}) => {
    const result = await new Promise((resolve) => {
      const id = ++sequence
      replies.set(id, resolve)
      ws.send(JSON.stringify({ type, ...params, id }))
    })
    assert.equal(result.ok, true, result.error)
    return result.result
  }
  const waitFor = async (predicate) => {
    let lastState
    for (let i = 0; i < 300; i++) {
      const state = await request('state.get')
      lastState = state
      if (predicate(state)) return state
      await tick()
    }
    assert.fail(`catalog did not converge: ${output}\nlast state: ${JSON.stringify({ accounts: lastState?.accounts, runtime: lastState?.runtime, models: lastState?.catalog?.models?.map(({ provider, id }) => ({ provider, id })) })}`)
  }
  const models = (state) => state.catalog.models.filter((model) => model.provider === catalogProvider)
  const initial = await waitFor((state) => state.catalog.models.length > 0)
  assert.equal(models(initial).length, 0)
  const saved = await request('account.setKey', { provider, key: 'sk-test-only-not-a-real-key' })
  assert.equal(saved.check.status, expectedCheck)
  const added = await waitFor((state) => models(state).length > 0)
  assert.equal(added.accounts[account].configured, true)
  assert.ok(models(added).every((model) => model.id && model.value))
  if (afterAdded) await afterAdded({ request, waitFor, added, probeFile, home, faultFile, updates })
  await request('account.removeKey', { provider })
  const removed = await waitFor((state) => models(state).length === 0)
  assert.equal(removed.accounts[account].configured, false)
  if (afterRemoved) await afterRemoved({ request, waitFor, removed })
  assert.ok(removed.catalog.models.some((model) => model.provider === 'openai-codex'))
  return added
}

test('saving and removing a DeepSeek key refreshes the picker catalog without a manual refresh', { timeout: 45_000 }, async (t) => {
  await keyRefreshesCatalog(t, { provider: 'deepseek', account: 'deepseek', catalogProvider: 'deepseek-official', probe: 'https://api.deepseek.com/models' })
})

test('saving and removing an OpenCode Go key adds and removes its catalog models', { timeout: 45_000 }, async (t) => {
  const added = await keyRefreshesCatalog(t, {
    provider: 'opencodeGo', account: 'opencodeGo', catalogProvider: 'opencode-go', probe: 'https://opencode.ai/inference/go/v1/models',
  })
  // The models are pi-ai's opencode-go catalog, served through dsh.
  const ids = added.catalog.models.filter((model) => model.provider === 'opencode-go').map((model) => model.id)
  for (const id of ['glm-5.3', 'kimi-k3', 'qwen3.8-max']) assert.ok(ids.includes(id), ids.join(', '))
})

test('OpenScale key adds only the two standard models and removal clears them', { timeout: 60_000 }, async (t) => {
  await keyRefreshesCatalog(t, {
    provider: 'openscale', account: 'openscale', catalogProvider: 'openscale',
    probe: 'https://api.openscale.so/v1/models', expectedCheck: 'unverified',
    afterAdded: async ({ added, waitFor }) => {
      const ids = ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash']
      assert.deepEqual(added.catalog.models.filter((model) => model.provider === 'openscale').map((model) => model.id).sort(), ids)
      const state = await waitFor((item) => ids.every((id) => (item.catalog.effortsByModel[JSON.stringify(['openscale', id])] ?? []).some((entry) => entry.value === 'high')))
      const expected = { 'deepseek/deepseek-v4.1-flash': ['low', 'high', 'max'], 'z-ai/glm-5.3-flash': ['low', 'high'] }
      for (const id of ids) assert.deepEqual(state.catalog.effortsByModel[JSON.stringify(['openscale', id])].map((entry) => entry.value).filter(Boolean), expected[id])
    },
  })
})

test('Command Code saves an unverified key and loads both official protocol routes', { timeout: 60_000 }, async (t) => {
  const body = { data: [
    { id: 'provider/fixture', name: 'Fixture', context_length: 100000, supported_endpoints: ['/chat/completions'] },
    { id: 'claude-fixture', name: 'Claude Fixture', context_length: 100000, supported_endpoints: ['/messages'] },
  ] }
  await keyRefreshesCatalog(t, {
    provider: 'commandCode', account: 'commandCode', catalogProvider: 'command-code',
    probe: 'https://api.commandcode.ai/provider/v1/models', probeBody: JSON.stringify(body), expectedCheck: 'unverified',
    afterAdded: async ({ added }) => {
      assert.ok(added.catalog.models.some((model) => model.provider === 'command-code-claude' && model.id === 'claude-fixture'))
      assert.ok(added.catalog.models.some((model) => model.provider === 'command-code' && model.id === 'provider/fixture'))
      assert.equal(added.modelUpdate.commandCode.applied, true)
      assert.equal(added.modelUpdate.commandCode.error, false)
      assert.equal(added.modelUpdate.commandCode.checking, false)
    },
    afterRemoved: async ({ removed }) => assert.ok(removed.catalog.models.every((model) => model.provider !== 'command-code-claude')),
  })
})

test('the shared manual check refreshes Command Code even with auto-sync off and preserves cache on error', { timeout: 90_000 }, async (t) => {
  const entry = (id) => ({ id, name: id, context_length: 100000, supported_endpoints: ['/chat/completions'] })
  await keyRefreshesCatalog(t, {
    provider: 'commandCode', account: 'commandCode', catalogProvider: 'command-code',
    probe: 'https://api.commandcode.ai/provider/v1/models', probeBody: JSON.stringify({ data: [entry('first')] }), expectedCheck: 'unverified',
    afterAdded: async ({ request, waitFor, added, probeFile }) => {
      assert.equal(added.settings.modelAutoUpdate, false)
      assert.equal(added.modelUpdate.commandCode.applied, true)
      await fs.writeFile(probeFile, JSON.stringify({ data: [entry('second')] }))
      await request('modelUpdate.check')
      const refreshed = await waitFor((state) => state.catalog.models.some((model) => model.provider === 'command-code' && model.id === 'second') && state.modelUpdate.commandCode.applied)
      assert.equal(refreshed.modelUpdate.commandCode.error, false)
      assert.equal(refreshed.catalog.models.some((model) => model.provider === 'command-code' && model.id === 'first'), false)
      const checkedAt = refreshed.modelUpdate.commandCode.checkedAt
      await fs.writeFile(probeFile, '{}')
      await request('modelUpdate.check')
      const failed = await waitFor((state) => state.modelUpdate.commandCode.error === true)
      assert.equal(failed.modelUpdate.commandCode.checkedAt, checkedAt)
      assert.equal(failed.modelUpdate.commandCode.applied, true)
      assert.ok(failed.catalog.models.some((model) => model.provider === 'command-code' && model.id === 'second'))
    },
  })
})

test('Command Code reports runtime apply failure and clears it after a successful retry', { timeout: 90_000 }, async (t) => {
  const entry = (id) => ({ id, name: id, context_length: 100000, supported_endpoints: ['/chat/completions'] })
  await keyRefreshesCatalog(t, {
    provider: 'commandCode', account: 'commandCode', catalogProvider: 'command-code', injectRuntimeFailure: true,
    probe: 'https://api.commandcode.ai/provider/v1/models', probeBody: JSON.stringify({ data: [entry('first')] }), expectedCheck: 'unverified',
    afterAdded: async ({ request, waitFor, probeFile, home, faultFile }) => {
      await fs.writeFile(faultFile, 'fail')
      await fs.writeFile(probeFile, JSON.stringify({ data: [entry('second')] }))
      await request('modelUpdate.check')
      const failed = await waitFor((state) => state.modelUpdate.commandCode.applyError === true)
      assert.equal(failed.modelUpdate.commandCode.error, false)
      assert.equal(failed.modelUpdate.commandCode.applied, false)
      assert.ok(failed.catalog.models.some((entry) => entry.provider === 'command-code' && entry.id === 'first'))
      assert.equal(path.dirname(faultFile), home)
      assert.equal(path.basename(faultFile), 'fail-runtime-warm')
      await fs.unlink(faultFile)
      await request('modelUpdate.check')
      const applied = await waitFor((state) => state.modelUpdate.commandCode.applied && state.catalog.models.some((entry) => entry.provider === 'command-code' && entry.id === 'second'))
      assert.equal(applied.modelUpdate.commandCode.applyError, false)
    },
  })
})

test('a failed effort discovery stays unapplied and a manual retry learns it', { timeout: 90_000 }, async (t) => {
  const entry = (id) => ({ id, name: id, context_length: 100000, supported_endpoints: ['/chat/completions'] })
  const model = 'deepseek/deepseek-v4.1-flash'
  await keyRefreshesCatalog(t, {
    provider: 'commandCode', account: 'commandCode', catalogProvider: 'command-code', injectRuntimeFailure: true,
    probe: 'https://api.commandcode.ai/provider/v1/models', probeBody: JSON.stringify({ data: [entry('first')] }), expectedCheck: 'unverified',
    afterAdded: async ({ request, waitFor, probeFile, home, faultFile }) => {
      await fs.writeFile(faultFile, 'effort')
      await fs.writeFile(probeFile, JSON.stringify({ data: [entry(model)] }))
      await request('modelUpdate.check')
      const failed = await waitFor((state) => state.modelUpdate.commandCode.applyError === true)
      assert.equal(failed.modelUpdate.commandCode.applied, false)
      assert.ok(failed.catalog.models.some((item) => item.provider === 'command-code' && item.id === model))
      assert.deepEqual(failed.catalog.effortsByModel[JSON.stringify(['command-code', model])], [])
      assert.equal(path.dirname(faultFile), home)
      assert.equal(path.basename(faultFile), 'fail-runtime-warm')
      await fs.unlink(faultFile)
      await request('modelUpdate.check')
      const recovered = await waitFor((state) => state.modelUpdate.commandCode.applied)
      assert.equal(recovered.modelUpdate.commandCode.applyError, false)
      assert.deepEqual(recovered.catalog.effortsByModel[JSON.stringify(['command-code', model])].map((entry) => entry.value).filter(Boolean), ['low', 'high', 'max'])
    },
  })
})

test('a failed Command Code effort discovery retries while another task keeps running', { timeout: 90_000 }, async (t) => {
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  const warmStarted = Promise.withResolvers(), warmRelease = Promise.withResolvers()
  let interrupted = false, finished = false, warmCalls = 0
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/warm-gate') { warmCalls++; warmStarted.resolve(); await warmRelease.promise; return res.end('ok') }
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'local-fixture' }] }))
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    for await (const _chunk of req) {}
    res.on('close', () => { if (!finished) interrupted = true })
    const base = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'local-fixture' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'working' }, finish_reason: null }] }) + '\n\n')
    started.resolve()
    await release.promise
    if (res.destroyed) return
    finished = true
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { warmRelease.resolve(); release.resolve(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const localBase = 'http://127.0.0.1:' + server.address().port + '/v1'
  const model = 'deepseek/deepseek-v4.1-flash'
  const entry = (id) => ({ id, name: id, context_length: 100000, supported_endpoints: ['/chat/completions'] })
  await keyRefreshesCatalog(t, {
    provider: 'commandCode', account: 'commandCode', catalogProvider: 'command-code', injectRuntimeFailure: true, localBase,
    probe: 'https://api.commandcode.ai/provider/v1/models', probeBody: JSON.stringify({ data: [entry('first')] }), expectedCheck: 'unverified',
    afterAdded: async ({ request, waitFor, probeFile, home, faultFile }) => {
      const workspace = path.join(home, 'project')
      await fs.mkdir(workspace)
      await request('localLlm.set', { baseURL: localBase })
      const before = await waitFor((state) => state.catalog.models.some((item) => item.provider === 'local-llm') && state.modelUpdate.commandCode.applied)
      const local = before.catalog.models.find((item) => item.provider === 'local-llm')
      await fs.writeFile(faultFile, 'effort')
      await fs.writeFile(probeFile, JSON.stringify({ data: [entry(model)] }))
      await request('modelUpdate.check')
      const failed = await waitFor((state) => state.modelUpdate.commandCode.applyError)
      assert.deepEqual(failed.catalog.effortsByModel[JSON.stringify(['command-code', model])], [])
      const { thread } = await request('thread.create', { workspace, model: local.value, effort: '', permissionMode: 'read-only', text: 'run fixture' })
      await started.promise
      await fs.writeFile(faultFile, 'hold')
      const check = await request('modelUpdate.check')
      assert.equal(check.busy, true)
      await warmStarted.promise
      const second = await request('modelUpdate.check')
      assert.equal(second.busy, true)
      assert.equal(warmCalls, 1, 'concurrent checks share the same discovery')
      warmRelease.resolve()
      const restored = await waitFor((state) => state.catalog.effortsByModel[JSON.stringify(['command-code', model])]?.some((effort) => effort.value === 'max'))
      assert.equal(warmCalls, 1)
      assert.deepEqual(restored.catalog.effortsByModel[JSON.stringify(['command-code', model])].map((effort) => effort.value).filter(Boolean), ['low', 'high', 'max'])
      assert.equal((await request('thread.get', { threadId: thread.id })).thread.status, 'running')
      assert.equal(interrupted, false)
      release.resolve()
    },
  })
})

for (const change of ['models', 'context']) test('Command Code ' + change + ' waits for a running task and applies automatically after it finishes', { timeout: 90_000 }, async (t) => {
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  let interrupted = false, finished = false
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'local-fixture' }] }))
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    for await (const _chunk of req) {}
    res.on('close', () => { if (!finished) interrupted = true })
    const base = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'local-fixture' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'working' }, finish_reason: null }] }) + '\n\n')
    started.resolve()
    await release.promise
    if (res.destroyed) return
    finished = true
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { release.resolve(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const localBase = 'http://127.0.0.1:' + server.address().port + '/v1'
  const entry = (id, context = 100000) => ({ id, name: id, context_length: context, supported_endpoints: ['/chat/completions'] })
  const nextId = change === 'models' ? 'second' : 'first'
  await keyRefreshesCatalog(t, {
    provider: 'commandCode', account: 'commandCode', catalogProvider: 'command-code', localBase,
    probe: 'https://api.commandcode.ai/provider/v1/models', probeBody: JSON.stringify({ data: [entry('first')] }), expectedCheck: 'unverified',
    afterAdded: async ({ request, waitFor, probeFile, home, updates }) => {
      const workspace = path.join(home, 'project')
      await fs.mkdir(workspace)
      await request('localLlm.set', { baseURL: localBase })
      const before = await waitFor((state) => state.catalog.models.some((model) => model.provider === 'local-llm'))
      const model = before.catalog.models.find((entry) => entry.provider === 'local-llm')
      const { thread } = await request('thread.create', { workspace, model: model.value, effort: '', permissionMode: 'read-only', text: 'run fixture' })
      await started.promise
      const firstUpdate = updates.length
      await fs.writeFile(probeFile, JSON.stringify({ data: [entry(nextId, change === 'context' ? 32000 : 100000)] }))
      const check = await request('modelUpdate.check')
      assert.equal(check.busy, true)
      const pending = await waitFor((state) => state.modelUpdate.commandCode.checkedAt && !state.modelUpdate.commandCode.applied)
      assert.equal(pending.modelUpdate.commandCode.applyError, false)
      assert.ok(pending.catalog.models.some((entry) => entry.provider === 'command-code' && entry.id === 'first'))
      assert.equal((await request('thread.get', { threadId: thread.id })).thread.status, 'running')
      assert.equal(interrupted, false)
      release.resolve()
      const applied = await waitFor((state) => state.modelUpdate.commandCode.applied && state.catalog.models.some((entry) => entry.provider === 'command-code' && entry.id === nextId))
      assert.equal(applied.modelUpdate.commandCode.applyError, false)
      assert.ok(updates.slice(firstUpdate).some((update) => update.commandCode.applied === false), 'pending state must be broadcast')
      assert.ok(updates.slice(firstUpdate).some((update) => update.commandCode.applied === true), 'applied state must be broadcast')
      assert.equal(interrupted, false)
    },
  })
})

test('context changes during an older warm stay pending instead of reporting a failure', { timeout: 90_000 }, async (t) => {
  const warmStarted = Promise.withResolvers(), warmRelease = Promise.withResolvers()
  const taskStarted = Promise.withResolvers(), taskRelease = Promise.withResolvers()
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/warm-gate') { warmStarted.resolve(); await warmRelease.promise; return res.end('ok') }
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'local-fixture' }] }))
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    for await (const _chunk of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'local-fixture' }
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'working' }, finish_reason: null }] }) + '\n\n')
    taskStarted.resolve()
    await taskRelease.promise
    if (res.destroyed) return
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { warmRelease.resolve(); taskRelease.resolve(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const localBase = 'http://127.0.0.1:' + server.address().port + '/v1'
  const entry = (id, context = 100000) => ({ id, name: id, context_length: context, supported_endpoints: ['/chat/completions'] })
  const modelId = 'deepseek/deepseek-v4.1-flash'
  await keyRefreshesCatalog(t, {
    provider: 'commandCode', account: 'commandCode', catalogProvider: 'command-code', localBase, injectRuntimeFailure: true,
    probe: 'https://api.commandcode.ai/provider/v1/models', probeBody: JSON.stringify({ data: [entry(modelId)] }), expectedCheck: 'unverified',
    afterAdded: async ({ request, waitFor, probeFile, home, faultFile, updates }) => {
      const workspace = path.join(home, 'project')
      await fs.mkdir(workspace)
      await request('localLlm.set', { baseURL: localBase })
      const state = await waitFor((entry) => entry.catalog.models.some((model) => model.provider === 'local-llm') && entry.modelUpdate.commandCode.applied)
      const model = state.catalog.models.find((entry) => entry.provider === 'local-llm')
      await fs.writeFile(faultFile, 'hold')
      await fs.writeFile(probeFile, JSON.stringify({ data: [entry(modelId), entry('new-model')] }))
      await request('modelUpdate.check')
      await warmStarted.promise
      const { thread } = await request('thread.create', { workspace, model: model.value, effort: '', permissionMode: 'read-only', text: 'run fixture' })
      await taskStarted.promise
      await fs.writeFile(probeFile, JSON.stringify({ data: [entry(modelId, 32000), entry('new-model')] }))
      const changed = await request('modelUpdate.check')
      assert.equal(changed.busy, true)
      assert.equal(changed.modelUpdate.commandCode.applied, false)
      const firstUpdate = updates.length
      warmRelease.resolve()
      const pending = await waitFor(() => updates.length > firstUpdate)
      assert.equal(pending.modelUpdate.commandCode.applied, false)
      assert.equal(pending.modelUpdate.commandCode.applyError, false, 'a warm for the old context is not a failed update')
      assert.equal((await request('thread.get', { threadId: thread.id })).thread.status, 'running')
      await fs.writeFile(faultFile, '')
      taskRelease.resolve()
      const applied = await waitFor((entry) => entry.modelUpdate.commandCode.applied)
      assert.equal(applied.modelUpdate.commandCode.applyError, false)
    },
  })
})

test('Command Code publishes a full mixed-protocol inventory in the real picker', { timeout: 60_000 }, async (t) => {
  const known = ['deepseek/deepseek-v4.1-flash', 'Qwen/Qwen3.8-27B', 'z-ai/glm-5.3-flash']
  const snapshot = JSON.parse(await fs.readFile(new URL('../server/command-code-efforts.json', import.meta.url), 'utf8'))
  const data = [...Object.keys(snapshot.models), 'unknown/fixture'].map((id) => ({
    id, name: id, context_length: 200000, supported_endpoints: [id.startsWith('claude-') ? '/messages' : '/chat/completions'],
  }))
  await keyRefreshesCatalog(t, {
    provider: 'commandCode', account: 'commandCode', catalogProvider: 'command-code',
    probe: 'https://api.commandcode.ai/provider/v1/models', probeBody: JSON.stringify({ data }), expectedCheck: 'unverified',
    afterAdded: async ({ waitFor }) => {
      const levels = (state, provider, id) => (state.catalog.effortsByModel[JSON.stringify([provider, id])] ?? []).map((entry) => entry.value).filter(Boolean)
      const added = await waitFor((state) => state.modelUpdate.commandCode.applied && known.every((id) => levels(state, 'command-code', id).length) && levels(state, 'command-code-claude', 'claude-sonnet-5-5').length)
      assert.equal(added.catalog.models.filter((model) => model.provider === 'command-code').length, 85)
      assert.equal(added.catalog.models.filter((model) => model.provider === 'command-code-claude').length, 11)
      assert.ok(added.catalog.models.some((model) => model.provider === 'command-code-claude' && model.id === 'claude-haiku-4-5-20251001'))
      assert.equal(added.modelUpdate.commandCode.applied, true)
      for (const [provider, id] of [['command-code', known[0]], ['command-code-claude', 'claude-sonnet-5-5']]) {
        assert.ok(added.catalog.effortsByModel[JSON.stringify([provider, id])].some((entry) => entry.value === ''), provider + ' exposes its default')
      }
      assert.deepEqual(levels(added, 'command-code', known[0]), ['low', 'high', 'max'])
      assert.deepEqual(levels(added, 'command-code', known[1]), ['low', 'medium', 'xhigh'])
      assert.deepEqual(levels(added, 'command-code', known[2]), ['low', 'high', 'max'])
      assert.deepEqual(levels(added, 'command-code-claude', 'claude-sonnet-5-5'), ['low', 'medium', 'high', 'xhigh', 'max'])
      assert.deepEqual(levels(added, 'command-code-claude', 'claude-sonnet-4-6'), ['low', 'medium', 'high', 'max'])
      assert.deepEqual(levels(added, 'command-code', 'unknown/fixture'), [])
    },
  })
})

test('new OpenCode models reach the real picker and auto-sync off/on restores the correct catalogs', { timeout: 60_000 }, async (t) => {
  const bundled = openCodeModels(await readOpenCodeCatalog())
  const template = bundled.find((model) => model.api === 'openai-completions')
  // Upstream catalogs retire models; verify the whole installed baseline, not a particular id.
  // The picker omits dated aliases, just as parseConfigOptions does.
  const bundledIds = [...new Set(bundled.map((model) => model.id))].filter((id) => !/-\d{8}$/.test(id)).sort()
  assert.ok(bundledIds.length > 1)
  assert.ok(!bundledIds.includes('test-new-go'))
  const providers = { 'opencode-go': { 'openai-completions': {
    'test-new-go': { ...template, id: 'test-new-go', name: 'Test New Go' },
  } } }
  const ids = (state) => state.catalog.models.filter((model) => model.provider === 'opencode-go').map((model) => model.id).sort()
  await keyRefreshesCatalog(t, {
    provider: 'opencodeGo', account: 'opencodeGo', catalogProvider: 'opencode-go', probe: 'https://opencode.ai/inference/go/v1/models',
    probeBody: JSON.stringify({ data: [{ id: 'glm-5.3' }, { id: 'test-new-go' }] }),
    settings: { modelAutoUpdate: true },
    savedUpdates: { catalog: { format: 2, source: '99.0.0', providers } },
    afterAdded: async ({ request, waitFor, added }) => {
      assert.deepEqual(ids(added), ['glm-5.3', 'test-new-go'])
      assert.ok(added.modelUpdate.models.some((model) => model.provider === 'opencode-go' && model.id === 'test-new-go'))
      await request('settings.update', { patch: { modelAutoUpdate: false } })
      const off = await waitFor((state) => JSON.stringify(ids(state)) === JSON.stringify(bundledIds))
      assert.deepEqual(ids(off), bundledIds)
      assert.equal(off.modelUpdate.opencodeGo, null)
      await request('settings.update', { patch: { modelAutoUpdate: true } })
      const on = await waitFor((state) => JSON.stringify(ids(state)) === JSON.stringify(['glm-5.3', 'test-new-go']))
      assert.deepEqual(on.modelUpdate.opencodeGo.missing, [])
    },
  })
})

test('MiniMax M3.1 Flash appears in the real picker when the service lists the official paid id', { timeout: 45_000 }, async (t) => {
  const template = openCodeModels(await readOpenCodeCatalog()).find((model) => model.api === 'openai-completions')
  const legacy = { ...template, id: 'minimax-m3.1-flash-free', name: 'MiniMax M3.1 Flash Free' }
  const added = await keyRefreshesCatalog(t, {
    provider: 'opencodeGo', account: 'opencodeGo', catalogProvider: 'opencode-go', probe: 'https://opencode.ai/inference/go/v1/models',
    probeBody: JSON.stringify({ data: [{ id: 'glm-5.3' }, { id: 'minimax-m3.1-flash' }] }),
    settings: { modelAutoUpdate: true },
    savedUpdates: {
      catalog: { format: 2, source: '1.4.0', providers: { 'opencode-go': { 'openai-completions': { [legacy.id]: legacy } } } },
      lastAdded: { at: Date.now(), source: '1.4.0', models: [{ provider: 'opencode-go', id: legacy.id, name: legacy.name }] },
    },
  })
  const models = added.catalog.models.filter((model) => model.provider === 'opencode-go')
  assert.deepEqual(models.map((model) => model.id).sort(), ['glm-5.3', 'minimax-m3.1-flash'])
  assert.equal(models.find((model) => model.id === 'minimax-m3.1-flash').name, 'MiniMax M3.1 Flash')
  assert.deepEqual(added.modelUpdate.opencodeGo.missing, [])
  assert.equal(added.modelUpdate.lastAdded.models[0].name, 'MiniMax M3.1 Flash')
})

test('an unknown official model is added from structured metadata without a pi-ai release or alias patch', { timeout: 60_000 }, async (t) => {
  const id = 'new-registry-model'
  await keyRefreshesCatalog(t, {
    provider: 'opencodeGo', account: 'opencodeGo', catalogProvider: 'opencode-go', probe: 'https://opencode.ai/inference/go/v1/models',
    settings: { modelAutoUpdate: true },
    probeBody: JSON.stringify({ data: [{ id: 'glm-5.3' }, { id }] }),
    registryBody: { 'opencode-go': {
      id: 'opencode-go', npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/inference/go/openai/v1',
      models: { [id]: {
        id, name: 'New Registry Model', tool_call: true, reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 64000 }, cost: { input: 1, output: 2 },
      } },
    } },
    afterAdded: async ({ added }) => {
      const models = added.catalog.models.filter((model) => model.provider === 'opencode-go')
      assert.deepEqual(models.map((model) => model.id).sort(), ['glm-5.3', id])
      assert.equal(models.find((model) => model.id === id).name, 'New Registry Model')
      assert.deepEqual(added.modelUpdate.opencodeGo.missing, [])
      assert.equal(added.modelUpdate.opencodeGo.definitionError, false)
      assert.ok(added.modelUpdate.models.some((model) => model.id === id && model.source === 'registry'))
      assert.ok(added.modelUpdate.lastAdded.models.some((model) => model.id === id))
    },
  })
})

test('a genuinely unsupported official id remains explicit in the update state rather than disappearing silently', { timeout: 45_000 }, async (t) => {
  const added = await keyRefreshesCatalog(t, {
    provider: 'opencodeGo', account: 'opencodeGo', catalogProvider: 'opencode-go', probe: 'https://opencode.ai/inference/go/v1/models',
    settings: { modelAutoUpdate: true },
    probeBody: JSON.stringify({ data: [{ id: 'glm-5.3' }, { id: 'no-supported-definition' }] }),
    registryBody: { 'opencode-go': { id: 'opencode-go', models: {
      'no-supported-definition': { id: 'no-supported-definition', provider: { npm: 'unsupported-sdk' } },
    } } },
  })
  assert.deepEqual(added.modelUpdate.opencodeGo.missing, ['no-supported-definition'])
  assert.equal(added.modelUpdate.opencodeGo.error, false)
  assert.ok(!added.catalog.models.some((model) => model.id === 'no-supported-definition'))
})

test('legacy Go service ids are reported as catalog exclusions, not pending definitions', { timeout: 45_000 }, async (t) => {
  const added = await keyRefreshesCatalog(t, {
    provider: 'opencodeGo', account: 'opencodeGo', catalogProvider: 'opencode-go', probe: 'https://opencode.ai/inference/go/v1/models',
    settings: { modelAutoUpdate: true },
    probeBody: JSON.stringify({ data: [{ id: 'glm-5.3' }, { id: 'legacy-model' }, { id: 'retired-model' }] }),
    registryBody: { 'opencode-go': { id: 'opencode-go', models: {
      'retired-model': { id: 'retired-model', status: 'deprecated' },
    } } },
  })
  assert.deepEqual(added.modelUpdate.opencodeGo.missing, [])
  assert.deepEqual(added.modelUpdate.opencodeGo.unlisted, ['legacy-model', 'retired-model'])
  assert.equal(added.modelUpdate.opencodeGo.definitionError, false)
  assert.deepEqual(added.catalog.models.filter((model) => model.provider === 'opencode-go').map((model) => model.id), ['glm-5.3'])
})

test('OpenCode Go models the service no longer lists leave the picker', { timeout: 45_000 }, async (t) => {
  const live = ['glm-5.3', 'kimi-k3', 'qwen3.8-max', 'hy3']
  const added = await keyRefreshesCatalog(t, {
    provider: 'opencodeGo', account: 'opencodeGo', catalogProvider: 'opencode-go', probe: 'https://opencode.ai/inference/go/v1/models',
    probeBody: JSON.stringify({ data: live.map((id) => ({ id })) }),
    settings: { modelAutoUpdate: true },
  })
  const ids = added.catalog.models.filter((model) => model.provider === 'opencode-go').map((model) => model.id).sort()
  assert.deepEqual(ids, [...live].sort())
})
