// Loaded into every dsh process with `node --import` (see runtime.js).
//
// ACP has no way to add a message to a turn that is still running: dsh-acp
// refuses a second `session/prompt` while one is in flight. dsh's agent loop
// can take one, though: `agent.steer()` hands a user message to the running
// turn, which reads it at its next step. This hook patches dsh-acp's prompt
// handler, as its module loads, so a prompt sent with
// `_meta: { "agentDesk/steer": true }` while another is in flight is steered
// into that turn and answered at once (`_meta: { "agentDesk/steered": true }`).
// The running prompt's settlement waits for the agent to go idle, so whatever
// the steered message leads to still arrives as part of that prompt.
//
// The patch matches dsh-acp's built source. If a dsh update changes it, the
// module loads unpatched and a steer is refused as before ("already in flight").
import { registerHooks } from 'node:module'
import { patchAcpSource } from './steer-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-acp\/lib\/index\.js$/

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchAcpSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] steer hook: dsh-acp did not match; sending during a turn is unavailable\n')
      return result
    }
    return { ...result, source: patched }
  },
})
