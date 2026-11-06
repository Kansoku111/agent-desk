// Official SIWC Responses over WebSocket. Only the pipe differs from HTTP: same
// resource, same token, same plan billing, and the full input on every request.
// previous_response_id is deliberately unused: measured no faster than resending
// the input on an open socket (docs/gpt-efficiency.md), and it would make the
// server's view of a conversation diverge from dsh's after a prune.
import { SIWC_RESOURCE } from './siwc-client.js'

export const SIWC_SOCKET_URL = `${SIWC_RESOURCE.replace(/^https:/, 'wss:')}/responses`
export const SIWC_TRANSPORT_ENV = 'AGENT_DESK_SIWC_TRANSPORT'
const TERMINALS = new Set(['response.completed', 'response.failed', 'response.incomplete'])
const OPEN = 1
// Measured handshakes take 0.6-1.1 s. Slower than this means HTTP is the better wait.
const CONNECT_MS = 5_000
// A reconnect costs about as much as one request saves, so outlast ordinary tool runs.
const IDLE_MS = 5 * 60_000
// The service ends a connection at 60 minutes and fails the request that crosses it.
const MAX_AGE_MS = 55 * 60_000
const COOLDOWN_MS = 5 * 60_000
// The first event took 0.06-0.6 s once sent. A socket left over from a sleep or a
// network change can look open and never answer; without this the request would
// wait out the whole stream silence limit, which a fresh HTTP connection never risks.
const FIRST_EVENT_MS = 20_000

async function openSocket(url, headers, connectMs, signal) {
  const { default: WebSocket } = await import('ws')
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: connectMs, perMessageDeflate: false, followRedirects: false })
    const onAbort = () => socket.terminate()
    const settle = (finish, value) => {
      signal?.removeEventListener('abort', onAbort)
      socket.off('open', onOpen)
      socket.off('error', onError)
      finish(value)
    }
    const onOpen = () => settle(resolve, socket)
    const onError = error => settle(reject, signal?.aborted ? signal.reason : error)
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
}

// ws has no public API for this. Without it an idle socket keeps a finished
// headless dsh alive until the idle close; HTTP keep-alive sockets do not.
const holdProcess = (socket, held) => socket._socket?.[held ? 'ref' : 'unref']?.()

/** Send one request on an open socket; settles at its first event or a close before one. */
function exchange(entry, payload, signal, firstEventMs, onSettled, onBroken) {
  const { socket } = entry
  const encoder = new TextEncoder()
  return new Promise((resolve, reject) => {
    let controller = null, ended = false, silent = null
    const stop = () => {
      ended = true
      clearTimeout(silent)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
    const emit = event => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
    const onMessage = data => {
      let event
      try { event = JSON.parse(data.toString()) } catch { return }
      clearTimeout(silent)
      if (!controller) {
        if (event.type === 'error') {
          stop()
          resolve({ refused: event })
          return
        }
        const body = new ReadableStream({
          start(c) { controller = c },
          cancel() {
            if (ended) return
            stop()
            onBroken()
          },
        })
        resolve({ response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }) })
      }
      emit(event)
      if (TERMINALS.has(event.type)) {
        stop()
        controller.close()
        onSettled()
      } else if (event.type === 'error') {
        // The service drops the connection shortly after an error event.
        stop()
        controller.close()
        onBroken()
      }
    }
    const onClose = code => {
      stop()
      // requireCompleted reports this as the same retryable interruption as HTTP.
      if (controller) controller.close()
      else resolve({ closed: code })
    }
    const onAbort = () => {
      const reason = signal.reason
      stop()
      onBroken()
      if (controller) controller.error(reason)
      else reject(reason)
    }
    socket.on('message', onMessage)
    socket.on('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    // Starts once written, so a slow upload of a long history is not mistaken for silence.
    socket.send(payload, error => {
      if (ended || controller) return
      if (error) onClose(error.code ?? 'send')
      else silent = setTimeout(() => onClose('silent'), firstEventMs)
    })
  })
}

function refusedResponse({ status, error, headers }) {
  const valid = Number.isInteger(status) && status >= 400 && status <= 599
  const safe = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string' && /^(retry-after|x-ratelimit-)/i.test(name)) safe[name] = value
  }
  return new Response(JSON.stringify({ error: error ?? { message: 'SIWC WebSocket request failed' } }), {
    status: valid ? status : 500,
    headers: { 'content-type': 'application/json', ...safe }
  })
}

export function createSiwcSocket({
  url = SIWC_SOCKET_URL, open = openSocket, connectMs = CONNECT_MS, idleMs = IDLE_MS,
  maxAgeMs = MAX_AGE_MS, cooldownMs = COOLDOWN_MS, firstEventMs = FIRST_EVENT_MS, now = Date.now
} = {}) {
  const sessions = new Map()
  let coolUntil = 0, tooLarge = Infinity
  const drop = (key, entry) => {
    clearTimeout(entry.idle)
    if (sessions.get(key) === entry) sessions.delete(key)
    entry.socket?.terminate()
  }
  const release = (key, entry) => {
    entry.busy = false
    holdProcess(entry.socket, false)
    entry.idle = setTimeout(() => drop(key, entry), idleMs)
    entry.idle.unref?.()
  }
  /** The fetch contract for one request. `http` is what to use when this pipe cannot serve it. */
  async function send(requestUrl, init, { key, http, used }) {
    const viaHttp = () => {
      used?.('http')
      return http(requestUrl, init)
    }
    // Calls without a session (title, search helpers) have no next request to speed up.
    if (!key || now() < coolUntil || String(init.body).length >= tooLarge) return viaHttp()
    let entry = sessions.get(key)
    // The socket serves one response at a time; an overlapping call in a session keeps HTTP.
    if (entry?.busy) return viaHttp()
    const headers = new Headers(init.headers)
    const token = headers.get('authorization')
    if (entry && (entry.token !== token || now() - entry.openedAt >= maxAgeMs || entry.socket.readyState !== OPEN)) {
      drop(key, entry)
      entry = null
    }
    const reused = Boolean(entry)
    if (entry) clearTimeout(entry.idle)
    else {
      entry = { socket: null, token, openedAt: now(), busy: true, idle: null }
      sessions.set(key, entry)
      try {
        entry.socket = await open(url, { authorization: token, 'user-agent': headers.get('user-agent') }, connectMs, init.signal)
      } catch (error) {
        sessions.delete(key)
        if (init.signal?.aborted) throw init.signal.reason ?? error
        coolUntil = now() + cooldownMs
        return viaHttp()
      }
      const opened = entry
      opened.socket.on('close', () => {
        clearTimeout(opened.idle)
        if (sessions.get(key) === opened) sessions.delete(key)
      })
      // ws raises this before close; close alone decides what happens next.
      opened.socket.on('error', () => {})
    }
    entry.busy = true
    holdProcess(entry.socket, true)
    const { stream: _stream, background: _background, ...body } = JSON.parse(init.body)
    const payload = JSON.stringify({ type: 'response.create', ...body })
    const current = entry
    const result = await exchange(current, payload, init.signal, firstEventMs, () => release(key, current), () => drop(key, current))
    if (result.response) {
      used?.('websocket')
      return result.response
    }
    drop(key, current)
    if ('closed' in result) {
      if (result.closed === 1009) tooLarge = Math.min(tooLarge, String(init.body).length)
      // A reused socket may simply have gone stale; a new one failing says more.
      else if (!reused) coolUntil = now() + cooldownMs
      return viaHttp()
    }
    if (result.refused.error?.code === 'websocket_connection_limit_reached') return viaHttp()
    // HTTP repeats a truly invalid request's error and serves one only this pipe rejects.
    if (result.refused.status === 400) {
      coolUntil = now() + cooldownMs
      return viaHttp()
    }
    used?.('websocket')
    return refusedResponse(result.refused)
  }
  return {
    send,
    close() {
      for (const [key, entry] of sessions) drop(key, entry)
    }
  }
}

let shared
/** The process-wide pipe, or null when HTTP was requested for comparison or support. */
export function configuredSiwcSocket() {
  if (process.env[SIWC_TRANSPORT_ENV] === 'http') return null
  return shared ??= createSiwcSocket()
}
