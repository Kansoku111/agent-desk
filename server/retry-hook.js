// Loaded into every dsh process with node --import. Only transient provider
// errors are reclassified; retries never remove reasoning from the payload.
import { registerHooks } from 'node:module'
import { patchRetrySource, RETRYABLE_KEY, retryableCheck } from './retry-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-llm-pi-ai\/lib\/index\.js$/

try {
  const { isRetryableAssistantError } = await import('@earendil-works/pi-ai/utils/retry')
  if (typeof isRetryableAssistantError === 'function') globalThis[Symbol.for(RETRYABLE_KEY)] = retryableCheck(isRetryableAssistantError)
} catch (error) {
  process.stderr.write(`[agent-desk] retry hook: pi-ai's retry check is unavailable (${error.message})\n`)
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const source = patchRetrySource(String(result.source))
    if (!source) {
      process.stderr.write('[agent-desk] retry hook: dsh-llm-pi-ai did not match; dropped provider streams end the turn\n')
      return result
    }
    return { ...result, source }
  },
})
