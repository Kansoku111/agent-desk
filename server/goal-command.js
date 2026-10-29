// Explicit user commands only: reports and delegated work must remain plain text.
export const GOAL_OBJECTIVE_META = 'agentDesk/goalObjective'
export const GOAL_COMMAND_CAPABILITY = 'agentDesk/goalCommand'

export function goalCommandObjective(text) {
  if (!/^\/goal(?:\s|$)/i.test(text.trimStart())) return undefined
  const objective = text.trim().slice(5).trim()
  if (!objective) throw new Error('使い方: /goal 達成したい目標')
  return objective
}

// Called synchronously at ACP prompt admission, before the first model request.
// Use the goal domain rather than asking the model to remember to call a tool.
export function applyGoalCommand(ctx, agent, objective, content) {
  if (typeof objective !== 'string' || !objective.trim()) throw new Error('goal objective must be non-empty text')
  const goals = ctx.get('goals')
  if (!goals) throw new Error('goal機能を利用できません。Agent Deskとdshを確認してください。')
  const current = goals.get(agent)
  if (current && current.phase !== 'complete') {
    throw new Error('既存の目標があります。現在の目標の再開・変更・終了を会話で依頼してください。/goalでは上書きしません。')
  }
  const goal = goals.create(agent, { objective: objective.trim() })
  content.push({ type: 'text', text: `[Agent Desk /goal]\nThe app has already created and armed this session's goal: ${JSON.stringify({ id: goal.id, revision: goal.revision, objective: goal.objective, maxGoalRounds: goal.maxGoalRounds })}. Do not create another goal. Work toward this objective within the user's approved scope and the existing workflow rules. Before claiming completion, verify the whole objective, use get_goal, and mark it complete. If work remains, leave it active. Respect questions, approvals, stops, and the configured goal-tool policy; do not invent extra work just to continue.` })
  return goal
}
