import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch } from '../server/dsh-config.js'
import { openscaleRoute } from '../server/openscale.js'

test('OpenScale routes only standard models through the documented endpoint', () => {
  const route = openscaleRoute()
  assert.equal(route.api, 'anthropic-messages')
  assert.equal(route.baseURL, 'https://api.openscale.so/anthropic')
  assert.equal(route.apiKeyEnv, 'OPENSCALE_API_KEY')
  assert.deepEqual(route.models.map(({ id }) => id), ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'])
  assert.ok(route.models.every(({ maxTokens }) => maxTokens === 32768))
  assert.deepEqual(route.compat, { forceAdaptiveThinking: true })
  // GLM has two documented levels; DeepSeek adds max, the only higher level measured to think more.
  assert.deepEqual(route.models.map(({ reasoningEfforts }) => reasoningEfforts), [{ low: 'low', high: 'high', max: 'max' }, { low: 'low', high: 'high' }])
  const providers = (enabled) => YAML.parse(homePatch({ openscale: enabled })).find((row) => row.id === 'llm-pi-ai').config.providers
  assert.equal(providers(false).openscale, undefined)
  assert.deepEqual(providers(true).openscale, route)
})

test('OpenScale thinking choices reach the Messages request', async (t) => {
  const { createServer } = await import('node:http')
  const { anthropicMessagesApi } = await import('@earendil-works/pi-ai/api/anthropic-messages.lazy')
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture' } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const model = { id: 'deepseek/deepseek-v4.1-flash', name: 'fixture', api: 'anthropic-messages', provider: 'openscale',
    baseUrl: `http://127.0.0.1:${server.address().port}`, reasoning: true, compat: openscaleRoute().compat,
    thinkingLevelMap: openscaleRoute().models[0].reasoningEfforts, input: ['text'], contextWindow: 1048568, maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const context = { messages: [{ role: 'user', content: 'test', timestamp: Date.now() }] }
  for (const reasoning of ['low', 'high', 'max']) {
    await anthropicMessagesApi().streamSimple(model, context, { apiKey: 'fixture-key', reasoning, maxRetries: 0 }).result()
  }
  assert.deepEqual(seen.map((body) => body.output_config?.effort), ['low', 'high', 'max'])
  assert.ok(seen.every((body) => body.thinking?.type === 'adaptive'))
})


test('OpenScale uses the app-managed key instead of an inherited shell key', async () => {
  const { dshEnv } = await import('../server/dsh-env.js')
  const env = dshEnv({ dshHome: 'fixture-home', credentials: 'fixture-credentials' }, 'workspace-write', { OPENSCALE_API_KEY: 'fixture-inherited', PATH: 'fixture-path' })
  assert.equal(env.OPENSCALE_API_KEY, undefined)
  assert.equal(env.PATH, 'fixture-path')
})
