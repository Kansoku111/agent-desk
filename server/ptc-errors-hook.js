import { registerHooks } from 'node:module'
import { patchPtcRuntimeSource, patchPtcWorkerSource } from './ptc-runtime-patch.js'

const RUNTIME = /\/@deepseek-ai\/dsh-ptc-runtime-node\/lib\/index\.js$/
const WORKER = /\/@deepseek-ai\/dsh-ptc-runtime-node\/lib\/process\.js$/
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || result.source == null) return result
    const path = new URL(url).pathname
    const worker = WORKER.test(path)
    if (!worker && !RUNTIME.test(path)) return result
    const patched = (worker ? patchPtcWorkerSource : patchPtcRuntimeSource)(String(result.source))
    if (!patched) {
      if (worker) throw new Error('PTC input accessor: worker source did not match')
      process.stderr.write('[agent-desk] PTC syntax diagnostics: runtime did not match; using original errors\n')
      return result
    }
    return { ...result, source: patched }
  },
})
