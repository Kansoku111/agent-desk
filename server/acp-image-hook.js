import { registerHooks } from 'node:module'
import { patchImageBase64Source } from './image-base64-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-acp\/lib\/index\.js$/
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchImageBase64Source(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] ACP image hook: dsh-acp did not match; using upstream image validation\n')
      return result
    }
    return { ...result, source: patched }
  },
})
