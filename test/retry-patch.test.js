import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import { patchPayloadSource, patchPiAiSource, PAYLOAD_KEY, replayGuard, RETRYABLE_KEY, retryableCheck } from '../server/retry-patch.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The dsh-llm-pi-ai module the installed dsh loads. */
function installedSource() {
  const dshRequire = createRequire(path.join(root, 'node_modules/@deepseek-ai/dsh/package.json'))
  const dir = path.dirname(dshRequire.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'))
  return fs.readFileSync(path.join(dir, 'lib/index.js'), 'utf8')
}

/** dsh's classifyPiAiError from a module source, as a callable function. */
function classifier(source) {
  const start = source.indexOf('function classifyPiAiError(message) {')
  const end = source.indexOf('\n}', start)
  // The quota check lives elsewhere in the module; these messages never hit it.
  return new Function(`const isQuotaExceededError = () => false; const QUOTA_EXCEEDED_CODE = "QUOTA"; ${source.slice(start, end + 2)} return classifyPiAiError`)()
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
    assert.equal(after('429 rate limit'), 'INVALID_REQUEST')
    assert.equal(after('400 invalid request'), 'INVALID_REQUEST')
    assert.equal(after('pi-ai provider "anthropic" has no configured model "gpt"'), 'PI_AI_ERROR')
    assert.equal(after('insufficient_quota: billing hard limit'), 'PI_AI_ERROR')
  } finally {
    delete globalThis[key]
  }
})

test('without pi-ai\'s check the patched rule changes nothing', () => {
  const after = classifier(patchPiAiSource(installedSource()))
  assert.equal(after('WebSocket closed 1000'), 'PI_AI_ERROR')
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
