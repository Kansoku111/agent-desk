// Pure model-metadata compatibility helpers (historical names retained).
// Official GPT catalog fetching/caching lives in siwc-models.js; this module
// contains no transport or authentication. Codex images/limits are separate.
import { isModelId } from './model-catalog.js'

const contextSize = (value) => Number.isSafeInteger(value) && value > 0 ? value : null

/** The model list reduced to context limits and the fast tier's note, by model id. */
export function parseCodexModels(body) {
  const limits = {}
  for (const model of Array.isArray(body?.models) ? body.models : []) {
    if (typeof model?.slug !== 'string' || !model.slug) continue
    // Codex uses the maximum as its default only when context_window is absent.
    const maxContextWindow = contextSize(model.max_context_window) ?? contextSize(model.context_window)
    const contextWindow = maxContextWindow === null ? null : Math.min(contextSize(model.context_window) ?? maxContextWindow, maxContextWindow)
    const fastTier = Array.isArray(model.service_tiers) ? model.service_tiers.find((tier) => tier?.id === 'priority') : null
    const fast = fastTier ? (typeof fastTier.description === 'string' ? fastTier.description : '') : null
    if (!contextWindow && !maxContextWindow && fast === null) continue
    limits[model.slug] = { contextWindow, maxContextWindow, ...(fast === null ? {} : { fast }) }
  }
  return limits
}

/** "GPT-6.1-Sol" → "GPT-6.1 Sol", the way pi-ai names its GPT models. */
export function modelDisplayName(model) {
  const name = typeof model?.display_name === 'string' && model.display_name.trim() ? model.display_name.trim() : model.slug
  const gpt = /^(GPT-[\d.]+)-(.+)$/.exec(name)
  return gpt ? `${gpt[1]} ${gpt[2].replaceAll('-', ' ')}` : name
}

/**
 * Which models the account's list offers. `offered` are the ones Codex shows
 * in its picker (`visibility: "list"`), best first; `known` also holds the
 * hidden ones, which still work (internal helpers, models being phased in).
 * @returns {{ offered: { id: string, name: string }[], known: string[] }}
 */
export function parseCodexAvailability(body) {
  const offered = []
  const known = []
  for (const model of Array.isArray(body?.models) ? body.models : []) {
    if (typeof model?.slug !== 'string' || !isModelId(model.slug)) continue
    known.push(model.slug)
    if (model.visibility === 'list') offered.push({ id: model.slug, name: modelDisplayName(model) })
  }
  return { offered, known }
}

const hasModels = (availability) => availability.offered.length > 0

/**
 * The catalog's ChatGPT models the account's list no longer has: retired.
 * Nothing is reported while the list is unknown, so a failed fetch never marks
 * a working model.
 */
export function retiredModels(models, availability) {
  if (!availability || !hasModels(availability)) return []
  const known = new Set(availability.known)
  return (models ?? [])
    .filter((model) => model.provider === 'openai-codex' && !known.has(model.id))
    .map(({ provider, id, name, value }) => ({ provider, id, name, value }))
}

/** The catalog snapshot with `retired: true` on retired models (and untouched while `enabled` is false). */
export function markRetired(snapshot, availability, enabled = true) {
  if (!enabled) return snapshot
  const retired = new Set(retiredModels(snapshot?.models, availability).map((model) => model.value))
  if (!retired.size) return snapshot
  return { ...snapshot, models: snapshot.models.map((model) => (retired.has(model.value) ? { ...model, retired: true } : model)) }
}

/**
 * Models the account's list offers that the catalog may lack, as additions
 * for model-catalog.js: each is cloned from the best offered model the catalog
 * already has (the list is ordered best first).
 */
export function accountModelAdditions(availability) {
  if (!availability || !hasModels(availability)) return []
  const templates = availability.offered.map((model) => model.id)
  return availability.offered.map((model) => ({
    provider: 'openai-codex', id: model.id, name: model.name, templates, source: 'account',
  }))
}

export function withCodexModelLimits(models, codexLimits = {}) {
  const codex = { ...models?.['openai-codex'] }
  for (const [id, model] of Object.entries(codex)) {
    const backend = codexLimits?.[id]
    const reportedDefault = contextSize(backend?.contextWindow) ?? contextSize(backend?.maxContextWindow)
    if (reportedDefault === null) continue
    const maxContextWindow = contextSize(backend?.maxContextWindow) ?? reportedDefault
    codex[id] = {
      ...model,
      defaultContextWindow: Math.min(reportedDefault, maxContextWindow),
      maxContextWindow,
    }
  }
  return { ...models, 'openai-codex': codex }
}
