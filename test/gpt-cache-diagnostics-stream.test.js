import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCacheDiagnostics } from '../server/gpt-cache-diagnostics.js'
import { withSiwc } from '../server/siwc-request.js'
import { SIWC_RESOURCE } from '../server/siwc-client.js'
import { stream } from '@earendil-works/pi-ai/api/openai-responses'

const model = { id: 'gpt-mock', provider: 'openai-codex', api: 'openai-responses', baseUrl: SIWC_RESOURCE, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 32768 }
const client = { auth: async () => ({ access_token: 'SECRET_ACCESS' }) }
const body = { input: [{ role: 'user', content: 'SECRET_PROMPT' }], prompt_cache_key: 'SECRET_CACHE' }
const event = (type, response = {}) => 'data: ' + JSON.stringify({ type, response }) + '\n\n'
function capture(write) {
  const records = []
  const diagnostics = createCacheDiagnostics({ write: write ?? (line => records.push(JSON.parse(line))), onStop: () => {} })
  return { records, diagnostics }
}
const invoke = (options, extra = {}) => options.fetch(SIWC_RESOURCE + '/responses', { method: 'POST', body: JSON.stringify(body), ...extra })
const result = records => records.find(r => r.event === 'result')

function chunked(text) {
  const bytes = new TextEncoder().encode(text)
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index === bytes.length) return controller.close()
      controller.enqueue(bytes.subarray(index, ++index))
    },
  })
}

test('diagnostics preserve OFF/ON request and response bytes across UTF8 and SSE chunk boundaries', async () => {
  const { diagnostics, records } = capture()
  const text = ': heartbeat\r\n\r\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'SECRET_日本語テキスト' }) + '\r\n\r\n' + event('response.completed', { usage: { input_tokens: 100, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } })
  const sent = []
  const run = async diagnostic => {
    const options = withSiwc(model, { sessionId: 'session' }, { client, diagnostics: diagnostic, fetch: async (_url, init) => {
      sent.push(init.body)
      return new Response(chunked(text), { headers: { 'content-type': 'text/event-stream', 'x-test': 'same' } })
    } })
    const response = await invoke(options)
    return { bytes: Buffer.from(await response.arrayBuffer()), status: response.status, header: response.headers.get('x-test') }
  }
  const off = await run(null)
  const on = await run(diagnostics)
  await diagnostics.flush()
  assert.equal(sent[0], sent[1])
  assert.deepEqual(off, on)
  assert.equal(result(records).usage.cacheRead.state, 'zero')
  assert.doesNotMatch(JSON.stringify(records), /SECRET|テキスト/)
})

test('slow or rejected diagnostic writes never hold up the response stream', { timeout: 3000 }, async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  const { diagnostics } = capture(async () => { await gate; throw new Error('SECRET_WRITE_ERROR') })
  const options = withSiwc(model, {}, { client, diagnostics, fetch: async () => new Response(event('response.completed')) })
  try {
    assert.match(await (await invoke(options)).text(), /response.completed/)
  } finally { release() }
  assert.equal((await diagnostics.flush()).failed, true)
  for (const diagnostic of [
    { begin() { throw new Error('SECRET_BEGIN_ERROR') } },
    { begin() { return { event() { throw new Error('SECRET_EVENT_ERROR') }, finish: async () => { throw new Error('SECRET_FINISH_ERROR') } } } },
  ]) {
    const safe = withSiwc(model, {}, { client, diagnostics: diagnostic, fetch: async () => new Response(event('response.completed')) })
    assert.match(await (await invoke(safe)).text(), /response.completed/)
  }
})

test('failed, incomplete and interrupted SSE retain original failure semantics and raw unknown usage', async () => {
  for (const type of ['response.failed', 'response.incomplete', 'response.created']) {
    const { diagnostics, records } = capture()
    const options = withSiwc(model, {}, { client, diagnostics, fetch: async () => new Response(event(type, { usage: { input_tokens: 25 } })) })
    await assert.rejects((await invoke(options)).text(), /did not complete/)
    await diagnostics.flush()
    assert.equal(result(records).outcome, type === 'response.failed' ? 'failed' : type === 'response.incomplete' ? 'incomplete' : 'interrupted')
    assert.equal(result(records).usage.cacheRead.state, 'missing')
    assert.equal(records.filter(r => r.event === 'result').length, 1)
  }
})

test('HTTP errors, empty bodies and transport failures produce one redacted attempt result', async () => {
  for (const kind of ['http', 'empty', 'transport']) {
    const { diagnostics, records } = capture()
    const options = withSiwc(model, {}, { client, diagnostics, fetch: async () => {
      if (kind === 'transport') throw new Error('SECRET_TRANSPORT_ERROR')
      if (kind === 'empty') return new Response(null, { status: 204 })
      return Response.json({ error: { code: 'rate_limit', message: 'SECRET_HTTP_ERROR' } }, { status: 429 })
    } })
    if (kind === 'transport') await assert.rejects(invoke(options), /SECRET_TRANSPORT_ERROR/)
    else {
      const response = await invoke(options)
      assert.equal(response.status, kind === 'http' ? 429 : 204)
      await response.text()
    }
    await diagnostics.flush()
    assert.equal(result(records).outcome, kind === 'http' ? 'http_error' : kind === 'empty' ? 'no_body' : 'transport_error')
    assert.equal(result(records).usage.state, 'unobserved')
    assert.doesNotMatch(JSON.stringify(records), /SECRET/)
  }
})

test('upstream errors, idle timeout, caller abort and reader cancellation remain distinct observations', { timeout: 3000 }, async () => {
  for (const kind of ['upstream', 'idle', 'abort', 'cancel']) {
    const { diagnostics, records } = capture()
    let cancelled = false
    let entered, cancelledUpstream
    const started = new Promise(resolve => { entered = resolve })
    const upstreamCancelled = new Promise(resolve => { cancelledUpstream = resolve })
    const caller = new AbortController()
    const options = withSiwc(model, {}, { client, diagnostics, idleMs: 30, fetch: async (_url, init) => {
      entered()
      if (kind === 'abort') return new Promise((_resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason)
        else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
      let read = 0
      return new Response(new ReadableStream({
        pull(controller) {
          if (kind !== 'upstream') return new Promise(() => {})
          if (read++ === 0) controller.enqueue(new TextEncoder().encode(event('response.created')))
          else controller.error(new Error('SECRET_UPSTREAM_ERROR'))
        },
        cancel() { cancelled = true; cancelledUpstream() },
      }))
    } })
    if (kind === 'abort') {
      const pending = invoke(options, { signal: caller.signal })
      await started
      caller.abort(new Error('SECRET_ABORT_REASON'))
      await assert.rejects(pending, /SECRET_ABORT_REASON/)
    } else {
      const response = await invoke(options)
      if (kind === 'cancel') {
        await response.body.cancel('SECRET_CANCEL_REASON')
        await upstreamCancelled
      }
      else await assert.rejects(response.text(), kind === 'idle' ? /timed out/ : /SECRET_UPSTREAM_ERROR/)
    }
    await diagnostics.flush()
    assert.ok(result(records), 'result missing for ' + kind)
    assert.equal(result(records).outcome, kind === 'idle' ? 'idle_timeout' : kind === 'upstream' ? 'transport_error' : 'cancelled')
    if (kind === 'cancel') assert.equal(cancelled, true)
    assert.doesNotMatch(JSON.stringify(records), /SECRET/)
  }
})

test('HTTP status takes diagnostic precedence over a later error-body timeout without hiding the timeout', { timeout: 3000 }, async () => {
  const { diagnostics, records } = capture()
  const options = withSiwc(model, {}, { client, diagnostics, idleMs: 30, fetch: async () => new Response(new ReadableStream({ start() {} }), { status: 429 }) })
  const response = await invoke(options)
  await assert.rejects(response.text(), /timed out/)
  await diagnostics.flush()
  const results = records.filter(r => r.event === 'result')
  assert.equal(results.length, 1)
  assert.equal(results[0].outcome, 'http_error')
  assert.equal(results[0].httpStatus, 429)
  assert.equal(results[0].usage.state, 'unobserved')
})

test('raw usage can be reconciled with the real SDK before its missing-cache zero fallback', async () => {
  for (const cached of [undefined, 0, 80]) {
    const { diagnostics, records } = capture()
    let calls = 0
    const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: cached === undefined ? {} : { cached_tokens: cached, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 5 } }
    const options = withSiwc(model, { sessionId: 'session', maxRetries: 0 }, { client, diagnostics, fetch: async () => {
      calls++
      return new Response(event('response.completed', { id: 'response_mock', status: 'completed', output: [], usage }), { headers: { 'content-type': 'text/event-stream' } })
    } })
    const message = await stream(model, { messages: [{ role: 'user', content: 'SECRET_PROMPT', timestamp: 0 }] }, options).result()
    await diagnostics.flush()
    const raw = result(records).usage
    assert.equal(message.stopReason, 'stop')
    assert.equal(calls, 1, 'all traffic stays in the mock fetch')
    assert.equal(raw.cacheRead.state, cached === undefined ? 'missing' : cached === 0 ? 'zero' : 'value')
    assert.equal(message.usage.cacheRead, cached ?? 0)
    assert.equal(message.usage.input, 100 - (cached ?? 0) - (cached === undefined ? 0 : 2))
    assert.equal(raw.input.value, 100)
    assert.equal(message.usage.output, raw.output.value)
    assert.equal(message.usage.reasoning, raw.reasoning.value)
    assert.doesNotMatch(JSON.stringify(records), /SECRET/)
  }
})
