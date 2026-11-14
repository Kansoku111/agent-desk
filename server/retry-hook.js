// Loaded into every dsh process with node --import. Only transient provider
// errors are reclassified and idle timeouts enter dsh's retry policy; retries
// never remove reasoning from the payload.
import { registerHooks } from 'node:module'
import { patchRetrySource, RETRYABLE_KEY, retryableCheck } from './retry-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-llm-pi-ai\/lib\/index\.js$/
// A specifier of this hook's own: pi-ai's retry check, resolved the way the
// dsh-llm-pi-ai that dsh loaded resolves pi-ai. That is the copy dsh runs. It
// sits under dsh-llm-pi-ai when the app's own pi-ai is another version, and
// the lists differ: the app's 0.87.1 lacks the dropped-stream and capacity
// failures 1.5.2 retries, and reads "429" inside any longer number as a rate limit.
const ENGINE_RETRY = 'agent-desk:engine-pi-ai-retry'
let engine = null
let installing = null

/** Resolves true once pi-ai's check is installed from the copy dsh runs, else to why it is not; null until dsh-llm-pi-ai has loaded. */
export const engineRetryCheck = () => installing

function installCheck(url) {
  engine = url
  // After this load hook returns: the import below goes through the hooks again.
  installing = Promise.resolve().then(() => import(ENGINE_RETRY)).then(({ isRetryableAssistantError }) => {
    if (typeof isRetryableAssistantError !== 'function') throw new Error('isRetryableAssistantError is not exported')
    globalThis[Symbol.for(RETRYABLE_KEY)] = retryableCheck(isRetryableAssistantError)
    return true
  }).catch((error) => {
    process.stderr.write(`[agent-desk] retry hook: pi-ai's retry check is unavailable (${error.message})\n`)
    return error.message
  })
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Through pi-ai's public export, so a file left on disk after its export went away is not used.
    return specifier === ENGINE_RETRY
      ? nextResolve('@earendil-works/pi-ai/utils/retry', { ...context, parentURL: engine })
      : nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const source = patchRetrySource(String(result.source))
    if (!source) {
      process.stderr.write('[agent-desk] retry hook: dsh-llm-pi-ai did not match; dropped provider streams end the turn\n')
      return result
    }
    if (!installing) installCheck(url)
    return { ...result, source }
  },
})
