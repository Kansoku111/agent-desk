// dsh's update_goal accepts empty-string/zero fillers, but its model-facing
// descriptions do not explain them. Models copy a goal's current round cap into
// resume/complete and retry the same rejected arguments. Improve guidance and
// name the offending fields with a corrected call; keep every upstream guard.

const UPDATE_GUIDANCE = 'For update_goal, pause/resume/complete need only goal_id, revision, and action. Do not copy the current objective or round cap into these calls. Omit unused objective, max_goal_rounds, and blocked_reason; if all fields are required, use objective="", max_goal_rounds=0, blocked_reason="". Only edit may replace objective/max_goal_rounds; only blocked uses blocked_reason. After an argument error, correct the named fields instead of repeating the rejected call.'

const ARGUMENT_ERROR = `/** Explain only rejected fields and provide a call using supported empty fillers. */
function goalUpdateArgumentError(args) {
	const invalid = [];
	if (args.action !== "edit") {
		if (hasText(args.objective)) invalid.push("objective");
		if (hasRoundCap(args.max_goal_rounds)) invalid.push("max_goal_rounds");
	}
	if (args.action !== "blocked" && hasText(args.blocked_reason)) invalid.push("blocked_reason");
	const corrected = {
		goal_id: args.goal_id,
		revision: args.revision,
		action: args.action,
		objective: args.action === "edit" ? args.objective ?? "" : "",
		max_goal_rounds: args.action === "edit" ? args.max_goal_rounds ?? 0 : 0,
		blocked_reason: args.action === "blocked" ? args.blocked_reason ?? "<concrete blocking condition>" : ""
	};
	return new HarnessError(
		"update_goal action " + JSON.stringify(args.action) + " does not accept: " + invalid.join(", ") + ". Omit those fields; if all fields are required, use empty strings and max_goal_rounds=0. Retry with: " + JSON.stringify(corrected) + ". Do not repeat the rejected arguments.",
		"GOAL_TOOL_INVALID_UPDATE"
	);
}
`

export function patchGoalToolSource(source) {
  const replacements = [
    ['difficulty, uncertainty, or useful remaining work is not blocked.', `difficulty, uncertainty, or useful remaining work is not blocked. ${UPDATE_GUIDANCE}`],
    ['description: "Update the current goal."', `description: ${JSON.stringify(`Update the current goal. ${UPDATE_GUIDANCE}`)}`],
    ['Replacement objective; valid only with action edit.', 'Replacement objective for edit only. Otherwise omit it, or use an empty string if all fields are required. Do not copy the current objective.'],
    ['Replacement cap; valid only with action edit.', 'Replacement positive safe-integer cap for edit only. Otherwise omit it, or use 0 if all fields are required. Do not copy the current round cap.'],
    ['Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.', 'Required with blocked: the concrete condition that persisted across rounds and blocks progress. Otherwise omit it, or use an empty string if all fields are required.'],
    ['/** Build the exact compare-and-set ref from model arguments. */', `${ARGUMENT_ERROR}/** Build the exact compare-and-set ref from model arguments. */`],
    ['new HarnessError("blocked_reason is valid only with action blocked", "GOAL_TOOL_INVALID_UPDATE")', 'goalUpdateArgumentError(args)', 2],
    ['new HarnessError("objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked", "GOAL_TOOL_INVALID_UPDATE")', 'goalUpdateArgumentError(args)'],
    ['new HarnessError("objective and max_goal_rounds are valid only with action edit", "GOAL_TOOL_INVALID_UPDATE")', 'goalUpdateArgumentError(args)'],
  ]
  for (const [before, after, count = 1] of replacements) {
    if (source.split(before).length - 1 !== count) return null
    source = source.replaceAll(before, () => after)
  }
  return source
}
