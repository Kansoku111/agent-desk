// Wire identity for every GPT catalog/config source, including old caches.
export const SIWC_API = 'openai-responses'
export const SIWC_BASE_URL = 'https://api.openai.com/v1'
export const GPT_PROVIDER = 'openai-codex'

/** Repoint metadata to SIWC without importing instructions or authentication. */
export function siwcCatalog(data) {
  const models = {}
  for (const group of Object.values(data ?? {})) {
    for (const [key, model] of Object.entries(group ?? {})) {
      if (!model || (model.type ?? 'chat') !== 'chat') continue
      const next = structuredClone(model)
      next.api = SIWC_API
      next.baseUrl = SIWC_BASE_URL
      next.provider = GPT_PROVIDER
      if (next.headers) {
        for (const name of Object.keys(next.headers)) {
          if (/^(authorization|originator|chatgpt-account-id|openai-beta)$/i.test(name)) {
            delete next.headers[name]
          }
        }
      }
      models[key] = next
    }
  }
  return {
    [SIWC_API]: models
  }
}
