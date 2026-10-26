// SIWC preview compatibility. Applied after other payload hooks and again at the wire boundary.
import { CredentialStore } from './credentials.js'
import { explainSiwcUsage } from './siwc-usage-error.js'
import { SiwcClient, SIWC_RESOURCE, SIWC_KEY_PLACEHOLDER } from './siwc-client.js'
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
  next.input = next.input.map(item => item?.role === 'system' ? {
    ...item,
    role: 'developer'
  } : item)
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
export function requireCompleted(response) {
  if (!response.ok || !response.body) return response
  let pending = '',
    data = [],
    terminal = null
  const decoder = new TextDecoder()
  function line(value) {
    if (!value) {
      if (data.length) {
        try {
          const event = JSON.parse(data.join('\n'))
          if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) terminal = event.type
        } catch {/* SDK will handle malformed events. */}
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
export async function sendWithIdleLimit(send, url, init, idleMs = SIWC_IDLE_MS) {
  const error = new Error(`SIWC stream timed out: no data for ${Math.round(idleMs / 1000)} s`)
  const stall = new AbortController()
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
    response = await send(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, stall.signal]) : stall.signal
    })
  } catch (cause) {
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
        throw stall.signal.aborted ? error : cause
      } finally {
        clearTimeout(timer)
      }
      if (stall.signal.aborted) throw error
      if (chunk.done) controller.close()
      else controller.enqueue(chunk.value)
    },
    cancel(reason) {
      clearTimeout(timer)
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
  idleMs = SIWC_IDLE_MS
} = {}) {
  if (!isSiwcModel(model)) return options
  if (!credentials && !client) throw new Error('Official ChatGPT route requires Agent Desk SIWC authentication hook')
  const siwc = client ?? new SiwcClient(new CredentialStore(credentials))
  const previous = options?.onPayload
  const send = fetcher ?? options?.fetch ?? globalThis.fetch
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
      const credential = await siwc.auth()
      const headers = new Headers(request.headers)
      headers.set('authorization', `Bearer ${credential.access_token}`)
      headers.set('user-agent', 'Agent-Desk-SIWC/0.1')
      headers.delete('originator')
      headers.delete('chatgpt-account-id')
      headers.delete('content-length')
      headers.delete('OpenAI-Beta')
      const response = await sendWithIdleLimit(send, request.url, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify(body),
        signal: request.signal
      }, idleMs)
      return requireCompleted(await explainSiwcUsage(response))
    }
  }
}
