import { registerHooks } from 'node:module'
import { patchPtcResultsSource } from './ptc-results-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-tool-executor-ptc\/lib\/index\.js$/
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchPtcResultsSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] PTC result compaction: executor did not match; using full results\n')
      return result
    }
    return { ...result, source: patched }
  },
})
