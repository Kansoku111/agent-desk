// Opt-in, local-only SIWC diagnostics. Retain fingerprints, never request/response bodies.
import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const CACHE_DIAGNOSTICS_ENV = 'AGENT_DESK_GPT_CACHE_DIAGNOSTICS'
export const CACHE_DIAGNOSTICS_LIMITS = Object.freeze({ requests: 200, series: 16, inputItems: 4096, bytes: 1024 * 1024 })
const TERMINALS = new Set(['response.completed', 'response.failed', 'response.incomplete'])
const OUTCOMES = new Set(['completed', 'failed', 'incomplete', 'interrupted', 'transport_error', 'idle_timeout', 'cancelled', 'http_error', 'no_body', 'auth_error'])
const ITEM_KINDS = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'additional_tools', 'tool_search_output'])
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
// The served model name is a service-chosen slug, not user data; anything that is not slug-shaped is reported as invalid instead of stored.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const OMIT_SETTINGS = new Set(['input', 'instructions', 'tools', 'prompt_cache_key'])
const directoryAtStart = process.env[CACHE_DIAGNOSTICS_ENV]
let processDiagnostics

function notifyStop(notice) {
  try { console.error(JSON.stringify(notice)) } catch {}
}

/** Observers are best effort, including asynchronous sinks supplied by tests. */
export function observeCache(observer, method, ...args) {
  if (!observer) return
  try { observer[method]?.(...args)?.catch?.(() => {}) } catch {}
}

export function configuredCacheDiagnostics() {
  if (!directoryAtStart) return null
  if (processDiagnostics === undefined) {
    try { processDiagnostics = createCacheDiagnostics({ directory: directoryAtStart }) } catch {
      processDiagnostics = null
      notifyStop({ event: 'gpt-cache-diagnostics-stopped', reason: 'invalid_directory' })
    }
  }
  return processDiagnostics
}

function count(object, key) {
  if (!Object.hasOwn(object ?? {}, key)) return { state: 'missing' }
  const value = object[key]
  if (!Number.isSafeInteger(value) || value < 0) return { state: 'invalid' }
  return { state: value === 0 ? 'zero' : 'value', value }
}
function detail(usage, section, key) {
  if (!Object.hasOwn(usage ?? {}, section)) return { state: 'missing' }
  const value = usage[section]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid' }
  return count(value, key)
}
function usageOf(response) {
  const exists = Object.hasOwn(response ?? {}, 'usage')
  const usage = response?.usage
  const valid = usage && typeof usage === 'object' && !Array.isArray(usage)
  return {
    state: !exists ? 'missing' : valid ? 'reported' : 'invalid',
    input: count(valid ? usage : null, 'input_tokens'),
    output: count(valid ? usage : null, 'output_tokens'),
    total: count(valid ? usage : null, 'total_tokens'),
    cacheRead: detail(valid ? usage : null, 'input_tokens_details', 'cached_tokens'),
    cacheWrite: detail(valid ? usage : null, 'input_tokens_details', 'cache_write_tokens'),
    reasoning: detail(valid ? usage : null, 'output_tokens_details', 'reasoning_tokens'),
  }
}
const itemKind = item => ITEM_KINDS.has(item?.type) ? item.type : ROLES.has(item?.role) ? 'message' : 'other'

// This scope deliberately cannot capture the payload or its item hash arrays.
function responseObserver(id, lifecycle, record, now) {
  const startedAt = Date.now(), started = now()
  const timing = { authReadyMs: null, sendMs: null, headersMs: null, firstByteMs: null, firstEventMs: null, firstTextMs: null, lastTextMs: null, terminalMs: null, finishedMs: null }
  const mark = name => {
    if (!lifecycle.finished && Object.hasOwn(timing, name) && (timing[name] === null || name === 'lastTextMs')) timing[name] = Math.max(0, now() - started)
  }
  let terminal = null
  let transportUsed = 'http'
  let usage = { ...usageOf(null), state: 'unobserved' }
  let reasoningContext = 'unobserved'
  let servedModel = 'unobserved', servedReasoningEffort = 'unobserved'
  return {
    mark,
    transport(kind) {
      if (kind === 'websocket' || kind === 'http') transportUsed = kind
    },
    event(event) {
      if (lifecycle.finished) return
      mark('firstEventMs')
      if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta.length) {
        mark('firstTextMs')
        mark('lastTextMs')
      }
      if (!TERMINALS.has(event?.type)) return
      mark('terminalMs')
      terminal = event.type
      usage = usageOf(event.response)
      const context = event.response?.reasoning?.context
      // An omitted request uses a model default; only the terminal response
      // can tell us which reasoning history the service actually rendered.
      // The terminal response says which model actually served the request, which a router may choose differently from the requested one.
      const model = event.response?.model
      servedModel = model === undefined ? 'absent' : typeof model === 'string' && SLUG.test(model) ? model : 'invalid'
      const effort = event.response?.reasoning?.effort
      servedReasoningEffort = effort === undefined ? 'absent' : EFFORTS.includes(effort) ? effort : 'invalid'
      reasoningContext = context === undefined ? 'absent' : ['current_turn', 'all_turns'].includes(context) ? context : 'invalid'
    },
    finish(outcome, httpStatus) {
      if (lifecycle.finished) return
      mark('finishedMs')
      lifecycle.finished = true
      record({ event: 'result', id, startedAt, timing, transport: transportUsed, outcome: OUTCOMES.has(outcome) ? outcome : 'unknown', ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}), terminal, usage, reasoningContext, servedModel, servedReasoningEffort })
    },
  }
}

export function createCacheDiagnostics({ directory, write, onStop = notifyStop, now = () => performance.now() } = {}) {
  if (!write && (typeof directory !== 'string' || !path.isAbsolute(directory) || /^[\\/]{2}/.test(directory))) {
    throw new Error('Cache diagnostics require an absolute local directory')
  }
  const key = randomBytes(32)
  const filename = 'gpt-cache-' + process.pid + '-' + randomBytes(8).toString('hex') + '.jsonl'
  const file = directory ? path.join(directory, filename) : null
  let created = false, failed = false, limited = false, requests = 0, queuedBytes = 0, writtenBytes = 0, records = 0
  let deliveries = 0
  let queue = Promise.resolve()
  const series = new Map()
  const notified = new Set()
  const stopped = reason => {
    const kind = reason === 'write_error' ? 'failed' : 'limited'
    if (notified.has(kind)) return
    notified.add(kind)
    observeCache({ stop: onStop }, 'stop', { event: 'gpt-cache-diagnostics-stopped', reason, filename: file ? filename : null, requests })
  }
  const digest = value => createHmac('sha256', key).update(value === undefined ? 'undefined' : JSON.stringify(value)).digest('hex')
  const persist = write ?? (async line => {
    if (!created) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.writeFile(file, line, { flag: 'wx', mode: 0o600 })
      created = true
    } else await fs.appendFile(file, line)
  })
  const record = data => {
    if (failed) return
    const line = JSON.stringify({ version: 1, at: Date.now(), ...data }) + '\n'
    const bytes = Buffer.byteLength(line)
    if (queuedBytes + bytes > CACHE_DIAGNOSTICS_LIMITS.bytes) { limited = true; stopped('byte_limit'); return }
    queuedBytes += bytes
    queue = queue.then(async () => {
      if (failed) return
      await persist(line)
      writtenBytes += bytes
      records++
    }).catch(() => { failed = true; series.clear(); stopped('write_error') })
  }
  return {
    begin(payload, sessionId) {
      if (failed || requests >= CACHE_DIAGNOSTICS_LIMITS.requests) {
        if (!failed) { limited = true; stopped('request_limit') }
        return null
      }
      const id = ++requests
      const inputKind = Array.isArray(payload.input) ? 'array' : typeof payload.input === 'string' ? 'text' : payload.input === undefined ? 'missing' : 'invalid'
      const input = inputKind === 'array' ? payload.input : inputKind === 'text' ? [payload.input] : []
      const complete = inputKind !== 'invalid' && input.length <= CACHE_DIAGNOSTICS_LIMITS.inputItems
      const items = complete ? input.map(digest) : null
      const cacheKey = payload.prompt_cache_key
      const groupSource = typeof sessionId === 'string' && sessionId ? 'session'
        : typeof cacheKey === 'string' && cacheKey ? 'cache_key' : 'none'
      const group = groupSource === 'none' ? null : digest([groupSource, groupSource === 'session' ? sessionId : cacheKey])
      const fingerprints = {
        instructions: complete ? digest([Object.hasOwn(payload, 'instructions'), payload.instructions, input.filter(item => ['system', 'developer'].includes(item?.role))]) : null,
        tools: complete ? digest([Object.hasOwn(payload, 'tools'), payload.tools, input.flatMap((item, index) => ['additional_tools', 'tool_search_output'].includes(item?.type) ? [{ index, tools: item.tools }] : [])]) : null,
        settings: digest(Object.fromEntries(Object.entries(payload).filter(([name]) => !OMIT_SETTINGS.has(name)))),
        cacheKey: digest(cacheKey),
        input: items ? digest([inputKind, items]) : null,
      }
      const previous = group && series.get(group)
      let prefix = null
      if (previous && items) {
        let commonItems = 0
        while (commonItems < Math.min(previous.items.length, items.length) && previous.items[commonItems] === items[commonItems]) commonItems++
        const sameKind = previous.inputKind === inputKind
        const appendOnly = sameKind && commonItems === previous.items.length
        prefix = {
          previousId: previous.id, previousPending: !previous.lifecycle.finished,
          previousItems: previous.items.length, commonItems, appendOnly,
          inputKindUnchanged: sameKind,
          firstChangedIndex: appendOnly ? null : sameKind ? commonItems : 0,
          firstChangedKind: appendOnly ? null : !sameKind ? 'input_shape' : inputKind === 'text' ? 'text' : commonItems >= input.length ? 'removed' : itemKind(input[commonItems]),
          instructionsUnchanged: previous.fingerprints.instructions === fingerprints.instructions,
          toolsUnchanged: previous.fingerprints.tools === fingerprints.tools,
          settingsUnchanged: previous.fingerprints.settings === fingerprints.settings,
          cacheKeyUnchanged: previous.fingerprints.cacheKey === fingerprints.cacheKey,
        }
      }
      const lifecycle = { finished: false }
      if (group) {
        series.delete(group)
        if (items) series.set(group, { id, items, inputKind, fingerprints, lifecycle })
        if (series.size > CACHE_DIAGNOSTICS_LIMITS.series) series.delete(series.keys().next().value)
      }
      const effort = payload.reasoning?.effort
      const reasoningEffort = effort === undefined ? 'absent' : EFFORTS.includes(effort) ? effort : 'invalid'
      const tier = payload.service_tier
      const serviceTier = tier === undefined ? 'absent' : ['auto', 'default', 'flex', 'priority'].includes(tier) ? tier : 'invalid'
      const context = payload.reasoning?.context
      const reasoningContext = context === undefined ? 'absent' : ['auto', 'current_turn', 'all_turns'].includes(context) ? context : 'invalid'
      const parallel = payload.parallel_tool_calls
      const parallelToolCalls = parallel === undefined ? 'absent' : typeof parallel === 'boolean' ? parallel : 'invalid'
      record({ event: 'request', id, route: 'official_responses', reasoningEffort, reasoningContext, parallelToolCalls, serviceTier, series: group, groupSource, cacheKeyPresent: Object.hasOwn(payload, 'prompt_cache_key'), inputKind, inputItems: input.length, fingerprintComplete: complete, fingerprints, prefix })
      return responseObserver(id, lifecycle, record, now)
    },
    beginDelivery(sessionId) {
      if (failed) return null
      if (deliveries >= CACHE_DIAGNOSTICS_LIMITS.requests) { limited = true; stopped('delivery_limit'); return null }
      deliveries++
      const series = typeof sessionId === 'string' && sessionId ? digest(['session', sessionId]) : null
      const startedAt = Date.now(), started = now()
      const timing = { firstTextMs: null, lastTextMs: null, firstNotifyMs: null, lastNotifyMs: null, lastNotifyReturnedMs: null, finishedMs: null }
      let finished = false, notifyRejected = false
      return {
        mark(name) {
          if (!finished && Object.hasOwn(timing, name) && (timing[name] === null || name.startsWith('last'))) timing[name] = Math.max(0, now() - started)
        },
        failed() { notifyRejected = true },
        finish() {
          if (finished) return
          timing.finishedMs = Math.max(0, now() - started)
          finished = true
          record({ event: 'delivery', series, startedAt, timing, deliveryStatus: notifyRejected ? 'notify_rejected' : 'unconfirmed' })
        },
      }
    },
    async flush() {
      await queue
      return { requests, records, bytes: writtenBytes, failed, limited, filename: file ? filename : null }
    },
  }
}
