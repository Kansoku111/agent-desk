// Loaded by runtimeHookArgs(); source drift warns at launch and fails the
// strict update gate. No dependency files are rewritten on disk.
import { registerHooks } from 'node:module'
import { patchGoalToolSource } from './goal-tool-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-tool-goal\/lib\/index\.js$/

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchGoalToolSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] goal tool hook: dsh-tool-goal did not match; goal argument guidance is unchanged\n')
      return result
    }
    return { ...result, source: patched }
  },
})
