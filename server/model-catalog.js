// Keeps the model catalog dsh serves current between dsh releases.
//
// dsh reads its model list from the pi-ai package it bundles
// (`dist/providers/data/<provider>.json`). New models land in newer pi-ai
// releases first, and dsh pins pi-ai to a major version it was built against.
// Agent Desk therefore adds the missing entries to that catalog before any dsh
// process starts: definitions copied from a newer pi-ai release
// (`catalog-extras.json`), definitions read from the newest pi-ai release on
// npm (model-updates.js), plus models the user registers in settings by
// cloning an existing model's definition. Each added entry carries a marker so
// the next pass can remove it again, which keeps the edit idempotent and lets
// a removed custom model disappear.
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import extras from './catalog-extras.json' with { type: 'json' }
import { GPT_PROVIDER, siwcCatalog } from './siwc-route.js'

const MARKER = 'agentDeskAdded'

/** The pi-ai release the bundled definitions were copied from. */
export const BUNDLED_SOURCE = /@([^@]+)$/.exec(extras.source ?? '')?.[1] ?? null

/** Providers whose models come from the pi-ai catalog and can take custom models. */
export const CUSTOM_MODEL_PROVIDERS = ['openai-codex', 'anthropic']

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i

export function isModelId(value) {
  return typeof value === 'string' && MODEL_ID.test(value)
}

/** The pi-ai catalog data directories dsh may load (hoisted and nested copies). */
export function catalogDataDirs() {
  const dirs = new Set()
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules')
  for (const owner of ['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh']) {
    const nested = path.join(root, owner, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
    if (existsSync(nested)) dirs.add(nested)
  }
  // Prefer the engine's nested pi-ai over the older copy used by the app's
  // OAuth and retry helpers when reading limits and custom-model templates.
  try {
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/providers/all'))
    dirs.add(path.join(path.dirname(entry), 'data'))
  } catch {}
  return [...dirs]
}

/**
 * pi-ai 0.x uses bare ids; 1.x uses `<type>:<id>` keys. Validate the key
 * against the model rather than treating unrelated entries as chat models.
 */
function knownLayout(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  return Object.values(data).every((group) => group && typeof group === 'object'
    && !Array.isArray(group) && Object.entries(group).every(([key, model]) => model
      && (key === model.id || (typeof model.type === 'string' && key === `${model.type}:${model.id}`))))
}

function findModel(data, id) {
  for (const [api, group] of Object.entries(data)) {
    const model = group[id] ?? group[`chat:${id}`]
    if (model && (model.type ?? 'chat') === 'chat') return { api, model }
  }
  return null
}

/** Read chat models under bare ids for the app, preserving the file's layout. */
function chatCatalog(data) {
  return Object.fromEntries(Object.entries(data).map(([api, group]) => [api,
    Object.fromEntries(Object.values(group).filter((model) => (model.type ?? 'chat') === 'chat')
      .map((model) => [model.id, model])),
  ]))
}

/** Definitions to add, by model id: a fetched (newer) one wins over the bundled one. */
function additionsFor(provider, fetched) {
  const additions = new Map()
  const sources = [['bundled', extras.providers[provider]], ['fetched', fetched?.providers?.[provider]]]
  for (const [source, groups] of sources) {
    const routed = provider === GPT_PROVIDER ? siwcCatalog(groups) : groups
    for (const [api, group] of Object.entries(routed ?? {})) {
      for (const [id, model] of Object.entries(group ?? {})) additions.set(id, { api, model, source })
    }
  }
  return additions
}

/**
 * Applies bundled, fetched and custom models to one provider's catalog data.
 * @param {{ providers: object } | null} fetched  definitions kept by model-updates.js
 * @returns {{ data: object, added: string[], models: { id: string, name: string, source: string }[], skipped: { id: string, reason: string }[] }}
 */
export function applyCatalogAdditions(original, provider, customModels = [], fetched = null) {
  const data = provider === GPT_PROVIDER ? siwcCatalog(original) : structuredClone(original)
  const typed = Object.values(data).some((group) => Object.keys(group).some((key) => key.includes(':')))
  const keyFor = (id) => typed ? `chat:${id}` : id
  for (const group of Object.values(data)) {
    for (const [id, model] of Object.entries(group)) if (model?.[MARKER]) delete group[id]
  }
  const added = []
  const models = []
  const skipped = []
  for (const [id, { api, model, source }] of additionsFor(provider, fetched)) {
    if (findModel(data, id)) continue
    data[api] ??= {}
    data[api][keyFor(id)] = { ...model, ...(typed ? { type: 'chat' } : {}), [MARKER]: source }
    added.push(id)
    models.push({ id, name: model.name ?? id, source })
  }
  for (const custom of customModels.filter((entry) => entry.provider === provider)) {
    // Models the account's own model list offers (see codex-models.js): quiet
    // when the catalog has them, and cloned from the best model it does have.
    const account = custom.source === 'account'
    if (findModel(data, custom.id)) {
      if (!account) skipped.push({ id: custom.id, reason: 'exists' })
      continue
    }
    const template = [custom.template, ...(custom.templates ?? [])]
      .map((id) => (typeof id === 'string' ? findModel(data, id) : null))
      .find(Boolean)
    if (!template) {
      if (!account) skipped.push({ id: custom.id, reason: 'template-missing' })
      continue
    }
    const source = account ? 'account' : 'custom'
    data[template.api][keyFor(custom.id)] = {
      ...structuredClone(template.model),
      id: custom.id,
      name: custom.name || custom.id,
      [MARKER]: source,
    }
    added.push(custom.id)
    if (account) models.push({ id: custom.id, name: custom.name || custom.id, source })
  }
  return { data, added, models, skipped }
}

/**
 * Brings every pi-ai catalog copy up to date.
 * @param {{ provider: string, id: string, template?: string, templates?: string[], name?: string, source?: 'account' }[]} customModels
 *   `source: 'account'` entries come from the account's model list and pick the first of `templates` the catalog has.
 * @param {{ providers: object } | null} fetched  definitions kept by model-updates.js
 * @returns {Promise<{ changed: boolean, added: string[], models: object[], skipped: object[], warnings: string[] }>}
 *   `models`: the bundled and fetched models Agent Desk adds, with their provider.
 */
export async function ensureModelCatalog(customModels = [], fetched = null) {
  return configuredModelCatalog(customModels, fetched)
}

/**
 * The installed catalog as pi-ai shipped it (Agent Desk's additions left out),
 * by provider, and every model field the installed pi-ai uses.
 */
export async function shippedCatalog() {
  const [dir] = catalogDataDirs()
  const providers = {}
  const keys = new Set()
  for (const name of dir ? await fs.readdir(dir).catch(() => []) : []) {
    if (!name.endsWith('.json')) continue
    let data
    try {
      data = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (!knownLayout(data)) continue
    data = chatCatalog(data)
    for (const group of Object.values(data)) {
      for (const [id, model] of Object.entries(group)) {
        if (model[MARKER]) delete group[id]
        else for (const key of Object.keys(model)) keys.add(key)
      }
    }
    const provider = name.slice(0, -'.json'.length)
    if (CUSTOM_MODEL_PROVIDERS.includes(provider)) {
      providers[provider] = provider === GPT_PROVIDER ? siwcCatalog(data) : data
    }
  }
  return { providers, keys }
}

/** Context window and reply budget of every catalog model, by provider and id. */
export async function catalogModelLimits() {
  const [dir] = catalogDataDirs()
  const result = {}
  for (const provider of CUSTOM_MODEL_PROVIDERS) {
    result[provider] = {}
    try {
      const data = chatCatalog(JSON.parse(await fs.readFile(path.join(dir, `${provider}.json`), 'utf8')))
      for (const group of Object.values(data)) {
        for (const [id, model] of Object.entries(group)) {
          if (Number.isInteger(model?.contextWindow) && Number.isInteger(model?.maxTokens)) {
            result[provider][id] = { contextWindow: model.contextWindow, maxTokens: model.maxTokens }
          }
        }
      }
    } catch {}
  }
  return result
}

// Materialize additions into the app-owned DSH configuration, never mutate installed packages.
export async function configuredModelCatalog(customModels = [], fetched = null) {
  const [dir] = catalogDataDirs()
  const definitions = {}
  const added = []
  const models = []
  const skipped = []
  const warnings = []
  for (const provider of CUSTOM_MODEL_PROVIDERS) {
    if (!dir) continue
    const original = JSON.parse(await fs.readFile(path.join(dir, `${provider}.json`), 'utf8'))
    if (!knownLayout(original)) throw new Error(`Unsupported model catalog layout: ${provider}`)
    const result = applyCatalogAdditions(original, provider, customModels, fetched)
    definitions[provider] = Object.values(result.data)
      .flatMap(group => Object.values(group))
      .filter(model => (model.type ?? 'chat') === 'chat')
      .map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        reasoningEfforts: model.reasoning
          ? Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max']
            .map(level => [level, model.thinkingLevelMap?.[level] ?? (level === 'max' ? null : level)])
            .filter(([, wire]) => wire !== null))
          : false,
      }))
    added.push(...result.added.map(id => `${provider}/${id}`))
    models.push(...result.models.map(model => ({ provider, ...model })))
    skipped.push(...result.skipped.map(entry => ({ provider, ...entry })))
  }
  return { changed: false, definitions, added, models, skipped, warnings }
}
