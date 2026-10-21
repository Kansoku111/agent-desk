// How retry-hook.js changes dsh-llm-pi-ai, kept apart so tests can check the
// patch without registering the hook.
//
// dsh retries a model request whose failure it classifies as transient
// (TRANSPORT, SERVER, TIMEOUT, RATE_LIMIT). It classifies pi-ai's errors by
// their text with a short list of its own, and every other failure becomes the
// catch-all PI_AI_ERROR, which is not retried, so the whole turn fails. Codex
// failures that end turns this way include:
// - "WebSocket closed 1000": the backend closed the response stream mid-way
//   (dsh's transport pattern looks for `\bsocket\b`, not inside "WebSocket").
// - "exceeded request buffer limit while retrying upstream": the backend's
//   proxy could not retry a large request itself.
// - "Codex error: An error occurred … You can retry your request".
// pi-ai keeps its own, longer list of transient provider failures (its
// `isRetryableAssistantError`). The patch asks it before falling back to
// PI_AI_ERROR, so dsh retries what pi-ai itself would. A WebSocket closed for
// a message that is too big (1009) stays an error: it would fail again.

import { createHash } from 'node:crypto'

/** Terminal SIWC/auth/client errors must precede dsh's rate-limit/5xx rules. */
export const TERMINAL_RULE = [
  'if (/subscription[_\\s]sharing[_\\s]usage[_\\s]/i.test(message)) return "PI_AI_ERROR";',
  'if (/\\b(?:401|403)\\b/.test(message)) return "AUTH";',
  'if (/\\b4\\d\\d\\b/.test(message)) return "INVALID_REQUEST";',
].join(' ')

/** Where retry-hook.js puts pi-ai's check, for the patched module to call. */
export const RETRYABLE_KEY = 'agentDesk.isRetryableProviderError'

/** The rule added in place of dsh's final catch-all. */
export const EXTRA_RULE = [
  'if (/\\b1009\\b|message too big/i.test(message)) return "PI_AI_ERROR";',
  'if (/SIWC stream did not complete \\(interrupted\\)/i.test(message)) return "TRANSPORT";',
  `if (globalThis[Symbol.for(${JSON.stringify(RETRYABLE_KEY)})]?.(message) === true) return "TRANSPORT";`,
].join(' ')

/** dsh-llm-pi-ai's source with the extra rule, or null when it does not look as expected. */
export function patchPiAiSource(source) {
  const anchor = /function classifyPiAiError\(message\) \{[^}]*?(\n\treturn "PI_AI_ERROR";\n\})/.exec(source)
  if (!anchor || !anchor[0].includes('return "TRANSPORT"')) return null
  const at = anchor.index + anchor[0].length - anchor[1].length
  const patched = `${source.slice(0, at)}\n\t${EXTRA_RULE}${source.slice(at)}`
  const start = anchor.index + 'function classifyPiAiError(message) {'.length
  return `${patched.slice(0, start)}\n\t${TERMINAL_RULE}${patched.slice(start)}`
}

// Retries cannot get past a reasoning item the Codex backend can no longer
// read. dsh replays the encrypted reasoning of earlier GPT replies with every
// request, and the backend answers a request carrying such an item with
// `server_error` ("An error occurred while processing your request") within a
// second, every time. One bad reply then fails each later request in the task.
// The second patch hands pi-ai an `onPayload` hook ({@link replayGuard}) that
// sends the replayed reasoning no more once the same request has failed twice.

/** Where retry-hook.js puts the payload hook, for the patched module to pass to pi-ai. */
export const PAYLOAD_KEY = 'agentDesk.onProviderPayload'

/** dsh-llm-pi-ai's source with the payload hook added, or null when it does not look as expected. */
export function patchPayloadSource(source) {
  const anchor = /function profileOptions\(profile, reasoning, apiKey\) \{(?:(?!\n\})[\s\S])*?\n\t\tmaxRetries: 0\n\t\};/.exec(source)
  if (!anchor) return null
  const at = anchor.index + anchor[0].length - '\n\t};'.length
  return `${source.slice(0, at)},\n\t\tonPayload: globalThis[Symbol.for(${JSON.stringify(PAYLOAD_KEY)})]${source.slice(at)}`
}

/** Both patches retry-hook.js applies, or null unless both match (the strict update gate). */
export function patchRetrySource(source) {
  const classified = patchPiAiSource(source)
  return classified && patchPayloadSource(classified)
}

/** How often the same request is sent before its replayed reasoning is left out. */
const SENDS_BEFORE_DROP = 3
const MAX_SESSIONS = 200

/**
 * pi-ai's `onPayload` hook. A retry sends the same input again, so the third
 * send of one input means it failed twice: its replayed reasoning items are
 * dropped then, and from the later requests of the same session (pi-ai's
 * `prompt_cache_key`), which carry them too. Reasoning from newer replies is
 * kept. Bodies without OpenAI Responses input pass through unchanged.
 * @param {(message: string) => void} [log]
 */
export function replayGuard(log = () => {}) {
  const sessions = new Map()
  return (body) => {
    if (!Array.isArray(body?.input) || body.input.length === 0) return undefined
    const key = `${body.model ?? ''}:${body.prompt_cache_key ?? ''}`
    let state = sessions.get(key)
    if (!state) {
      state = { fingerprint: null, sends: 0, dropped: new Set() }
      sessions.set(key, state)
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(body.input)).digest('hex')
    state.sends = fingerprint === state.fingerprint ? state.sends + 1 : 1
    state.fingerprint = fingerprint
    if (state.sends === SENDS_BEFORE_DROP) {
      const before = state.dropped.size
      for (const item of body.input) if (isReplayedReasoning(item)) state.dropped.add(item.id)
      if (state.dropped.size > before) log(`the same request failed twice; leaving out ${state.dropped.size - before} replayed reasoning items`)
    }
    if (state.dropped.size === 0) return undefined
    const input = body.input.filter((item) => !(isReplayedReasoning(item) && state.dropped.has(item.id)))
    return input.length === body.input.length ? undefined : { ...body, input }
  }
}

function isReplayedReasoning(item) {
  return item?.type === 'reasoning' && typeof item.id === 'string'
    && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0
}

/** pi-ai's check, as the patched rule calls it: true for a transient provider failure. */
export function retryableCheck(isRetryableAssistantError) {
  return (message) => {
    try {
      return isRetryableAssistantError({ stopReason: 'error', errorMessage: String(message) }) === true
    } catch {
      return false
    }
  }
}
