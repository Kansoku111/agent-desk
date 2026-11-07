// Loaded by every app-managed dsh process; installed packages remain untouched.
import { registerHooks } from 'node:module'
import { patchCompactionSource } from './compaction-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-compaction-basic\/lib\/index\.js$/

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const source = patchCompactionSource(String(result.source))
    if (!source) {
      process.stderr.write('[agent-desk] compaction hook: dsh-compaction-basic did not match; oversized history may skip automatic compaction\n')
      return result
    }
    return { ...result, source }
  },
})
