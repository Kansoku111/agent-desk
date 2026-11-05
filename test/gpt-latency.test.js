import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCacheDiagnostics, CACHE_DIAGNOSTICS_LIMITS } from '../server/gpt-cache-diagnostics.js'
import { withSiwc } from '../server/siwc-request.js'
import { SIWC_RESOURCE } from '../server/siwc-client.js'
import { beginOutputSpeed, observeOutputSpeed, finishOutputSpeed, deliverAssistantUpdate } from '../server/output-speed-bridge.js'

function capture() {
  let time = 0
  const records = [], notices = []
  const diagnostics = createCacheDiagnostics({ now: () => time, write: line => records.push(JSON.parse(line)), onStop: notice => notices.push(notice) })
  return { diagnostics, records, notices, at: value => { time = value } }
}

test('HTTP timing distinguishes credential, header, data, text and terminal waits without retaining content', async () => {
  const f = capture()
  const observer = f.diagnostics.begin({ input: [], reasoning: { effort: 'low' } }, 'SECRET_SESSION')
  for (const [name, time] of [['authReadyMs', 10], ['sendMs', 12], ['headersMs', 40], ['firstByteMs', 60]]) {
    f.at(time); observer.mark(name)
  }
  f.at(70); observer.event({ type: 'response.created', response: { id: 'SECRET_RESPONSE' } })
  f.at(80); observer.event({ type: 'response.reasoning_text.delta', delta: 'SECRET_REASONING' })
  f.at(90); observer.event({ type: 'response.output_text.delta', delta: 'SECRET_TEXT' })
  f.at(100); observer.event({ type: 'response.output_text.delta', delta: 'SECRET_MORE' })
  f.at(120); observer.event({ type: 'response.completed', response: { usage: { input_tokens: 15 } } })
  f.at(125); observer.finish('completed')
  f.at(999); observer.mark('sendMs'); observer.event({ type: 'response.failed' }); observer.finish('cancelled')
  await f.diagnostics.flush()
  assert.deepEqual(f.records[1].timing, { authReadyMs: 10, sendMs: 12, headersMs: 40, firstByteMs: 60, firstEventMs: 70, firstTextMs: 90, lastTextMs: 100, terminalMs: 120, finishedMs: 125 })
  assert.equal(f.records[0].reasoningEffort, 'low')
  assert.equal(f.records[0].serviceTier, 'absent')
  assert.equal(f.records.length, 2)
  assert.doesNotMatch(JSON.stringify(f.records), /SECRET/)
})

test('real transport observer records only allowlisted normalized settings and preserves the SSE', async () => {
  const f = capture()
  const model = { id: 'gpt-private-model', provider: 'openai-codex', api: 'openai-responses', baseUrl: SIWC_RESOURCE, reasoning: true }
  const text = 'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'SECRET_日本語' }) + String.fromCharCode(10).repeat(2)
    + 'data: ' + JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 20 } } }) + String.fromCharCode(10).repeat(2)
  const options = withSiwc(model, { sessionId: 'SECRET_SESSION' }, {
    diagnostics: f.diagnostics,
    client: { auth: async () => { f.at(10); return { access_token: 'SECRET_TOKEN' } } },
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(init.body).service_tier, undefined)
      f.at(20)
      return new Response(text)
    },
  })
  const response = await options.fetch(SIWC_RESOURCE + '/responses', { method: 'POST', body: JSON.stringify({ input: [], reasoning: { effort: 'xhigh' }, service_tier: 'priority' }) })
  assert.equal(await response.text(), text)
  await f.diagnostics.flush()
  const request = f.records.find(r => r.event === 'request')
  const result = f.records.find(r => r.event === 'result')
  assert.equal(request.route, 'official_responses')
  assert.equal(request.reasoningEffort, 'xhigh')
  assert.equal(request.serviceTier, 'absent', 'record the actual normalized wire payload, not a requested tier')
  assert.equal(result.timing.authReadyMs, 10)
  assert.equal(result.timing.sendMs, 10)
  assert.equal(result.timing.headersMs, 20)
  for (const key of ['firstByteMs', 'firstEventMs', 'firstTextMs', 'lastTextMs', 'terminalMs', 'finishedMs']) assert.equal(typeof result.timing[key], 'number')
  assert.doesNotMatch(JSON.stringify(f.records), /SECRET|private-model|日本語/)
})

test('an auth failure has no send time and propagates the original failure', async () => {
  const f = capture()
  const error = new Error('SECRET_AUTH_ERROR')
  const options = withSiwc({ provider: 'openai-codex', api: 'openai-responses', baseUrl: SIWC_RESOURCE }, {}, {
    diagnostics: f.diagnostics,
    client: { auth: async () => { f.at(12); throw error } },
    fetch: async () => { throw new Error('must not send') },
  })
  await assert.rejects(options.fetch(SIWC_RESOURCE + '/responses', { method: 'POST', body: JSON.stringify({ input: [] }) }), e => e === error)
  await f.diagnostics.flush()
  const result = f.records.find(r => r.event === 'result')
  assert.equal(result.outcome, 'auth_error')
  assert.equal(result.timing.sendMs, null)
  assert.equal(result.timing.finishedMs, 12)
  assert.doesNotMatch(JSON.stringify(f.records), /SECRET/)
})

test('delivery timing measures received text separately from awaited ACP notification without another copy', async () => {
  const f = capture(), sent = []
  const record = { agent: { session: { id: 'SECRET_SESSION' } }, outputTail: Promise.resolve(), notify: async params => { sent.push(params); f.at(170) } }
  beginOutputSpeed(record, f.diagnostics)
  f.at(50); observeOutputSpeed(record, { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'SECRET_REASONING' } })
  f.at(90); observeOutputSpeed(record, { type: 'chunk', chunk: { type: 'text-delta', text: 'SECRET_ANSWER' } })
  f.at(100); observeOutputSpeed(record, { type: 'chunk', chunk: { type: 'text-delta', text: 'SECRET_END' } })
  f.at(150)
  const params = { sessionId: 'SECRET_SESSION', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SECRET_ANSWER' } } }
  await deliverAssistantUpdate(record, params)
  f.at(200); await finishOutputSpeed(record)
  await f.diagnostics.flush()
  const delivery = f.records.find(r => r.event === 'delivery')
  assert.deepEqual(delivery.timing, { firstTextMs: 90, lastTextMs: 100, firstNotifyMs: 150, lastNotifyMs: 150, lastNotifyReturnedMs: 170, finishedMs: 200 })
  assert.equal(delivery.deliveryStatus, 'unconfirmed', 'notify returning does not prove transport delivery or UI rendering')
  assert.equal(sent.filter(p => p === params).length, 1)
  assert.doesNotMatch(JSON.stringify(f.records), /SECRET/)
  const attempt = f.diagnostics.begin({ input: [] }, 'SECRET_SESSION')
  attempt.finish('completed'); await f.diagnostics.flush()
  assert.equal(delivery.series, f.records.find(r => r.event === 'request').series)
})

test('failed notifications propagate unchanged while metric failures cannot break delivery', async () => {
  const f = capture(), error = new Error('SECRET_NOTIFY_ERROR')
  const record = { agent: { session: { id: 'SECRET_SESSION' } }, outputTail: Promise.resolve(), notify: async () => { throw error } }
  beginOutputSpeed(record, f.diagnostics)
  const params = { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SECRET' } } }
  await assert.rejects(deliverAssistantUpdate(record, params), e => e === error)
  await finishOutputSpeed(record); await f.diagnostics.flush()
  assert.equal(f.records[0].deliveryStatus, 'notify_rejected')
  assert.equal(f.records[0].timing.lastNotifyReturnedMs, null)
  assert.doesNotMatch(JSON.stringify(f.records), /SECRET/)
  let delivered = 0
  record.notify = async () => { delivered++ }
  beginOutputSpeed(record, { beginDelivery() { throw new Error('SECRET_DIAGNOSTIC') } })
  await deliverAssistantUpdate(record, params)
  await finishOutputSpeed(record)
  assert.equal(delivered, 1)
})

test('missing text stays null and delivery records have a hard cap', async () => {
  const f = capture()
  for (let i = 0; i < CACHE_DIAGNOSTICS_LIMITS.requests; i++) f.diagnostics.beginDelivery('SECRET_SESSION').finish()
  assert.equal(f.diagnostics.beginDelivery('SECRET_SESSION'), null)
  assert.equal(f.diagnostics.beginDelivery('SECRET_SESSION'), null)
  assert.equal((await f.diagnostics.flush()).limited, true)
  assert.equal(f.notices.length, 1)
  assert.equal(f.notices[0].reason, 'delivery_limit')
  f.diagnostics.begin({ input: [], reasoning: { effort: 'SECRET_INVALID' }, service_tier: 'SECRET_TIER' }).finish('http_error')
  await f.diagnostics.flush()
  const delivery = f.records[0]
  assert.equal(delivery.timing.firstTextMs, null)
  assert.equal(delivery.timing.lastNotifyReturnedMs, null)
  const request = f.records.find(r => r.event === 'request')
  assert.equal(request.reasoningEffort, 'invalid')
  assert.equal(request.serviceTier, 'invalid')
  assert.doesNotMatch(JSON.stringify(f.records), /SECRET/)
})
