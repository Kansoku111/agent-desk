import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parseCodexModels } from '../server/codex-models.js'
import {
  CLAUDE_FAST_BETA, applyFastMode, fastModeState, fastModels, fastMultiplier, fastPricing, recordFastPeriod,
} from '../server/fast-mode.js'
import { summarizeUsage } from '../server/usage.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const claude = { api: 'anthropic-messages', provider: 'anthropic', id: 'claude-opus-5-5' }
const gpt = { api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-5.5' }
const on = fastModeState({ anthropic: true, 'openai-codex': true }, fastModels({ 'gpt-5.5': { fast: '1.5x speed' } }))

test('parseCodexModels keeps the fast tier note', () => {
  assert.deepEqual(parseCodexModels({
    models: [
      { slug: 'gpt-5.5', context_window: 272000, service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] },
      { slug: 'memory4-dream', context_window: 272000, service_tiers: [] },
    ],
  }), {
    'gpt-5.5': { contextWindow: 272000, maxContextWindow: 272000, fast: '1.5x speed, increased usage' },
    'memory4-dream': { contextWindow: 272000, maxContextWindow: 272000 },
  })
})

test('applyFastMode sets speed and the beta on fast-capable Claude models', () => {
  assert.deepEqual(applyFastMode({ model: 'claude-opus-5-5', betas: ['a'] }, claude, on), {
    model: 'claude-opus-5-5', betas: ['a', CLAUDE_FAST_BETA], speed: 'fast',
  })
  assert.equal(applyFastMode({ model: 'x' }, { ...claude, id: 'claude-sonnet-5-5' }, on), undefined)
  assert.equal(applyFastMode({ model: 'x' }, claude, fastModeState({}, fastModels())), undefined)
})

test('GPT fast mode stays unavailable even when an old preference enables it', () => {
  assert.equal(on['openai-codex'].enabled, false)
  assert.deepEqual(fastModels({ 'gpt-5.5': { fast: 'old priority' } })['openai-codex'], {})
  assert.equal(applyFastMode({ model: 'gpt-5.5' }, gpt, on), undefined)
  assert.equal(applyFastMode({ model: 'gpt-6' }, { ...gpt, id: 'gpt-6' }, on), undefined)
  // A custom route that happens to speak the same protocol is left alone.
  assert.equal(applyFastMode({ model: 'x' }, { ...claude, provider: 'my-proxy' }, on), undefined)
})

test('fast periods price Claude responses at twice the rate while on', () => {
  let periods = recordFastPeriod([], true, 1000)
  periods = recordFastPeriod(periods, true, 1500)
  periods = recordFastPeriod(periods, false, 2000)
  assert.deepEqual(periods, [[1000, 2000]])
  const fast = fastPricing(periods)
  assert.equal(fastMultiplier(fast, 'anthropic/claude-opus-5-5', 1500), 2)
  assert.equal(fastMultiplier(fast, 'anthropic/claude-opus-5-5', 2500), 1)
  assert.equal(fastMultiplier(fast, 'anthropic/claude-sonnet-5-5', 1500), 1)

  const pricing = new Map([['anthropic/claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }]])
  pricing.fast = fast
  const event = (time) => ({
    type: 'assistant/message',
    time,
    data: { usage: { inputTokens: 1_000_000, outputTokens: 0 }, message: { source: { provider: 'anthropic', model: 'claude-opus-5-5' } } },
  })
  assert.equal(summarizeUsage([event(1500), event(2500)], 0, pricing).cost, 8 + 4)
})

test('the hook adds fast mode to requests pi-ai sends', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-fast-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'fast-mode.json')
  await fs.writeFile(stateFile, JSON.stringify(on))
  // A local server stands in for both APIs and records what arrives.
  const probe = `
    import http from 'node:http'
    import zlib from 'node:zlib'
    import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
    import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
    const seen = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        let body = Buffer.concat(chunks)
        if (req.headers['content-encoding'] === 'zstd') body = zlib.zstdDecompressSync(body)
        seen.push({ beta: req.headers['anthropic-beta'] ?? null, body: JSON.parse(body.toString('utf8')) })
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'probe' } }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = 'http://127.0.0.1:' + server.address().port
    const model = (api, provider, id) => ({ id, name: id, api, provider, baseUrl, reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
    const context = { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }
    const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } })).toString('base64url')
    const runs = [
      [anthropicMessagesApi(), model('anthropic-messages', 'anthropic', 'claude-opus-5-5'), 'sk-ant-api-test'],
      [anthropicMessagesApi(), model('anthropic-messages', 'anthropic', 'claude-sonnet-5-5'), 'sk-ant-api-test'],
      [openAICodexResponsesApi(), model('openai-codex-responses', 'openai-codex', 'gpt-5.5'), 'x.' + claims + '.y'],
    ]
    for (const [api, m, apiKey] of runs) await api.streamSimple(m, context, { apiKey, maxRetries: 0, transport: 'sse' }).result()
    server.close()
    console.log(JSON.stringify(seen))
  `
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', pathToFileURL(path.join(root, 'server', 'fast-mode-hook.js')).href,
    '--input-type=module', '-e', probe,
  ], { cwd: root, env: { ...process.env, AGENT_DESK_FAST_MODE: stateFile }, timeout: 30_000 })
  const [opus, sonnet, codex] = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.equal(opus.body.speed, 'fast')
  assert.match(opus.beta, /fast-mode-2026-02-01/)
  assert.equal(sonnet.body.speed, undefined)
  assert.doesNotMatch(sonnet.beta ?? '', /fast-mode/)
  assert.equal(codex.body.service_tier, undefined)
})
