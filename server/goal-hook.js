// Loaded into every dsh process with `node --import` (see runtime.js).
//
// Keeps a `session/prompt` in flight while dsh continues a goal on its own
// (see goal-patch.js), so the task shows as working, can be stopped, and is
// not mistaken for idle while goal rounds run. The patch matches dsh-acp's
// built source. If a dsh update changes it, the module loads unpatched and a
// prompt settles at the first idle as before (`npm test` fails in
// goal-patch.test.js).
import { registerHooks } from 'node:module'
import { patchGoalSource } from './goal-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-acp\/lib\/index\.js$/

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchGoalSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] goal hook: dsh-acp did not match; goal rounds run after the task shows as finished\n')
      return result
    }
    return { ...result, source: patched }
  },
})
