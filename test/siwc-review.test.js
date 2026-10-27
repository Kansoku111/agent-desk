import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import YAML from 'yaml'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { patchPiAiSource, RETRYABLE_KEY, retryableCheck, replayGuard } from '../server/retry-patch.js'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import { applyCatalogAdditions, configuredModelCatalog, shippedCatalog } from '../server/model-catalog.js'
import { newerModels, readFetchedCatalog } from '../server/model-updates.js'
import { homePatch } from '../server/dsh-config.js'
import { SIWC_API, SIWC_BASE_URL } from '../server/siwc-route.js'
import { withSiwc } from '../server/siwc-request.js'
import { SIWC_LIMIT_CODE, SIWC_LIMIT_MESSAGE, SIWC_LIMIT_TEXT } from '../server/siwc-usage-error.js'
import { describeError } from '../server/thread-utils.js'
import { stream } from '@earendil-works/pi-ai/api/openai-responses'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const model = {
  id: 'gpt-mock',
  provider: 'openai-codex',
  api: SIWC_API,
  baseUrl: SIWC_BASE_URL,
  reasoning: true,
  input: ['text'],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0
  },
  contextWindow: 272000,
  maxTokens: 32768
}
async function classify() {
  const source = patchPiAiSource(await fs.readFile(require.resolve('@deepseek-ai/dsh-llm-pi-ai'), 'utf8'))
  const start = source.indexOf('function classifyPiAiError(message) {')
  const end = source.indexOf('\n}', start)
  // dsh's own quota rule, as the installed dsh judges an exhausted quota.
  const dshLlm = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  return new Function('isQuotaExceededError', 'QUOTA_EXCEEDED_CODE', `${source.slice(start, end + 2)} return classifyPiAiError`)(dshLlm.isQuotaExceededError, dshLlm.QUOTA_EXCEEDED_CODE)
}
test('DSH retry policy restores eight retries while usage/auth/4xx stay terminal and a rate limit is retried', async () => {
  globalThis[Symbol.for(RETRYABLE_KEY)] = retryableCheck(isRetryableAssistantError)
  try {
    const classifier = await classify()
    const profile = YAML.parse(homePatch())[0].config.providers['openai-codex']
    assert.equal(profile.retryPolicy.maxRetries, 8)
    for (const text of ['503 subscription_sharing_usage_unavailable network timeout', '429 subscription_sharing_usage_limit_exceeded', 'response.failed subscription_sharing_usage_limit_exceeded', 'The ChatGPT user reached their Subscription Sharing usage limit']) assert.equal(classifier(text), 'PI_AI_ERROR', text)
    for (const text of ['401 Unauthorized', '403 forbidden']) assert.equal(classifier(text), 'AUTH', text)
    for (const text of ['400 invalid request', '404 not found']) assert.equal(classifier(text), 'INVALID_REQUEST', text)
    // A rate limit is dsh's transient class, so the request is sent again.
    assert.equal(classifier('429 rate limit'), 'RATE_LIMIT')
    assert.equal(classifier('503 server unavailable'), 'SERVER')
    assert.equal(classifier('network fetch failed'), 'TRANSPORT')
    assert.equal(classifier('SIWC stream did not complete (interrupted)'), 'TRANSPORT')
    assert.equal(classifier('stream ended before a terminal event'), 'TRANSPORT')
  } finally {
    delete globalThis[Symbol.for(RETRYABLE_KEY)]
  }
})
test('replay guard keeps distinct same-length requests and drops only old encrypted reasoning on third identical send', () => {
  const guard = replayGuard()
  const make = text => ({
    model: 'gpt-mock',
    prompt_cache_key: 'same',
    input: [{
      type: 'reasoning',
      id: 'encrypted',
      encrypted_content: 'cipher'
    }, {
      type: 'reasoning',
      id: 'summary',
      summary: []
    }, {
      role: 'user',
      content: text
    }]
  })
  assert.equal(guard(make('one')), undefined)
  assert.equal(guard(make('two')), undefined)
  assert.equal(guard(make('one')), undefined)
  assert.equal(guard(make('one')), undefined)
  const changed = guard(make('one'))
  assert.ok(!changed.input.some(item => item.id === 'encrypted'))
  assert.ok(changed.input.some(item => item.id === 'summary'))
})
test('installed, bundled, old fetched and custom GPT catalogs all normalize to public SIWC', async t => {
  const oldModel = {
    ...model,
    id: 'gpt-old',
    name: 'Old',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    headers: {
      originator: 'pi',
      authorization: 'must-not-copy'
    }
  }
  const original = {
    'openai-codex-responses': {
      'gpt-old': oldModel
    }
  }
  const fetched = {
    providers: {
      'openai-codex': {
        'openai-codex-responses': {
          'gpt-fetched': {
            ...oldModel,
            id: 'gpt-fetched'
          }
        }
      }
    }
  }
  const result = applyCatalogAdditions(original, 'openai-codex', [{
    provider: 'openai-codex',
    id: 'gpt-custom',
    template: 'gpt-old'
  }], fetched)
  const verify = catalog => {
    assert.deepEqual(Object.keys(catalog), [SIWC_API])
    for (const item of Object.values(catalog[SIWC_API])) {
      assert.equal(item.api, SIWC_API)
      assert.equal(item.baseUrl, SIWC_BASE_URL)
      assert.equal(item.headers?.authorization, undefined)
      assert.equal(item.headers?.originator, undefined)
    }
  }
  verify(result.data)
  verify((await shippedCatalog()).providers['openai-codex'])
  const extras = JSON.parse(await fs.readFile(new URL('../server/catalog-extras.json', import.meta.url), 'utf8'))
  verify(extras.providers['openai-codex'])
  const newer = newerModels({
    provider: 'openai-codex',
    data: fetched.providers['openai-codex'],
    shipped: original,
    keys: new Set(Object.keys(oldModel))
  })
  verify(newer.groups)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siwc-route-cache-'))
  t.after(() => fs.rm(dir, {
    recursive: true,
    force: true
  }))
  await fs.writeFile(path.join(dir, 'model-updates.json'), JSON.stringify({
    catalog: {
      source: '2.0.0',
      ...fetched
    }
  }))
  verify((await readFetchedCatalog(dir)).providers['openai-codex'])
  const definitions = await configuredModelCatalog([], fetched)
  const profile = YAML.parse(homePatch({
    catalogModels: definitions.definitions
  }))[0].config.providers['openai-codex']
  assert.equal(profile.api, SIWC_API)
  assert.equal(profile.baseURL, SIWC_BASE_URL)
  assert.doesNotMatch(JSON.stringify(profile), /chatgpt\.com\/backend-api|openai-codex-responses/)
})
test('task error stays actionable instead of the generic wait-or-switch-model summary', async () => {
  const described = describeError(
    { message: `Internal error: turn failed: ${SIWC_LIMIT_CODE}` },
    { model: '["openai-codex","gpt-mock"]' },
  )
  assert.equal(described.message, SIWC_LIMIT_TEXT)
  assert.ok(described.detail.includes(SIWC_LIMIT_CODE))
  const ui = await fs.readFile(new URL('../web/src/components/TurnView.tsx', import.meta.url), 'utf8')
  assert.match(ui, /href="https:\/\/chatgpt.com\/settings\/usage"/)
  const accounts = await fs.readFile(new URL('../web/src/components/settings/ChatGptConnections.tsx', import.meta.url), 'utf8')
  assert.match(accounts, /Using ChatGPT plan/)
  assert.match(accounts, /Manage usage/)
})

test('actual GPT transport preserves optional escalation controls in native and PTC schemas', async () => {
  for (const name of ['pwsh', 'run_code']) {
    const required = name === 'run_code' ? ['code', 'description'] : ['command', 'description']
    const properties = Object.fromEntries([...required, 'justification'].map(key => [key, { type: 'string' }]))
    properties.sandbox_permissions = { type: 'string', enum: ['workspace-write', 'danger-full-access'] }
    let sent, upstream
    const options = withSiwc(model, { maxRetries: 0, onPayload: (payload) => { upstream = payload; return payload } }, {
      client: { auth: async () => ({ access_token: 'fixture-only' }) },
      fetch: async (_url, init) => {
        sent = JSON.parse(init.body)
        const response = { id: 'fixture', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
        return new Response('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const result = await stream(model, {
      messages: [
        { role: 'system', content: '', toolsAdded: [{ name, description: 'Inspect fixture source', parameters: { type: 'object', properties, required, additionalProperties: false } }], timestamp: 0 },
        { role: 'user', content: 'Inspect fixture source', timestamp: 0 },
      ],
    }, options).result()
    assert.equal(result.stopReason, 'stop', result.errorMessage)
    assert.equal(upstream.tools[0].strict, undefined, 'exercise the installed provider default that omits strict')
    const tool = sent.tools.find(tool => tool.name === 'agent_desk').tools[0]
    assert.equal(tool.name, name)
    assert.equal(tool.strict, false)
    assert.deepEqual(tool.parameters.required, required)
    assert.deepEqual(tool.parameters.properties.sandbox_permissions.enum, ['workspace-write', 'danger-full-access'])
    assert.ok(!tool.parameters.required.includes('sandbox_permissions'))
  }
})

test('HTTP429 and streamed usage-limit errors reach actual pi-ai task error with actionable Japanese link, no retries', async () => {
  for (const streamed of [false, true]) {
    let calls = 0
    const fetcher = async () => {
      calls++
      const error = {
        code: SIWC_LIMIT_CODE,
        message: 'raw usage limit'
      }
      return streamed ? new Response(`data: ${JSON.stringify({
        type: 'response.failed',
        response: {
          status: 'failed',
          error
        }
      })}\n\n`, {
        headers: {
          'content-type': 'text/event-stream'
        }
      }) : Response.json({
        error
      }, {
        status: 429
      })
    }
    const options = withSiwc(model, {
      maxRetries: 0
    }, {
      client: {
        auth: async () => ({
          access_token: 'mock-only'
        })
      },
      fetch: fetcher
    })
    const events = stream(model, {
      messages: [{
        role: 'user',
        content: 'hi',
        timestamp: 0
      }]
    }, options)
    const message = await events.result()
    assert.equal(message.stopReason, 'error')
    assert.match(message.errorMessage, /ChatGPT のプランの利用上限に達しました/)
    assert.match(message.errorMessage, /https:\/\/chatgpt.com\/settings\/usage/)
    assert.match(message.errorMessage, /subscription_sharing_usage_limit_exceeded/)
    assert.equal(calls, 1)
    assert.equal((await classify())(message.errorMessage), 'PI_AI_ERROR')
  }
  assert.ok(SIWC_LIMIT_MESSAGE.includes('クレジット'))
})
