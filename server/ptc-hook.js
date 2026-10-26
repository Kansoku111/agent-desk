import { registerHooks } from 'node:module'
import { patchPtcSource } from './ptc-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-acp\/lib\/index\.js$/
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchPtcSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] PTC hook: dsh-acp did not match; PTC is unavailable\n')
      return result
    }
    return { ...result, source: patched }
  },
})
