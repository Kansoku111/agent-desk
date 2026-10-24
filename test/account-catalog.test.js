import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
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
  t.after(async () => {
    await tick()
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
  const catalog = await new Catalog(path.join(home, 'catalog.json'), signature(true)).load()
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
  t.after(async () => {
    await tick()
    await fs.rm(home, { recursive: true, force: true })
  })
  const signature = (ids) => JSON.stringify({ opencodeGo: true, opencodeGoModels: ids })
  const options = (ids) => [{ id: 'model', options: [{ group: 'opencode-go', options: ids.map((id) => ({ value: JSON.stringify(['opencode-go', id]), name: id })) }] }]
  const catalog = await new Catalog(path.join(home, 'catalog.json'), signature(['glm-5.3', 'space-bunny'])).load()
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
 * discovery, with no provider requests or real credentials: only the free
 * key-validation endpoint is mocked.
 */
async function keyRefreshesCatalog(t, { provider, account, catalogProvider, probe, probeBody = '{"data":[]}', settings = { modelAutoUpdate: false }, savedUpdates = null, afterAdded = null }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-account-catalog-'))
  const hook = path.join(home, 'offline-fetch.mjs')
  await fs.writeFile(hook, `globalThis.fetch = async (url) => {
    if (String(url) === ${JSON.stringify(probe)}) return new Response(${JSON.stringify(probeBody)}, { status: 200 });
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
  const replies = new Map()
  let sequence = 0, helloResolve
  const hello = new Promise((resolve) => { helloResolve = resolve })
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    if (frame.event === 'hello') helloResolve(frame.state)
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
  assert.equal(saved.check.status, 'valid')
  const added = await waitFor((state) => models(state).length > 0)
  assert.equal(added.accounts[account].configured, true)
  assert.ok(models(added).every((model) => model.id && model.value))
  if (afterAdded) await afterAdded({ request, waitFor, added })
  await request('account.removeKey', { provider })
  const removed = await waitFor((state) => models(state).length === 0)
  assert.equal(removed.accounts[account].configured, false)
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

test('new OpenCode models reach the real picker and auto-sync off/on restores the correct catalogs', { timeout: 60_000 }, async (t) => {
  const template = openCodeModels(await readOpenCodeCatalog()).find((model) => model.api === 'openai-completions')
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
      const off = await waitFor((state) => ids(state).includes('space-bunny') && !ids(state).includes('test-new-go'))
      assert.equal(off.modelUpdate.opencodeGo, null)
      await request('settings.update', { patch: { modelAutoUpdate: true } })
      const on = await waitFor((state) => JSON.stringify(ids(state)) === JSON.stringify(['glm-5.3', 'test-new-go']))
      assert.deepEqual(on.modelUpdate.opencodeGo.missing, [])
    },
  })
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
