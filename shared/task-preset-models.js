// Existing review settings remain usable only for their original harness.
export function reviewModelChoice(settings, harness) {
  const presets = settings?.taskPresets ?? {}
  const key = harness === 'claude' ? 'reviewClaude' : 'reviewDsh'
  if (presets[key] !== undefined) return presets[key]
  const legacy = presets.review
  if (legacy?.model && legacy.model.startsWith('claude:') === (harness === 'claude')) return legacy
  return { model: null, effort: null }
}
