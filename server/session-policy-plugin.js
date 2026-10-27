// Restore the process policy when resuming a session, including legacy strict Plan logs.
// Expose acknowledgement only after a changed sandbox mode is durable.
export const name = 'agent-desk-session-policy'
export const inject = ['sandboxPolicy', 'sessions']
export const SESSION_POLICY_CONFIG = 'agent_desk_session_policy'
const policies = new WeakMap()

export function sessionPolicyOption(agent) {
  const mode = policies.get(agent)
  if (!mode) return []
  return [{ id: SESSION_POLICY_CONFIG, name: 'Session policy', type: 'select', currentValue: mode,
    options: [{ value: mode, name: mode }] }]
}

export function assertSessionPolicy(options, mode) {
  if (options?.find((option) => option.id === SESSION_POLICY_CONFIG)?.currentValue !== mode) {
    throw new Error('旧Planセッションの権限復元を確認できません。送信を停止しました。Agent Deskを再起動してください。')
  }
}

export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    const mode = ctx.sandboxPolicy.defaultMode
    if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== mode) {
      agent.session.append('sandbox/mode', { mode })
      await ctx.sessions.flush(agent.session)
    }
    if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== mode) throw new Error('Session policy was not applied')
    policies.set(agent, mode)
  })
}
