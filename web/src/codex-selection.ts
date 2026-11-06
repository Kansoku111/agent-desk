import type { CodexModel } from './types'

export interface CodexChoice { model: string; effort: string | null }

/** Keep a compatible level; otherwise use the selected model's advertised default. */
export function codexChoice(models: CodexModel[], modelId: string | null, effort: string | null): CodexChoice | null {
  const model = models.find((entry) => entry.id === modelId)
  if (!model) return null
  const selected = effort && model.efforts.includes(effort) ? effort
    : model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort
      : model.efforts[0] ?? null
  return { model: model.id, effort: selected }
}
