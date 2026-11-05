import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCacheDiagnostics, CACHE_DIAGNOSTICS_LIMITS, observeCache } from '../server/gpt-cache-diagnostics.js'
import { withSiwc } from '../server/siwc-request.js'
import { SIWC_RESOURCE } from '../server/siwc-client.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { CACHE_DIAGNOSTICS_ENV } from '../server/gpt-cache-diagnostics.js'
import { dshEnv } from '../server/dsh-env.js'

const model = { id: 'gpt-mock', provider: 'openai-codex', api: 'openai-responses', baseUrl: SIWC_RESOURCE, reasoning: true }
const client = { auth: async () => ({ access_token: 'SECRET_ACCESS_TOKEN' }) }
const payload = () => ({
  model: 'gpt-mock', prompt_cache_key: 'SECRET_CACHE_KEY', reasoning: { effort: 'low' },
  instructions: 'SECRET_STANDING_INSTRUCTIONS',
  input: [
    { role: 'developer', content: 'SECRET_DEVELOPER_TEXT' },
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'SECRET_TOOL_NAME', parameters: { type: 'object', properties: { value: { type: 'string' } } } }] },
    { role: 'user', content: 'SECRET_USER_TEXT' },
  ],
})
const terminal = (usage, type = 'response.completed') => ({ type, response: usage === undefined ? {} : { usage } })
function capture() {
  const records = [], notices = []
  const diagnostics = createCacheDiagnostics({ write: line => records.push(JSON.parse(line)), onStop: notice => notices.push(notice) })
  return { diagnostics, records, notices }
}
async function send(options, body) {
  return options.fetch(SIWC_RESOURCE + '/responses', { method: 'POST', body: JSON.stringify(body) })
}

test('fingerprints distinguish append-only history, old tool changes and cache-sensitive settings', async () => {
  const { diagnostics, records } = capture()
  const first = payload()
  const before = structuredClone(first)
  diagnostics.begin(first, 'SECRET_SESSION').finish('completed')
  const second = structuredClone(first)
  second.input.push({ type: 'reasoning', encrypted_content: 'SECRET_ENCRYPTED_REASONING' })
  diagnostics.begin(second, 'SECRET_SESSION').finish('completed')
  const third = structuredClone(second)
  third.input[1].tools[0].parameters.properties.value.type = 'number'
  diagnostics.begin(third, 'SECRET_SESSION').finish('completed')
  const fourth = structuredClone(third)
  fourth.input[0].content = 'CHANGED_SECRET'
  diagnostics.begin(fourth, 'SECRET_SESSION').finish('completed')
  const fifth = structuredClone(fourth)
  fifth.reasoning.effort = 'high'
  fifth.prompt_cache_key = 'CHANGED_SECRET_CACHE_KEY'
  diagnostics.begin(fifth, 'SECRET_SESSION').finish('completed')
  await diagnostics.flush()
  const requests = records.filter(r => r.event === 'request')
  assert.equal(requests[0].prefix, null)
  assert.equal(requests[1].prefix.commonItems, 3)
  assert.equal(requests[1].prefix.appendOnly, true)
  assert.equal(requests[1].prefix.instructionsUnchanged, true)
  assert.equal(requests[2].prefix.firstChangedIndex, 1)
  assert.equal(requests[2].prefix.firstChangedKind, 'additional_tools')
  assert.equal(requests[2].prefix.toolsUnchanged, false)
  assert.equal(requests[3].prefix.firstChangedIndex, 0)
  assert.equal(requests[3].prefix.instructionsUnchanged, false)
  assert.equal(requests[4].prefix.appendOnly, true)
  assert.equal(requests[4].prefix.settingsUnchanged, false)
  assert.equal(requests[4].prefix.cacheKeyUnchanged, false)
  assert.deepEqual(first, before, 'observation must not mutate the request')
  assert.doesNotMatch(JSON.stringify(records), /SECRET|CHANGED|gpt-mock|encrypted_content/)
  const other = capture()
  other.diagnostics.begin(first, 'SECRET_SESSION').finish('completed')
  await other.diagnostics.flush()
  assert.notEqual(other.records[0].fingerprints.input, requests[0].fingerprints.input, 'keys are not shared between diagnostic runs')
})

test('absent instructions and tools are not the same fingerprint as explicit null', async () => {
  const { diagnostics, records } = capture()
  diagnostics.begin({ input: [] }, 'session').finish('completed')
  diagnostics.begin({ input: [], instructions: null, tools: null }, 'session').finish('completed')
  await diagnostics.flush()
  const requests = records.filter(r => r.event === 'request')
  assert.equal(requests[1].prefix.instructionsUnchanged, false)
  assert.equal(requests[1].prefix.toolsUnchanged, false)
})

test('raw usage preserves reported values, explicit zero, missing and invalid details', async () => {
  const { diagnostics, records } = capture()
  for (const cached of [undefined, 0, 37, -1, 'SECRET_BAD_COUNT', null]) {
    const observer = diagnostics.begin(payload(), 'session')
    const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: cached === undefined ? {} : { cached_tokens: cached, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 5 } }
    observer.event(terminal(usage))
    observer.finish('completed')
    observer.finish('cancelled')
  }
  const missing = diagnostics.begin(payload(), 'session')
  missing.event(terminal())
  missing.finish('completed')
  const invalid = diagnostics.begin(payload(), 'session')
  invalid.event(terminal(null))
  invalid.finish('completed')
  const invalidSection = diagnostics.begin(payload(), 'session')
  invalidSection.event(terminal({ input_tokens_details: 'SECRET_SECTION' }))
  invalidSection.finish('completed')
  await diagnostics.flush()
  const results = records.filter(r => r.event === 'result')
  assert.deepEqual(results.slice(0, 6).map(r => r.usage.cacheRead.state), ['missing', 'zero', 'value', 'invalid', 'invalid', 'invalid'])
  assert.deepEqual(results[2].usage.cacheRead, { state: 'value', value: 37 })
  assert.equal(results[2].usage.input.value, 100, 'raw input includes cache, unlike the SDK uncached count')
  assert.equal(results[2].usage.output.value, 20, 'reasoning is not added to output')
  assert.equal(results[2].usage.reasoning.value, 5)
  assert.equal(results[6].usage.state, 'missing')
  assert.equal(results[7].usage.state, 'invalid')
  assert.equal(results[8].usage.cacheRead.state, 'invalid')
  assert.equal(results.length, 9, 'one result per HTTP attempt')
  assert.doesNotMatch(JSON.stringify(records), /SECRET/)
})

test('text input, array input and absent input are not reported as the same prefix', async () => {
  const { diagnostics, records } = capture()
  for (const input of ['SECRET_ONE', 'SECRET_TWO', [], undefined, null]) diagnostics.begin({ input }, 'session').finish('completed')
  await diagnostics.flush()
  const requests = records.filter(r => r.event === 'request')
  assert.equal(requests[1].prefix.firstChangedIndex, 0)
  assert.equal(requests[1].prefix.firstChangedKind, 'text')
  assert.equal(requests[2].prefix.inputKindUnchanged, false)
  assert.equal(requests[3].prefix.inputKindUnchanged, false)
  assert.equal(requests[4].fingerprintComplete, false)
  assert.doesNotMatch(JSON.stringify(records), /SECRET/)
})

test('overlapping sessions are not mixed and incomplete previous requests are identified', async () => {
  const { diagnostics, records } = capture()
  const a = diagnostics.begin(payload(), 'A')
  diagnostics.begin(payload(), 'B').finish('completed')
  diagnostics.begin(payload(), 'A').finish('completed')
  a.finish('completed')
  diagnostics.begin({ input: [] }).finish('completed')
  diagnostics.begin({ input: [] }).finish('completed')
  await diagnostics.flush()
  const requests = records.filter(r => r.event === 'request')
  assert.equal(requests[1].prefix, null)
  assert.equal(requests[2].prefix.previousId, 1)
  assert.equal(requests[2].prefix.previousPending, true)
  assert.equal(requests[3].groupSource, 'none')
  assert.equal(requests[4].prefix, null)
})

test('diagnostics bound series, input snapshots and output without keeping old payloads', async () => {
  const { diagnostics, records, notices } = capture()
  for (let i = 0; i <= CACHE_DIAGNOSTICS_LIMITS.series; i++) diagnostics.begin(payload(), 's' + i).finish('completed')
  diagnostics.begin(payload(), 's0').finish('completed')
  const large = payload()
  large.input = Array(CACHE_DIAGNOSTICS_LIMITS.inputItems + 1).fill({ role: 'user', content: 'SECRET_LARGE_INPUT' })
  diagnostics.begin(large, 's0').finish('completed')
  diagnostics.begin(payload(), 's0').finish('completed')
  diagnostics.begin(payload(), 's0').finish('completed')
  for (let i = 0; i < CACHE_DIAGNOSTICS_LIMITS.requests; i++) diagnostics.begin(payload(), 's0')?.finish('completed')
  const status = await diagnostics.flush()
  const requests = records.filter(r => r.event === 'request')
  assert.equal(requests[CACHE_DIAGNOSTICS_LIMITS.series + 1].prefix, null, 'oldest series was evicted')
  assert.equal(requests[CACHE_DIAGNOSTICS_LIMITS.series + 2].fingerprintComplete, false)
  assert.equal(requests[CACHE_DIAGNOSTICS_LIMITS.series + 2].fingerprints.input, null)
  assert.equal(requests[CACHE_DIAGNOSTICS_LIMITS.series + 3].prefix, null, 'a skipped large snapshot is not a full-prefix comparison')
  assert.equal(requests[CACHE_DIAGNOSTICS_LIMITS.series + 4].prefix.appendOnly, true, 'comparison resumes after a new complete snapshot')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].reason, 'request_limit')
  assert.doesNotMatch(JSON.stringify(notices), /SECRET/)
  assert.equal(status.requests, CACHE_DIAGNOSTICS_LIMITS.requests)
  assert.equal(status.limited, true)
  assert.equal(records.length, CACHE_DIAGNOSTICS_LIMITS.requests * 2)
  assert.ok(status.bytes <= CACHE_DIAGNOSTICS_LIMITS.bytes)
})

test('diagnostic sink failures and malformed local paths stay contained', async t => {
  const notices = []
  const diagnostics = createCacheDiagnostics({ write: async () => { throw new Error('SECRET_IO_FAILURE') }, onStop: notice => notices.push(notice) })
  diagnostics.begin(payload()).finish('transport_error')
  const status = await diagnostics.flush()
  assert.equal(status.failed, true)
  assert.equal(diagnostics.begin(payload()), null)
  assert.doesNotMatch(JSON.stringify(status), /SECRET/)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].reason, 'write_error')
  assert.doesNotMatch(JSON.stringify(notices), /SECRET/)
  const silent = createCacheDiagnostics({ write: () => { throw new Error('write') }, onStop: async () => { throw new Error('notice') } })
  silent.begin(payload()).finish('completed')
  assert.equal((await silent.flush()).failed, true)
  assert.doesNotThrow(() => observeCache({ event() { throw new Error('no') } }, 'event', {}))
  observeCache({ event: async () => { throw new Error('no') } }, 'event', {})
  for (const directory of ['relative', 'https://example.com/logs', '//server/share']) assert.throws(() => createCacheDiagnostics({ directory }), /absolute local/)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-cache-log-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fileDiagnostic = createCacheDiagnostics({ directory })
  fileDiagnostic.begin(payload(), 'SECRET_SESSION').finish('completed')
  const fileStatus = await fileDiagnostic.flush()
  const file = path.join(directory, fileStatus.filename)
  const text = await fs.readFile(file, 'utf8')
  assert.equal(text.trim().split('\n').length, 2)
  assert.doesNotMatch(text, /SECRET|gpt-mock/)
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
})

test('a dedicated launcher can pass diagnostics through dshEnv without changing saved settings', () => {
  const folder = path.resolve('diagnostics-test-only')
  assert.equal(dshEnv({ dshHome: 'unused' }, 'workspace-write', { [CACHE_DIAGNOSTICS_ENV]: folder })[CACHE_DIAGNOSTICS_ENV], folder)
})

test('process configuration is OFF by default and explicit local opt-in creates only private diagnostics', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-cache-env-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const run = async directory => {
    const env = { ...process.env }
    if (directory === undefined) delete env[CACHE_DIAGNOSTICS_ENV]
    else env[CACHE_DIAGNOSTICS_ENV] = directory
    const sse = 'data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 1 } } }) + '\n\n'
    const script = [
      'import { configuredCacheDiagnostics } from ' + JSON.stringify(new URL('../server/gpt-cache-diagnostics.js', import.meta.url).href),
      'import { withSiwc } from ' + JSON.stringify(new URL('../server/siwc-request.js', import.meta.url).href),
      'import { stream } from "@earendil-works/pi-ai/api/openai-responses"',
      'globalThis.fetch = async () => { throw new Error("Unexpected network") }',
      'const model = ' + JSON.stringify({ ...model, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 32768 }),
      'let calls = 0',
      'const options = withSiwc(model, {sessionId:"SECRET_SESSION",maxRetries:0}, {client:{auth:async()=>({access_token:"SECRET_MOCK_TOKEN"})},fetch:async()=>{calls++;return new Response(' + JSON.stringify(sse) + ',{headers:{"content-type":"text/event-stream"}})}})',
      'const messages = [{role:"user",content:"SECRET_PROMPT",timestamp:0}]',
      'for(let i=0;i<2;i++){const message=await stream(model,{messages},options).result();if(message.stopReason!=="stop")throw new Error("Mock SDK failed");messages.push({role:"user",content:"SECRET_FOLLOWUP",timestamp:1})}',
      'if(calls!==2)throw new Error("Mock fetch was bypassed")',
      'const d=configuredCacheDiagnostics();console.log(JSON.stringify({enabled:!!d,status:await d?.flush()}))',
    ].join(';')
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { err += data })
    const [code] = await once(child, 'close')
    assert.equal(code, 0, err)
    return { ...JSON.parse(out), stderr: err }
  }
  assert.equal((await run(undefined)).enabled, false)
  assert.deepEqual(await fs.readdir(root), [])
  const invalid = await run('relative-path')
  assert.equal(invalid.enabled, false)
  assert.match(invalid.stderr, /invalid_directory/)
  const directory = path.join(root, 'on')
  const on = await run(directory)
  assert.equal(on.enabled, true)
  assert.equal(on.status.records, 4)
  const text = await fs.readFile(path.join(directory, on.status.filename), 'utf8')
  assert.doesNotMatch(text, /SECRET/)
  const requests = text.trim().split('\n').map(line => JSON.parse(line)).filter(r => r.event === 'request')
  assert.equal(requests[1].prefix.previousId, requests[0].id)
  assert.equal(requests[1].prefix.appendOnly, true)
  assert.equal(requests[1].groupSource, 'session')
  const blocked = path.join(root, 'SECRET_BLOCKED_DIRECTORY')
  await fs.writeFile(blocked, 'fixture')
  const failed = await run(blocked)
  assert.equal(failed.status.failed, true)
  assert.match(failed.stderr, /write_error/)
  assert.doesNotMatch(failed.stderr, /SECRET/)
})

test('wire boundary captures the normalized payload and the same attempt raw SSE usage', async () => {
  const { diagnostics, records } = capture()
  const bytes = 'data: ' + JSON.stringify(terminal({ input_tokens: 100, output_tokens: 3, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 1 } })) + '\n\n'
  const observedBodies = []
  let fingerprintedBody
  const options = withSiwc(model, { sessionId: 'SECRET_SESSION', onPayload: body => ({ ...body, temperature: 2 }) }, {
    client, diagnostics: { begin(value, sessionId) { fingerprintedBody = value; return diagnostics.begin(value, sessionId) } },
    fetch: async (_url, init) => { observedBodies.push(JSON.parse(init.body)); return new Response(bytes, { headers: { 'content-type': 'text/event-stream', 'x-test': 'preserved' } }) },
  })
  const body = await options.onPayload(payload(), model)
  assert.equal(records.length, 0, 'onPayload is not a network attempt')
  const response = await send(options, body)
  assert.equal(await response.text(), bytes)
  assert.equal(response.headers.get('x-test'), 'preserved')
  await diagnostics.flush()
  assert.equal(records.length, 2)
  assert.equal(records[0].event, 'request')
  assert.equal(records[0].groupSource, 'session')
  assert.equal(records[1].id, records[0].id)
  assert.deepEqual(records[1].usage.cacheRead, { state: 'value', value: 80 })
  assert.equal(records[1].outcome, 'completed')
  assert.equal(observedBodies[0].temperature, undefined)
  assert.deepEqual(fingerprintedBody, observedBodies[0], 'fingerprints describe exactly the serialized wire body')
  assert.doesNotMatch(JSON.stringify(records), /SECRET/)
})
