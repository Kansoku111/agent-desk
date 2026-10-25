// Loaded into every dsh runtime by runtimeHookArgs(). Like the other source
// hooks, upstream drift warns at launch and fails the strict update gate.
import { registerHooks } from 'node:module'
import { patchFsSearchSource } from './fs-search-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-tool-fs-search\/lib\/index\.js$/

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchFsSearchSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] fs search hook: dsh-tool-fs-search did not match; broad searches may exceed the output limit\n')
      return result
    }
    return { ...result, source: patched }
  },
})
