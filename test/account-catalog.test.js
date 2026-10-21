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

test('saving and removing a DeepSeek key refreshes the picker catalog without a manual refresh', { timeout: 45_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-account-catalog-'))
  const hook = path.join(home, 'offline-fetch.mjs')
  // Exercise the real save handler, runtimes and discovery, with no provider
  // requests or real credentials. Only the free key-validation endpoint is mocked.
  await fs.writeFile(hook, `globalThis.fetch = async (url) => {
    if (String(url) === 'https://api.deepseek.com/models') return new Response('{"data":[]}', { status: 200 });
    throw new Error('offline account-catalog test');
  }`)
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ modelAutoUpdate: false }))
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
  const deepseek = (state) => state.catalog.models.filter((model) => model.provider === 'deepseek-official')
  const initial = await waitFor((state) => state.catalog.models.length > 0)
  assert.equal(deepseek(initial).length, 0)
  const saved = await request('account.setKey', { provider: 'deepseek', key: 'sk-test-only-not-a-real-key' })
  assert.equal(saved.check.status, 'valid')
  const added = await waitFor((state) => deepseek(state).length > 0)
  assert.equal(added.accounts.deepseek.configured, true)
  assert.ok(deepseek(added).every((model) => model.id && model.value))
  await request('account.removeKey', { provider: 'deepseek' })
  const removed = await waitFor((state) => deepseek(state).length === 0)
  assert.equal(removed.accounts.deepseek.configured, false)
  assert.ok(removed.catalog.models.some((model) => model.provider === 'openai-codex'))
})
