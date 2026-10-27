import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import { patchPayloadSource, patchPiAiSource, PAYLOAD_KEY, replayGuard, RETRYABLE_KEY, retryableCheck } from '../server/retry-patch.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The dsh-llm-pi-ai module the installed dsh loads. */
function installedSource() {
  return fs.readFileSync(path.join(piAiDir(), 'lib/index.js'), 'utf8')
}

/** The dsh-llm-pi-ai package the installed dsh loads. */
function piAiDir() {
  const dshRequire = createRequire(path.join(root, 'node_modules/@deepseek-ai/dsh/package.json'))
  return path.dirname(dshRequire.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'))
}

/** dsh-llm as the installed dsh-llm-pi-ai imports it: its own quota rule and codes. */
const dshLlm = await import(pathToFileURL(createRequire(path.join(piAiDir(), 'package.json')).resolve('@deepseek-ai/dsh-llm')).href)

/** dsh's classifyPiAiError from a module source, as a callable function. */
function classifier(source) {
  const start = source.indexOf('function classifyPiAiError(message) {')
  const end = source.indexOf('\n}', start)
  // The rule the installed dsh judges an exhausted quota with, and the code it
  // reports for one, are dsh-llm's own.
  return new Function('isQuotaExceededError', 'QUOTA_EXCEEDED_CODE', `${source.slice(start, end + 2)} return classifyPiAiError`)(dshLlm.isQuotaExceededError, dshLlm.QUOTA_EXCEEDED_CODE)
}

test('the installed dsh-llm-pi-ai takes the retry patch, and still parses', () => {
  const patched = patchPiAiSource(installedSource())
  assert.ok(patched, 'dsh-llm-pi-ai no longer matches retry-patch.js; update the patch for this dsh')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-retry-')), 'index.mjs')
  try {
    fs.writeFileSync(file, patchPayloadSource(patched) ?? patched)
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

test('failures pi-ai knows as transient become retryable, other failures keep their class', () => {
  const key = Symbol.for(RETRYABLE_KEY)
  globalThis[key] = retryableCheck(isRetryableAssistantError)
  try {
    const before = classifier(installedSource())
    const after = classifier(patchPiAiSource(installedSource()))
    // The failures this fixes: unpatched, each is the non-retried catch-all.
    for (const message of [
      'WebSocket closed 1000',
      'exceeded request buffer limit while retrying upstream',
      'Codex error: An error occurred while processing your request. You can retry your request',
    ]) {
      assert.equal(before(message), 'PI_AI_ERROR', message)
      assert.equal(after(message), 'TRANSPORT', message)
    }
    // A frame too big fails again on a retry.
    assert.equal(after('WebSocket closed 1009 message too big'), 'PI_AI_ERROR')
    // dsh's own classes come first and stay as they were.
    assert.equal(after('401 Unauthorized'), 'AUTH')
    assert.equal(after('429 rate limit'), 'RATE_LIMIT')
    assert.equal(after('400 invalid request'), 'INVALID_REQUEST')
    assert.equal(after('pi-ai provider "anthropic" has no configured model "gpt"'), 'PI_AI_ERROR')
    assert.equal(after('insufficient_quota: billing hard limit'), 'QUOTA')
  } finally {
    delete globalThis[key]
  }
})

test('without pi-ai\'s check the patched rule changes nothing', () => {
  const after = classifier(patchPiAiSource(installedSource()))
  assert.equal(after('WebSocket closed 1000'), 'PI_AI_ERROR')
})

test('a rate limit is a rate limit again, and a hard limit stays a hard limit', () => {
  const key = Symbol.for(RETRYABLE_KEY)
  globalThis[key] = retryableCheck(isRetryableAssistantError)
  try {
    const upstream = classifier(installedSource())
    const patched = classifier(patchPiAiSource(installedSource()))
    // dsh retries the failures it classes as transient, and only those.
    const retried = new Set(dshLlm.resolveRetryPolicy(undefined, 'llm-pi-ai').retryableCodes)
    // The failures a provider reports with its own wording, the class the
    // installed dsh gives them, and the class the patched rule gives them.
    const cases = [
      ['a rate limit', 'openai-codex API error (429): 429 {"error":{"message":"Rate limit reached for gpt-5.1 in organization org-x on requests per min. Limit: 1000, Used: 1000.","type":"requests","code":"rate_limit_exceeded"}}', 'RATE_LIMIT', 'RATE_LIMIT'],
      ['a rate limit', '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit. Please try again later."}}', 'RATE_LIMIT', 'RATE_LIMIT'],
      ['a bad request', 'openai-codex API error (400): 400 {"error":{"message":"Invalid request","type":"invalid_request_error"}}', 'INVALID_REQUEST', 'INVALID_REQUEST'],
      ['a refused key', 'openai-codex API error (401): 401 {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}', 'AUTH', 'AUTH'],
      ['a forbidden model', 'openai-codex API error (403): 403 {"error":{"message":"Your API key does not have access to this model","type":"forbidden"}}', 'AUTH', 'AUTH'],
      ['an exhausted quota', 'openai-codex API error (429): 429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}', 'QUOTA', 'QUOTA'],
      // A shared subscription limit and a free-tier limit are permanent too,
      // though the installed dsh cannot tell them from a rate limit.
      ['a shared subscription limit', 'openai-codex API error (429): 429 {"error":{"message":"subscription_sharing_usage_limit_exceeded: ChatGPT のプランの利用上限に達しました。","type":"invalid_request_error","code":"subscription_sharing_usage_limit_exceeded"}}', 'RATE_LIMIT', 'PI_AI_ERROR'],
      ['a free-tier limit', 'opencode-go API error (429): 429 {"error":{"type":"FreeUsageLimitError","message":"Your free usage limit has been reached."}}', 'RATE_LIMIT', 'QUOTA'],
    ]
    for (const [name, message, upstreamClass, patchedClass] of cases) {
      assert.equal(upstream(message), upstreamClass, `${name}: ${message}`)
      assert.equal(patched(message), patchedClass, `${name}: ${message}`)
      // A rate limit is retried; a hard limit is not.
      assert.equal(retried.has(patchedClass), name === 'a rate limit', `${name}: ${message}`)
    }
  } finally {
    delete globalThis[key]
  }
})

test('leaves an unexpected dsh-llm-pi-ai alone', () => {
  assert.equal(patchPiAiSource('export const x = 1'), null)
  assert.equal(patchPayloadSource('export const x = 1'), null)
})

test('the installed dsh-llm-pi-ai takes the payload patch, and hands pi-ai the hook', () => {
  const patched = patchPayloadSource(patchPiAiSource(installedSource()))
  assert.ok(patched, 'dsh-llm-pi-ai no longer matches patchPayloadSource; update the patch for this dsh')
  const start = patched.indexOf('function profileOptions(')
  const profileOptions = new Function(`${patched.slice(start, patched.indexOf('\n}', start) + 2)} return profileOptions`)()
  const key = Symbol.for(PAYLOAD_KEY)
  const hook = () => undefined
  globalThis[key] = hook
  try {
    const options = profileOptions({}, 'off', 'k')
    assert.equal(options.onPayload, hook)
    assert.equal(options.maxRetries, 0)
    assert.equal(options.apiKey, 'k')
  } finally {
    delete globalThis[key]
  }
})

const reasoning = (id) => ({ type: 'reasoning', id, summary: [], encrypted_content: `enc-${id}` })
const user = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] })

test('replayGuard drops the replayed reasoning once the same request is sent a third time', () => {
  const logs = []
  const guard = replayGuard((message) => logs.push(message))
  const body = { model: 'gpt', prompt_cache_key: 's1', input: [user('hi'), reasoning('rs_a'), { type: 'function_call', call_id: 'c1' }, { type: 'function_call_output', call_id: 'c1', output: 'x' }] }
  assert.equal(guard(body), undefined)
  assert.equal(guard(structuredClone(body)), undefined)
  const third = guard(structuredClone(body))
  assert.deepEqual(third.input.map((item) => item.type ?? item.role), ['user', 'function_call', 'function_call_output'])
  assert.equal(third.model, 'gpt')
  assert.equal(logs.length, 1)
  // Later requests of the session leave the same item out but keep newer reasoning.
  const next = guard({ ...body, input: [...body.input, reasoning('rs_b'), user('more')] })
  assert.deepEqual(next.input.filter((item) => item.type === 'reasoning').map((item) => item.id), ['rs_b'])
})

test('replayGuard leaves other sessions, new requests and non-Responses bodies alone', () => {
  const guard = replayGuard()
  const body = { prompt_cache_key: 's1', input: [user('hi'), reasoning('rs_a'), user('go')] }
  guard(body)
  guard(body)
  guard(body)
  assert.equal(guard({ prompt_cache_key: 's2', input: body.input }), undefined)
  // A request that grew since the last one is a new request, not a retry.
  const fresh = replayGuard()
  for (let n = 1; n <= 5; n += 1) assert.equal(fresh({ prompt_cache_key: 's', input: [reasoning('rs_a'), ...Array.from({ length: n }, (_, i) => user(`m${i}`))] }), undefined)
  assert.equal(guard({ messages: [] }), undefined)
  assert.equal(guard(undefined), undefined)
})
