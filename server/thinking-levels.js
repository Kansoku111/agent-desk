// pi-ai's reading of a model's thinkingLevelMap, shared by every place that
// builds model definitions for dsh. dsh offers exactly these levels and rejects a
// reasoning model for which none remain ("invalid reasoning metadata").
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Same rule as pi-ai's getSupportedThinkingLevels. */
export function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/**
 * pi-ai leaves thinkingLevelMap out for reasoning models without effort control
 * (toggle-only or no options). A map that disables every level would make dsh
 * reject the model instead, so such a map is dropped.
 */
export function withUsableThinkingLevels(model) {
  if (!model?.reasoning || !model.thinkingLevelMap || typeof model.thinkingLevelMap !== 'object') return model
  if (supportedThinkingLevels(model).length) return model
  const { thinkingLevelMap: _, ...rest } = model
  return rest
}
