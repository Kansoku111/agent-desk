// A data-only overlay for pi-ai's mixed-protocol OpenCode Go catalog. The same
// merge runs in the server and the runtime loader; installed packages stay untouched.
export const OPENCODE_GO_PROVIDER = 'opencode-go'

// pi-ai 1.4.0 still uses the retired free-preview id. The documented Go model
// is minimax-m3.1-flash on the same Chat Completions route. This is an explicit
// correction, not a general rule stripping "-free" from arbitrary model ids.
// https://opencode.ai/v2/docs/console/go/#endpoints
export function canonicalOpenCodeModel(model) {
  if (model?.provider !== OPENCODE_GO_PROVIDER || model.id !== 'minimax-m3.1-flash-free'
    || (model.api !== undefined && model.api !== 'openai-completions') || (model.type ?? 'chat') !== 'chat') return model
  return {
    ...model,
    id: 'minimax-m3.1-flash',
    name: 'MiniMax M3.1 Flash',
    ...(model.cost ? { cost: { input: 0.15, output: 0.60, cacheRead: 0.015, cacheWrite: 0 } } : {}),
  }
}

/** Correct both typed and bare-id package/cache layouts; native definitions win. */
export function canonicalOpenCodeCatalog(groups) {
  const data = structuredClone(groups ?? {})
  for (const group of Object.values(data)) {
    for (const [key, model] of Object.entries(group ?? {})) {
      const corrected = canonicalOpenCodeModel(model)
      if (corrected === model || ![model.id, `chat:${model.id}`].includes(key)) continue
      const native = group[corrected.id] ?? group[`chat:${corrected.id}`]
      delete group[key]
      if (!native) group[key.startsWith('chat:') ? `chat:${corrected.id}` : corrected.id] = corrected
    }
  }
  return data
}

/** Merge data-only additions; later sources win, with no protocol inference. */
export function combineOpenCodeAdditions(...sources) {
  const result = {}
  for (const source of sources) for (const [api, group] of Object.entries(source ?? {})) {
    result[api] = { ...result[api], ...group }
  }
  return result
}

export function openCodeModels(data) {
  return Object.values(data ?? {}).flatMap((group) => Object.values(group ?? {}))
    .filter((model) => (model?.type ?? 'chat') === 'chat' && typeof model?.id === 'string')
}

/** Only new chat definitions of a protocol/endpoint the installed catalog already uses. */
export function mergeOpenCodeCatalog(original, additions) {
  additions = canonicalOpenCodeCatalog(additions)
  const data = structuredClone(original)
  const known = new Set(openCodeModels(data).map((model) => model.id))
  const typed = Object.values(data).some((group) => Object.keys(group).some((key) => key.startsWith('chat:')))
  for (const [api, group] of Object.entries(additions ?? {})) {
    const bases = Object.values(original[api] ?? {})
    if (!bases.length) continue
    const urls = new Set(bases.map((model) => model.baseUrl))
    const fields = new Set(bases.flatMap((model) => Object.keys(model)))
    for (const [id, model] of Object.entries(group ?? {})) {
      if (!model || model.id !== id || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(id) || known.has(id)
        || (model.type ?? 'chat') !== 'chat' || model.provider !== OPENCODE_GO_PROVIDER
        || model.api !== api || !urls.has(model.baseUrl) || typeof model.name !== 'string'
        || !Number.isInteger(model.contextWindow) || model.contextWindow <= 0
        || !Number.isInteger(model.maxTokens) || model.maxTokens <= 0
        || !Array.isArray(model.input) || !model.input.length || model.input.some((value) => !['text', 'image'].includes(value))
        || !model.cost || !Number.isFinite(model.cost.input) || !Number.isFinite(model.cost.output)) continue
      data[api][typed ? `chat:${id}` : id] = {
        ...Object.fromEntries(Object.entries(model).filter(([field]) => fields.has(field))),
        ...(typed ? { type: 'chat' } : {}),
      }
      known.add(id)
    }
  }
  return canonicalOpenCodeCatalog(data)
}
