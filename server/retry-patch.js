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

/** Where retry-hook.js puts pi-ai's check, for the patched module to call. */
export const RETRYABLE_KEY = 'agentDesk.isRetryableProviderError'

/**
 * Terminal SIWC/auth/client errors must precede dsh's rate-limit/5xx rules.
 * A 429 is dsh's rate-limit class, which dsh retries, so it is not one of the
 * client errors here: dsh's own quota rule judges the hard limits below it.
 * A 429 that names a permanent limit stays terminal, because pi-ai knows those
 * limits by their wording (its quota, billing and free-tier wording).
 */
export const TERMINAL_RULE = [
  'if (/SIWC_TOOL_ARGUMENT_RUNAWAY/.test(message)) return "PI_AI_ERROR";',
  'if (/subscription[_\\s]sharing[_\\s]usage[_\\s]/i.test(message)) return "PI_AI_ERROR";',
  'if (/\\b(?:401|403)\\b/.test(message)) return "AUTH";',
  `if (/\\b429\\b/.test(message) && globalThis[Symbol.for(${JSON.stringify(RETRYABLE_KEY)})]?.(message) === false) return QUOTA_EXCEEDED_CODE;`,
  'if (/\\b4\\d\\d\\b/.test(message) && !/\\b429\\b/.test(message)) return "INVALID_REQUEST";',
].join(' ')

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

// Retrying a transport failure is not evidence that encrypted reasoning is
// corrupt. Preserve the payload; never discard model context just because the
// same request was sent several times.
export const patchRetrySource = patchPiAiSource

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
