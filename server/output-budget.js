// dsh reserves both reply tokens and compaction headroom from the context.
// Keep room for conversation and compaction when a model's output limit is large.
export function contextOutputBudget(context) {
  const reserve = 131072
  return Math.max(1, Math.floor(context / 4), context - reserve)
}
