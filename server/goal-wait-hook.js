// Gate the actual round driver, not only ACP's view of whether the prompt ended.
import { registerHooks } from 'node:module'
import { patchGoalDriverSource } from './goal-patch.js'
const TARGET = /\/@deepseek-ai\/dsh-goal-round-driver\/lib\/index\.js$/
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const source = patchGoalDriverSource(String(result.source))
    if (!source) {
      process.stderr.write('[agent-desk] goal-wait hook: driver did not match; team goal-wait will refuse to run\n')
      return result
    }
    return { ...result, source }
  },
})
