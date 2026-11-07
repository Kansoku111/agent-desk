// Loaded into every app-managed dsh process; installed packages remain unchanged.
import { registerHooks } from 'node:module'
import { patchReasoningUsageSource } from './reasoning-usage-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-llm-pi-ai\/lib\/index\.js$/
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const source = patchReasoningUsageSource(String(result.source))
    if (!source) {
      process.stderr.write('[agent-desk] reasoning usage hook: dsh-llm-pi-ai did not match; reasoning breakdown may be unavailable\n')
      return result
    }
    return { ...result, source }
  },
})
