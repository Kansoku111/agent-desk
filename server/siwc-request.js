// SIWC preview compatibility. Applied after other payload hooks and again at the wire boundary.
import { CredentialStore } from './credentials.js'
import { explainSiwcUsage } from './siwc-usage-error.js'
import { SiwcClient, SIWC_RESOURCE, SIWC_KEY_PLACEHOLDER, redactSiwc } from './siwc-client.js'
import { configuredCacheDiagnostics, observeCache } from './gpt-cache-diagnostics.js'
import { configuredSiwcSocket } from './siwc-socket.js'
import { SiwcArgumentGuard } from './siwc-stream-guard.js'
export const SIWC_UNSUPPORTED_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier',
  'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
]
export const isSiwcModel = model => model?.provider === 'openai-codex'
  && model?.api === 'openai-responses' && model?.baseUrl === SIWC_RESOURCE
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
export function siwcEffort(effort, model) {
  const mapped = Object.values(model?.thinkingLevelMap ?? {}).filter(value => LEVELS.includes(value))
  const supported = [...new Set(mapped.length ? mapped : ['low', 'medium', 'high', 'xhigh'])]
  if (supported.includes(effort)) return effort
  const index = LEVELS.indexOf(effort)
  // off/none/minimal/unknown safely use the lowest supported effort, never an unsupported 'none'.
  if (index < 0) return supported[0]
  return [...supported].reverse().find(value => LEVELS.indexOf(value) <= index) ?? supported[0]
}
// Responses may normalize an omitted strict flag by making optional arguments
// required. In particular, sandbox_permissions must remain omittable: supplying
// it asks for escalation even on a read-only investigation. Preserve explicit
// strict schemas; never rewrite the registry's parameters or validation.
function withToolStrictDefault(tool) {
  if (tool.type === 'function') return { ...tool, strict: tool.strict ?? false }
  if (tool.type === 'namespace') return { ...tool, tools: tool.tools.map(withToolStrictDefault) }
  return tool
}
// Models with additional-tools support (gpt-6.1-sol) get every tool declared in
// these input items, leaving the top-level `tools` empty, so the default must
// reach them too or run_code is sent without strict and gains required escalation fields.
const TOOL_DECLARATION_ITEMS = ['additional_tools', 'tool_search_output']
function withItemStrictDefault(item) {
  if (!TOOL_DECLARATION_ITEMS.includes(item?.type) || !Array.isArray(item.tools)) return item
  return { ...item, tools: item.tools.map(withToolStrictDefault) }
}
export function siwcPayload(payload, model) {
  const next = {
    ...payload,
    store: false,
    stream: true
  }
  for (const key of SIWC_UNSUPPORTED_FIELDS) delete next[key]
  // Priority was measured to be ignored. Do not advertise/send fake GPT fast mode.
  delete next.service_tier
  if (!Array.isArray(next.input)) throw new Error('SIWC requires array input')
  next.input = next.input.map(item => withItemStrictDefault(item?.role === 'system' ? {
    ...item,
    role: 'developer'
  } : item))
  if (model?.reasoning === false) {
    delete next.reasoning
  } else next.reasoning = {
    ...next.reasoning,
    effort: siwcEffort(next.reasoning?.effort, model)
  }
  if (next.tools) next.tools = next.tools.map(withToolStrictDefault)
  const local = (next.tools ?? []).filter(tool => ['function', 'custom'].includes(tool.type))
  if (local.length) next.tools = [...next.tools.filter(tool => !local.includes(tool)), {
    type: 'namespace',
    name: 'agent_desk',
    description: 'Agent Desk local tools',
    tools: local
  }]
  return next
}
export function requireCompleted(response, observation) {
  if (!response.ok || !response.body) return response
  let pending = '',
    data = [],
    terminal = null
  const decoder = new TextDecoder()
  const argumentsGuard = new SiwcArgumentGuard()
  function line(value) {
    if (!value) {
      if (data.length) {
        let event
        try { event = JSON.parse(data.join('\n')) } catch {/* SDK will handle malformed events. */}
        try { argumentsGuard.observe(event) } catch (error) {
          observeCache(observation, 'finish', 'argument_runaway')
          throw error
        }
        if (event?.type === 'error') {
          // SIWC may send metadata before rejecting a request. The HTTP headers
          // are already 200 then; retain the streamed status so a permanent 4xx
          // does not become a retryable interruption or an SDK "undefined" error.
          const error = event.error && typeof event.error === 'object' ? event.error : event
          const status = Number.isInteger(event.status) && event.status >= 400 && event.status <= 599 ? `${event.status}: ` : ''
          const code = typeof error.code === 'string' ? error.code : 'unknown'
          const message = typeof error.message === 'string' ? error.message : 'provider error'
          if (observation) observeCache(observation, 'finish', 'failed')
          throw new Error(redactSiwc(`SIWC stream error ${status}${code}: ${message}`))
        }
        if (['response.completed', 'response.failed', 'response.incomplete'].includes(event?.type)) terminal = event.type
      }
      data = []
    } else if (value.startsWith('data:')) data.push(value.slice(5).trimStart())
  }
  function consume(text) {
    pending += text
    let end
    while ((end = pending.indexOf('\n')) !== -1) {
      line(pending.slice(0, end).replace(/\r$/, ''))
      pending = pending.slice(end + 1)
    }
  }
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      consume(decoder.decode(chunk, {
        stream: true
      }))
      controller.enqueue(chunk)
    },
    flush() {
      consume(decoder.decode() + '\n\n')
      if (observation) observeCache(observation, 'finish', terminal === 'response.completed' ? 'completed' : terminal === 'response.failed' ? 'failed' : terminal === 'response.incomplete' ? 'incomplete' : 'interrupted')
      if (terminal !== 'response.completed') throw new Error(`SIWC stream did not complete (${terminal ?? 'interrupted'})`)
    }
  }))
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}
// A response the backend stops feeding stays open with no error and no close,
// so neither the SDK (its timeout ends at the headers) nor dsh ever gives up on
// it. Silence this long, twice the longest gap seen in real GPT replies, ends
// the request as a timeout, which dsh retries.
export const SIWC_IDLE_MS = 600_000
export async function sendWithIdleLimit(send, url, init, idleMs = SIWC_IDLE_MS, observation) {
  const error = new Error(`SIWC stream timed out: no data for ${Math.round(idleMs / 1000)} s`)
  const stall = new AbortController()
  // Stream callbacks retain the signal, not the request body.
  const callerSignal = init.signal
  let timer, reader
  const arm = () => {
    timer = setTimeout(() => {
      stall.abort(error)
      reader?.cancel(error).catch(() => {})
    }, idleMs)
  }
  arm()
  let response
  try {
    if (observation) observeCache(observation, 'mark', 'sendMs')
    response = await send(url, {
      ...init,
      signal: callerSignal ? AbortSignal.any([callerSignal, stall.signal]) : stall.signal
    })
    if (observation) observeCache(observation, 'mark', 'headersMs')
  } catch (cause) {
    if (observation) observeCache(observation, 'finish', stall.signal.aborted ? 'idle_timeout' : callerSignal?.aborted ? 'cancelled' : 'transport_error')
    throw stall.signal.aborted ? error : cause
  } finally {
    clearTimeout(timer)
  }
  if (!response.body) return response
  reader = response.body.getReader()
  const body = new ReadableStream({
    async pull(controller) {
      arm()
      let chunk
      try {
        chunk = await reader.read()
      } catch (cause) {
        if (observation) observeCache(observation, 'finish', stall.signal.aborted ? 'idle_timeout' : callerSignal?.aborted ? 'cancelled' : 'transport_error')
        throw stall.signal.aborted ? error : cause
      } finally {
        clearTimeout(timer)
      }
      if (stall.signal.aborted) {
        if (observation) observeCache(observation, 'finish', 'idle_timeout')
        throw error
      }
      if (chunk.done) controller.close()
      else {
        if (observation && chunk.value.byteLength) observeCache(observation, 'mark', 'firstByteMs')
        controller.enqueue(chunk.value)
      }
    },
    cancel(reason) {
      clearTimeout(timer)
      if (observation) observeCache(observation, 'finish', 'cancelled')
      return reader.cancel(reason)
    }
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}
export function withSiwc(model, options, {
  credentials = process.env.AGENT_DESK_SIWC_CREDENTIALS,
  client,
  fetch: fetcher,
  idleMs = SIWC_IDLE_MS,
  diagnostics,
  socket
} = {}) {
  if (!isSiwcModel(model)) return options
  if (!credentials && !client) throw new Error('Official ChatGPT route requires Agent Desk SIWC authentication hook')
  const siwc = client ?? new SiwcClient(new CredentialStore(credentials))
  const previous = options?.onPayload
  const diagnostic = diagnostics === undefined ? configuredCacheDiagnostics() : diagnostics
  const send = fetcher ?? options?.fetch ?? globalThis.fetch
  // A supplied fetch owns the transport.
  const pipe = socket !== undefined ? socket : fetcher || options?.fetch ? null : configuredSiwcSocket()
  return {
    ...options,
    apiKey: SIWC_KEY_PLACEHOLDER,
    onPayload: async (payload, requestModel) => siwcPayload((await previous?.(payload, requestModel)) ?? payload, requestModel),
    fetch: async (url, init) => {
      const request = new Request(url, init)
      if (request.url !== `${SIWC_RESOURCE}/responses` || request.method !== 'POST') {
        throw new Error('Refusing to send SIWC credential outside the official Responses endpoint')
      }
      const body = siwcPayload(JSON.parse(await request.text()), model)
      const serialized = JSON.stringify(body)
      let observation
      try { observation = diagnostic?.begin(JSON.parse(serialized), options?.sessionId) } catch {}
      let credential
      try { credential = await siwc.auth() } catch (error) {
        if (observation) observeCache(observation, 'finish', 'auth_error')
        throw error
      }
      if (observation) observeCache(observation, 'mark', 'authReadyMs')
      const headers = new Headers(request.headers)
      headers.set('authorization', `Bearer ${credential.access_token}`)
      headers.set('user-agent', 'Agent-Desk-SIWC/0.1')
      headers.delete('originator')
      headers.delete('chatgpt-account-id')
      headers.delete('content-length')
      headers.delete('OpenAI-Beta')
      const transport = pipe ? (target, sendInit) => pipe.send(target, sendInit, {
        key: options?.sessionId,
        http: send,
        used: kind => observeCache(observation, 'transport', kind)
      }) : send
      const response = await sendWithIdleLimit(transport, request.url, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: serialized,
        signal: request.signal
      }, idleMs, observation)
      if (observation && !response.ok) observeCache(observation, 'finish', 'http_error', response.status)
      else if (observation && !response.body) observeCache(observation, 'finish', 'no_body', response.status)
      return requireCompleted(await explainSiwcUsage(response, observation), observation)
    }
  }
}
