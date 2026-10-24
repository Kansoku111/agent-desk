// Like the existing steer/goal hooks: never edit installed dsh packages.
import { registerHooks } from 'node:module'
import { patchOutputSpeedSource } from './output-speed-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-acp\/lib\/index\.js$/

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const source = patchOutputSpeedSource(String(result.source))
    if (!source) {
      process.stderr.write('[agent-desk] output-speed hook: dsh-acp did not match; live speed is unavailable\n')
      return result
    }
    return { ...result, source }
  },
})
