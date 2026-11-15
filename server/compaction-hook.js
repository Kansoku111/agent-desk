// Loaded by every app-managed dsh process; installed packages remain untouched.
import { registerHooks } from 'node:module'
import { patchCompactionSelectorSource, patchSummaryEffortSource } from './compaction-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-compaction-basic\/lib\/index\.js$/
// Independent changes: a drifted anchor in one must not take the other with it.
const PATCHES = [
  [patchCompactionSelectorSource, 'oversized history may skip automatic compaction'],
  [patchSummaryEffortSource, 'automatic summaries go out at the lowest effort and miss the prompt cache'],
]

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    let source = String(result.source)
    for (const [patch, effect] of PATCHES) {
      const next = patch(source)
      if (next) source = next
      else process.stderr.write(`[agent-desk] compaction hook: dsh-compaction-basic did not match; ${effect}\n`)
    }
    return { ...result, source }
  },
})
