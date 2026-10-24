// A data-only overlay for pi-ai's mixed-protocol OpenCode Go catalog. The same
// merge runs in the server and the runtime loader; installed packages stay untouched.
export const OPENCODE_GO_PROVIDER = 'opencode-go'

export function openCodeModels(data) {
  return Object.values(data ?? {}).flatMap((group) => Object.values(group ?? {}))
    .filter((model) => (model?.type ?? 'chat') === 'chat' && typeof model?.id === 'string')
}

/** Only new chat definitions of a protocol/endpoint the installed catalog already uses. */
export function mergeOpenCodeCatalog(original, additions) {
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
  return data
}
