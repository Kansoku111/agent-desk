// Loaded into every dsh runtime by runtimeHookArgs(). Like the other source
// hooks, upstream drift warns at launch and fails the strict update gate.
import { registerHooks } from 'node:module'
import { patchFsReadSource } from './fs-read-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-tool-fs\/lib\/index\.js$/

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchFsReadSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] fs read hook: dsh-tool-fs did not match; read does not state its line cap\n')
      return result
    }
    return { ...result, source: patched }
  },
})
