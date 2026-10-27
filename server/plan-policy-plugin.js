// Rebind a resumed session to the app-selected process policy, without replacing history.
// The ACP acknowledgement is exposed only after the policy event has been flushed.
export const name = 'agent-desk-plan-session-policy'
export const inject = ['sandboxPolicy', 'sessions']
export const PLAN_POLICY_CONFIG = 'agent_desk_plan_policy'
const policies = new WeakMap()

export function planPolicyOption(agent) {
  const policy = policies.get(agent)
  if (!policy) return []
  return [{ id: PLAN_POLICY_CONFIG, name: 'Session policy', type: 'select', currentValue: policy,
    options: [{ value: policy, name: policy }] }]
}

export function assertPlanPolicy(options, plan, mode) {
  if (options?.find((option) => option.id === PLAN_POLICY_CONFIG)?.currentValue !== `${plan ? 'plan' : 'normal'}:${mode}`) {
    throw new Error('Planの権限制限を実行環境で確認できません。送信を停止しました。Agent Deskを再起動してください。')
  }
}

export function apply(ctx, config) {
  ctx.on('agent/created', async ({ agent }) => {
    const mode = ctx.sandboxPolicy.defaultMode
    if (config?.plan && mode !== 'read-only') throw new Error('Plan requires a read-only runtime')
    if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== mode) {
      agent.session.append('sandbox/mode', { mode })
      await ctx.sessions.flush(agent.session)
    }
    if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== mode) throw new Error('Session policy was not applied')
    policies.set(agent, `${config?.plan ? 'plan' : 'normal'}:${mode}`)
  })
}
