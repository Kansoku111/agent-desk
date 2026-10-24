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
import YAML from 'yaml'
import { homePatch } from '../server/dsh-config.js'
import { discoverLocalModels, localRoute, normalizeBaseUrl, parseModelList } from '../server/local-llm.js'
import { planSettingsUpdate, DEFAULT_SETTINGS } from '../server/settings.js'
import { dshEnv } from '../server/dsh-env.js'
import { mergeTeamConfig, teamConfig } from '../server/team-config.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const tick = () => new Promise((resolve) => setTimeout(resolve, 50))

test('base URLs are normalized and checked', () => {
  assert.equal(normalizeBaseUrl(' http://localhost:11434/v1/ '), 'http://localhost:11434/v1')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234/v1?x=1#y'), 'http://127.0.0.1:1234/v1')
  assert.throws(() => normalizeBaseUrl('localhost:11434'), /http/)
  assert.throws(() => normalizeBaseUrl('ftp://host/v1'), /http/)
  assert.throws(() => normalizeBaseUrl('http://user:pass@host/v1'), /認証情報/)
  assert.throws(() => normalizeBaseUrl(''), /URL/)
})

test('model lists from Ollama, vLLM, LM Studio and llama.cpp are read', () => {
  assert.deepEqual(parseModelList({ object: 'list', data: [{ id: 'qwen3:8b' }, { id: 'qwen3:8b' }, { id: 'bad id' }] }), [{ id: 'qwen3:8b' }])
  assert.deepEqual(parseModelList({ data: [{ id: 'org/model', max_model_len: 32768 }] }), [{ id: 'org/model', contextWindow: 32768 }])
  assert.deepEqual(parseModelList({ data: [{ id: 'm.gguf', meta: { n_ctx_train: 4096 } }] }), [{ id: 'm.gguf', contextWindow: 4096 }])
  assert.deepEqual(parseModelList({ models: { a: { context_length: 8192 } } }), [{ id: 'a', contextWindow: 8192 }])
  assert.deepEqual(parseModelList({ models: ['b'] }), [{ id: 'b' }])
  assert.deepEqual(parseModelList(null), [])
})

test('discovery sends the key and explains failures', async () => {
  const seen = []
  const reply = (status, body) => async (url, init) => {
    seen.push([url, init.headers])
    return new Response(JSON.stringify(body), { status })
  }
  assert.deepEqual(await discoverLocalModels('http://h/v1', 'k', { fetchImpl: reply(200, { data: [{ id: 'm' }] }) }), [{ id: 'm' }])
  assert.deepEqual(seen[0], ['http://h/v1/models', { authorization: 'Bearer k' }])
  await assert.rejects(discoverLocalModels('http://h/v1', null, { fetchImpl: reply(401, {}) }), /API キー/)
  await assert.rejects(discoverLocalModels('http://h/v1', null, { fetchImpl: reply(404, {}) }), /HTTP 404/)
  await assert.rejects(discoverLocalModels('http://h/v1', null, { fetchImpl: reply(200, { data: [] }) }), /モデルがありません/)
  await assert.rejects(discoverLocalModels('http://h/v1', null, { fetchImpl: async () => { throw new Error('refused') } }), /接続できません/)
})

test('dsh does not inherit a local model key that should come from the credential store', () => {
  const env = dshEnv({ dshHome: 'dsh-home', fastMode: 'fast-mode', credentials: 'credentials' }, 'workspace-write', {
    LOCAL_LLM_API_KEY: 'inherited-key',
    KEEP_ME: 'unchanged',
  })
  assert.equal(env.LOCAL_LLM_API_KEY, undefined)
  assert.equal(env.KEEP_ME, 'unchanged')
  assert.equal(localRoute({ baseURL: 'http://h/v1', models: [{ id: 'a' }] }).apiKeyEnv, undefined)
})

test('the route joins the home patch only when it has models', () => {
  assert.equal(localRoute({ baseURL: 'http://h/v1', models: [] }), null)
  assert.equal(localRoute(undefined), null)
  const keyless = localRoute({ baseURL: 'http://h/v1', models: [{ id: 'a' }, { id: 'b', contextWindow: 8192 }] })
  assert.deepEqual(keyless.headers, { authorization: 'Bearer local' })
  assert.equal(keyless.apiKeyEnv, undefined)
  assert.deepEqual(keyless.models[1], { id: 'b', name: 'b', input: ['text'], reasoningEfforts: false, contextWindow: 8192, maxTokens: 2048 })
  const keyed = localRoute({ baseURL: 'http://h/v1', models: [{ id: 'a' }] }, { keyed: true })
  assert.equal(keyed.apiKeyEnv, 'LOCAL_LLM_API_KEY')
  assert.equal(keyed.headers, undefined)

  const providers = (options) => YAML.parse(homePatch(options)).find((row) => row.id === 'llm-pi-ai').config.providers
  assert.equal(providers({})['local-llm'], undefined)
  assert.deepEqual(providers({ localRoute: keyless })['local-llm'], keyless)
})

test('settings take a local server and clear it', () => {
  const current = structuredClone(DEFAULT_SETTINGS)
  const { settings, effects } = planSettingsUpdate(current, { localLlm: { baseURL: 'http://h:1/v1/', models: [{ id: 'q:1', contextWindow: 4096 }] } }, 0)
  assert.deepEqual(settings.localLlm, { baseURL: 'http://h:1/v1', models: [{ id: 'q:1', contextWindow: 4096 }] })
  assert.equal(effects.homePatch, true)
  assert.equal(effects.modelCatalog, true)
  assert.equal(effects.modelCheck, false)
  assert.deepEqual(planSettingsUpdate(settings, { localLlm: { baseURL: null, models: [{ id: 'x' }] } }, 0).settings.localLlm, { baseURL: null, models: [] })
  assert.throws(() => planSettingsUpdate(current, { localLlm: { baseURL: 'http://h/v1', models: [{ id: 'bad id' }] } }, 0), /モデル ID/)
  assert.throws(() => planSettingsUpdate(current, { localLlm: { baseURL: 'http://h/v1', models: 'x' } }, 0), /配列/)
})

test('teams can use local models as children', () => {
  const config = teamConfig({})
  assert.equal(config.local.enabled, false)
  const next = mergeTeamConfig({}, { local: { enabled: true, low: { model: 'qwen3:8b' }, mid: { model: 'org/model' } } })
  assert.equal(next.local.enabled, true)
  assert.equal(next.local.low.model, 'qwen3:8b')
  assert.equal(next.local.mid.model, 'org/model')
  assert.throws(() => mergeTeamConfig({}, { deepseek: { low: { model: 'qwen3:8b' } } }), /モデル/)
})

/** A tiny OpenAI-compatible server: one model that answers every request with the same text. */
async function mockServer(reply, streamDelayMs = 0) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, headers: req.headers, body })
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model:1b', object: 'model' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'mock-model:1b' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const content of streamDelayMs ? [...reply] : [reply]) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
        if (streamDelayMs) await new Promise((resolve) => setTimeout(resolve, streamDelayMs))
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/v1` }
}

test('a task runs on a local model end to end', { timeout: 90_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-local-llm-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-local-llm-ws-'))
  const mock = await mockServer('ローカルからの返事', 120)
  const hook = path.join(home, 'offline-fetch.mjs')
  // Only the mock server is reachable from the app server; dsh talks to it directly.
  await fs.writeFile(hook, `const real = globalThis.fetch; globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(${JSON.stringify(mock.url)})) return real(url, init);
    throw new Error('offline local-llm test');
  }`)
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ modelAutoUpdate: false, browserTool: false, imageTool: false }))
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
    mock.server.close()
    for (const dir of [home, workspace]) {
      assert.equal(path.dirname(dir), os.tmpdir())
      await fs.rm(dir, { recursive: true, force: true })
    }
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
  const speeds = []
  const hello = new Promise((resolve) => { helloResolve = resolve })
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    if (frame.event === 'turn' && frame.turn?.outputSpeed) speeds.push(frame.turn.outputSpeed)
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
  const waitFor = async (read, predicate, what) => {
    let last
    for (let i = 0; i < 600; i++) {
      last = await read()
      if (predicate(last)) return last
      await tick()
    }
    assert.fail(`${what} did not happen: ${output}\nlast: ${JSON.stringify(last).slice(0, 4000)}`)
  }
  const local = (state) => state.catalog.models.filter((model) => model.provider === 'local-llm')

  const set = await request('localLlm.set', { baseURL: `${mock.url}/` })
  assert.deepEqual(set.models, [{ id: 'mock-model:1b' }])
  const state = await waitFor(() => request('state.get'), (next) => local(next).length > 0, 'the local model joining the catalog')
  assert.equal(state.accounts.localLlm.configured, true)
  const model = local(state)[0]
  assert.equal(model.id, 'mock-model:1b')

  const { thread } = await request('thread.create', { workspace, model: model.value, effort: '', permissionMode: 'read-only', text: 'こんにちは' })
  const done = await waitFor(() => request('thread.get', { threadId: thread.id }), (next) => JSON.stringify(next).includes('ローカルからの返事') && !next.thread?.busy, 'the local reply')
  assert.ok(done)
  assert.ok(speeds.some((speed) => speed.state === 'streaming' && speed.tokensPerSecond > 0), `live speed must cross SSE → dsh → ACP → WebSocket: ${JSON.stringify({ speeds, turns: done.turns })}`)
  const speed = done.turns.at(-1).outputSpeed
  assert.equal(speed.state, 'done')
  assert.equal(speed.estimated, true)
  assert.ok(speed.tokensPerSecond > 0 && Number.isFinite(speed.tokensPerSecond))
  const chat = mock.requests.find((entry) => entry.url === '/v1/chat/completions')
  assert.equal(chat.headers.authorization, 'Bearer local')
  const body = JSON.parse(chat.body)
  assert.equal(body.model, 'mock-model:1b')
  assert.equal(body.store, undefined)
  assert.ok(body.messages.every((message) => message.role !== 'developer'))

  await request('localLlm.remove')
  await waitFor(() => request('state.get'), (next) => local(next).length === 0 && !next.accounts.localLlm.configured, 'the local model leaving the catalog')
})
