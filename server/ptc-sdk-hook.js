import { registerHooks } from 'node:module'
import { patchPtcSdkSource } from './ptc-sdk-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-tools\/lib\/index\.js$/
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchPtcSdkSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] PTC SDK compaction: tools did not match; using original declarations\n')
      return result
    }
    return { ...result, source: patched }
  },
})
