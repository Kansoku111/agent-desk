import { registerHooks } from 'node:module'
import { patchPtcRuntimeSource } from './ptc-runtime-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-ptc-runtime-node\/lib\/index\.js$/
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchPtcRuntimeSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] PTC syntax diagnostics: runtime did not match; using original errors\n')
      return result
    }
    return { ...result, source: patched }
  },
})
