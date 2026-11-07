// Loaded by every app-managed dsh process; installed packages remain untouched.
import { registerHooks } from 'node:module'
import { patchContextOverflowSource } from './context-overflow-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-llm-pi-ai\/lib\/index\.js$/

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const source = patchContextOverflowSource(String(result.source))
    if (!source) {
      process.stderr.write('[agent-desk] context-overflow hook: dsh-llm-pi-ai did not match; successful responses above the context budget may fail\n')
      return result
    }
    return { ...result, source }
  },
})
