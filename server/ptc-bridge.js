// Loaded only inside dsh. Each ACP root owns its own presentation declaration;
// this does not change the deployment default or a subagent's composition.
// dsh 0.2.2 dropped tools.presentAs(): a presentation is now the executor
// registered in the agent's scope. Registering one explicitly for "native" too
// keeps the root's choice independent of whatever executor the deployment mounts.
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { TOOL_MODE_CONFIG, TOOL_MODES } from './ptc.js'
import { withPtcGuidance } from './ptc-guidance.js'
import { SESSION_POLICY_CONFIG, sessionPolicyOption } from './session-policy-plugin.js'
const states = new WeakMap()
const stateOf = (record) => {
  if (!states.has(record)) states.set(record, { mode: 'native', dispose: null, changing: false })
  return states.get(record)
}

export function withToolMode(record, options) {
  assertPresentationReady(record)
  return [...options.filter((option) => option.id !== TOOL_MODE_CONFIG && option.id !== SESSION_POLICY_CONFIG), ...sessionPolicyOption(record.agent), {
    id: TOOL_MODE_CONFIG, name: 'PTC', type: 'select', currentValue: stateOf(record).mode,
    options: [{ value: 'native', name: 'Off' }, { value: 'ptc', name: 'On' }],
  }]
}

export function assertPresentationReady(record) {
  const state = stateOf(record)
  if (state.changing || state.mode === null) throw new Error('PTC presentation is not ready')
}

export async function setToolMode(record, mode) {
  if (!TOOL_MODES.includes(mode)) throw new Error('unknown PTC presentation')
  const state = stateOf(record)
  if (record.inflight !== undefined || record.agent.status !== 'idle' || state.changing) throw new Error('cannot change PTC presentation while busy')
  if (state.mode === mode) return
  state.changing = true
  state.mode = null // A failed declaration must never allow an unverified prompt.
  try {
    await state.dispose?.()
    state.dispose = null
    record.assertActive()
    const ctx = record.agent.ctx
    state.dispose = ctx.tools.setExecutor(mode === 'ptc' ? withPtcGuidance(new PtcExecutor(ctx), ctx) : new NativeToolExecutor(ctx))
    state.mode = mode
  } finally {
    state.changing = false
  }
}

export { TOOL_MODE_CONFIG }
export { ptcEventUpdate, ptcResultEvent } from './ptc.js'
