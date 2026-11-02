// A route is a model explicitly selected by the user, in preference order.
// Claude Code and the Anthropic API are distinct authentication/billing routes.
export function fallbackProvider(model) {
  if (typeof model !== 'string' || model.length > 1000) return null
  // An empty suffix is Claude Code's own default when used as a source.
  if (model.startsWith('claude:')) return 'claude-code'
  try {
    const parsed = JSON.parse(model)
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === 'string' && part.length > 0)) return parsed[0]
  } catch {}
  return null
}

// Do not invent targets or choose another model on the exhausted route. Availability
// and authentication are checked by the caller immediately before starting it.
export function usageFallbackChoice(routes, currentModel) {
  const currentProvider = fallbackProvider(currentModel)
  if (!currentProvider || !Array.isArray(routes)) return null
  return routes.find((route) => {
    const provider = fallbackProvider(route?.model)
    return provider && provider !== currentProvider && typeof route.effort === 'string'
  }) ?? null
}

export function validateUsageFallbackRoutes(routes) {
  if (!Array.isArray(routes) || routes.length > 20) throw new Error('フォールバックは20件以内で指定してください')
  const providers = new Set()
  return routes.map((route) => {
    const provider = fallbackProvider(route?.model)
    if (!provider || route.model === 'claude:' || typeof route.effort !== 'string' || route.effort.length > 100) throw new Error('フォールバックのモデル・推論レベルが不正です')
    if (providers.has(provider)) throw new Error('同じ接続先には1つのフォールバックモデルを選んでください')
    providers.add(provider)
    return { model: route.model, effort: route.effort }
  })
}
