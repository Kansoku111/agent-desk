// dsh's update_goal takes empty-string/zero fillers for the fields an action does
// not use, but its model-facing descriptions do not say so, and models copied a
// goal's current round cap into resume/complete. Only the guidance is patched.
// Up to 0.2.1-rc.5 dsh rejected those extra fields and this file also rewrote
// the rejection to name them; 0.2.2-rc.1 ignores them instead, so there is no
// error left to improve. Every upstream guard (authority, revision, blocked
// threshold, blocked_reason) is untouched.
//
// create_goal is not registered: goals start only from the user's `/goal`
// command, which creates the goal through the goal domain (goal-command.js).
// Upstream lets the model infer a goal from any direct request; in a lab task of
// about nine minutes every run did, and the extra tests, fixes and goal rounds
// doubled time and cost against Codex (real sessions: 156 of 1,528 had a
// model-made goal). get_goal and update_goal stay so a `/goal` goal can be
// completed, paused, or resumed after a restart. Hiding only this tool keeps the
// tool list fixed for the whole session, so prompt caching is unaffected.
// Design note: docs/investigations/self-created-goals-20261113.md.

const UPDATE_GUIDANCE = 'For update_goal, pause/resume/complete need only goal_id, revision, and action. Do not copy the current objective or round cap into these calls. Omit unused objective, max_goal_rounds, and blocked_reason; if all fields are required, use objective="", max_goal_rounds=0, blocked_reason="". Only edit may replace objective/max_goal_rounds; only blocked uses blocked_reason.'
const CREATE_GUIDANCE = 'Only the user starts a goal, with the /goal command; there is no tool to create one, so do not try or suggest a workaround. '

export function patchGoalToolSource(source) {
  const replacements = [
    ['create_goal may infer goal intent from a direct human request in any language. ', CREATE_GUIDANCE],
    // Keep defineTool's validation of the upstream definition; only the registration is dropped.
    ['ctx.tools.register(defineTool({\n\t\tname: "create_goal",', 'void (defineTool({\n\t\tname: "create_goal",'],
    ['difficulty, uncertainty, or useful remaining work is not blocked.', `difficulty, uncertainty, or useful remaining work is not blocked. ${UPDATE_GUIDANCE}`],
    ['description: "Update the current goal."', `description: ${JSON.stringify(`Update the current goal. ${UPDATE_GUIDANCE}`)}`],
    ['Replacement objective; valid only with action edit.', 'Replacement objective for edit only. Otherwise omit it, or use an empty string if all fields are required. Do not copy the current objective.'],
    ['Replacement cap; valid only with action edit.', 'Replacement positive safe-integer cap for edit only. Otherwise omit it, or use 0 if all fields are required. Do not copy the current round cap.'],
    ['Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.', 'Required with blocked: the concrete condition that persisted across rounds and blocks progress. Otherwise omit it, or use an empty string if all fields are required.'],
  ]
  for (const [before, after] of replacements) {
    if (source.split(before).length - 1 !== 1) return null
    source = source.replaceAll(before, () => after)
  }
  return source
}
