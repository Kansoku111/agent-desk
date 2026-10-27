// AB/eco only. Undefined capabilities are unknown, [] means no selectable level.
const ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const CLAUDE_WORKFLOW_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export function workflowLevels(catalog, model) {
  if (model.startsWith('claude:')) {
    const known = catalog.effortsByModel?.[JSON.stringify(['anthropic', model.slice(7)])]
    return known === undefined ? CLAUDE_WORKFLOW_EFFORTS : known.map(({ value }) => value).filter((value) => CLAUDE_WORKFLOW_EFFORTS.includes(value))
  }
  return catalog.effortsByModel?.[model]?.map(({ value }) => value).filter(Boolean)
}
export function workflowEffort(wanted, levels, modelChanged = false) {
  // Never rewrite a saved explicit choice just by opening a dialog.
  if (wanted && !modelChanged) return wanted
  const target = wanted || 'medium'
  if (levels === undefined) return target
  if (!levels.length) return ''
  if (levels.includes(target)) return target
  const rank = ORDER.indexOf(target)
  const below = levels.filter((value) => ORDER.includes(value) && ORDER.indexOf(value) < rank)
  return below.sort((a, b) => ORDER.indexOf(b) - ORDER.indexOf(a))[0]
    ?? [...levels].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0]
}
export function workflowOptions(wanted, levels) {
  return levels === undefined ? [...new Set(['medium', ...(wanted ? [wanted] : [])])] : levels
}
/** Whether a saved (or empty) effort may start a strict run: unknown capabilities never block. */
export function workflowEffortSupported(effort, levels) {
  return levels === undefined || (effort ? levels.includes(effort) : levels.length === 0)
}
// A fixed workflow choice must be acknowledged exactly; no nearest-level fallback.
export function assertWorkflowEffort(wanted, parsed, label) {
  if (wanted ? !parsed.efforts.some(({ value }) => value === wanted) : parsed.efforts.some(({ value }) => value)) {
    throw new Error(`${label}の推論レベル ${wanted || '指定不可'} はこのモデルで利用できません`)
  }
}
export function assertWorkflowApplied(wanted, parsed, label) {
  if (wanted && parsed.currentEffort !== wanted) throw new Error(`${label}の推論レベル ${wanted} の適用を確認できません`)
}
export function workflowTeamEfforts(config, catalog, leaderModel, providers) {
  if (!leaderModel) config.leader.effort = workflowEffort(config.leader.effort, workflowLevels(catalog, `claude:${config.leader.model}`))
  if (leaderModel) config.gptLeader.effort = workflowEffort(config.gptLeader.effort, workflowLevels(catalog, leaderModel))
  for (const [provider, catalogProvider] of Object.entries(providers)) {
    const tier = config[provider]?.low
    if (!config[provider]?.enabled || !tier?.enabled || !tier.model) continue
    const model = provider === 'claude' ? `claude:${tier.model}` : catalog.models?.find((entry) => entry.provider === catalogProvider && entry.id === tier.model)?.value ?? JSON.stringify([catalogProvider, tier.model])
    tier.effort = workflowEffort(tier.effort, workflowLevels(catalog, model))
  }
}
