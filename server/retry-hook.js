// Loaded into every dsh process with `node --import` (see runtime.js).
//
// Makes dsh retry the transient provider failures pi-ai itself knows about
// (see retry-patch.js), by patching dsh-llm-pi-ai's error classification as
// its module loads. pi-ai's check is loaded here and handed over through a
// global, so a pi-ai without it only skips the extra rule. A second patch
// hands pi-ai the payload hook that stops replaying reasoning the Codex
// backend keeps failing on. If a dsh update changes either source, that part
// loads unpatched and behaves as before (`npm test` fails in
// retry-patch.test.js).
import { registerHooks } from 'node:module'
import { patchPayloadSource, patchPiAiSource, PAYLOAD_KEY, replayGuard, RETRYABLE_KEY, retryableCheck } from './retry-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-llm-pi-ai\/lib\/index\.js$/

try {
  const { isRetryableAssistantError } = await import('@earendil-works/pi-ai/utils/retry')
  if (typeof isRetryableAssistantError === 'function') globalThis[Symbol.for(RETRYABLE_KEY)] = retryableCheck(isRetryableAssistantError)
} catch (error) {
  process.stderr.write(`[agent-desk] retry hook: pi-ai's retry check is unavailable (${error.message})\n`)
}
globalThis[Symbol.for(PAYLOAD_KEY)] = replayGuard((message) => process.stderr.write(`[agent-desk] retry hook: ${message}\n`))

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    let source = String(result.source)
    const classified = patchPiAiSource(source)
    if (classified) source = classified
    else process.stderr.write('[agent-desk] retry hook: dsh-llm-pi-ai did not match; dropped provider streams end the turn\n')
    const guarded = patchPayloadSource(source)
    if (guarded) source = guarded
    else process.stderr.write('[agent-desk] retry hook: dsh-llm-pi-ai did not match; unreadable replayed reasoning keeps failing\n')
    return classified || guarded ? { ...result, source } : result
  },
})
