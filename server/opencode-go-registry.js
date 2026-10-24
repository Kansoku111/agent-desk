// Supplement missing Go definitions from OpenCode's structured catalog. Live
// availability remains authoritative; never infer ids from names or execute
// registry content. Requests to this public catalog never carry the Go key.
import { readJson, writeJson } from './json-file.js'
import { isModelId } from './model-catalog.js'
import { mergeOpenCodeCatalog, openCodeModels } from './opencode-go-catalog.js'

export const OPENCODE_GO_REGISTRY_URL = 'https://models.opencode.ai/api.json'
const MAX_BYTES = 16 * 1024 * 1024
const MAX_AGE_MS = 6 * 60 * 60 * 1000
const RETRY_MS = 60_000
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
// Map explicitly documented SDK/endpoint pairs onto routes the installed pi-ai
// already speaks. The registry is not allowed to introduce any new destination.
const ROUTES = {
  '@ai-sdk/openai-compatible': ['openai-completions', 'https://opencode.ai/inference/go/openai/v1', 'https://opencode.ai/inference/go/v1'],
  '@ai-sdk/openai': ['openai-responses', 'https://opencode.ai/inference/go/openai/v1', 'https://opencode.ai/inference/go/v1'],
  '@ai-sdk/anthropic': ['anthropic-messages', 'https://opencode.ai/inference/go/anthropic/v1', 'https://opencode.ai/inference/go'],
  '@ai-sdk/google': ['google-generative-ai', 'https://opencode.ai/inference/go/google/v1beta', 'https://opencode.ai/inference/go/v1'],
}

const positive = (value) => Number.isSafeInteger(value) && value > 0
const price = (value) => Number.isFinite(value) && value >= 0

/** Keep only compatibility switches common to every installed model on a route. */
function commonCompat(bases) {
  const first = bases[0]?.compat ?? {}
  return Object.fromEntries(Object.entries(first).filter(([key, value]) =>
    bases.every((model) => JSON.stringify(model.compat?.[key]) === JSON.stringify(value))))
}

/** Converts only exact live ids with sufficient metadata and a supported route. */
export function registryDefinitions(body, liveIds, base) {
  const provider = body?.['opencode-go']
  if (provider?.id !== 'opencode-go' || !provider.models || typeof provider.models !== 'object' || Array.isArray(provider.models)) {
    throw new Error('OpenCode model registry has no Go catalog')
  }
  const known = new Set(openCodeModels(base).map((model) => model.id))
  const groups = {}
  for (const id of liveIds) {
    const model = provider.models[id]
    if (!isModelId(id) || known.has(id) || !model || model.id !== id || (model.type ?? 'chat') !== 'chat'
      || model.status === 'deprecated' || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 200
      || model.tool_call !== true || typeof model.reasoning !== 'boolean'
      || (model.reasoning_options !== undefined && !Array.isArray(model.reasoning_options))
      || !positive(model.limit?.context) || !positive(model.limit?.output) || model.limit.output > model.limit.context
      || !Array.isArray(model.modalities?.input) || !model.modalities.input.includes('text')
      || !Array.isArray(model.modalities?.output) || !model.modalities.output.includes('text')
      || !price(model.cost?.input) || !price(model.cost?.output)
      || (model.cost.cache_read !== undefined && !price(model.cost.cache_read))
      || (model.cost.cache_write !== undefined && !price(model.cost.cache_write))) continue
    const sdk = model.provider?.npm ?? provider.npm
    const route = Object.hasOwn(ROUTES, sdk) ? ROUTES[sdk] : null
    if (!route || (model.provider?.api ?? provider.api) !== route[1]) continue
    const [api, , baseUrl] = route
    const bases = Object.values(base[api] ?? {}).filter((entry) => entry.provider === 'opencode-go' && entry.baseUrl === baseUrl)
    if (!bases.length) continue
    const thinkingLevelMap = Object.fromEntries(LEVELS.map((level) => [level, null]))
    for (const option of model.reasoning_options ?? []) {
      if (option?.type !== 'effort' || !Array.isArray(option.values)) continue
      for (const wire of option.values) {
        const level = wire === 'none' ? 'off' : wire
        if (LEVELS.includes(level)) thinkingLevelMap[level] = wire
      }
    }
    const compat = commonCompat(bases)
    if (api === 'openai-completions') {
      compat.supportsStore = false
      compat.supportsDeveloperRole = false
      compat.maxTokensField = 'max_tokens'
      compat.supportsStrictMode = model.structured_output === true
    }
    // No arbitrary descriptions, instructions, headers, URLs or SDK code are copied.
    const definition = {
      id, name: model.name, provider: 'opencode-go', api, baseUrl,
      input: ['text', ...(model.modalities.input.includes('image') ? ['image'] : [])],
      reasoning: model.reasoning, thinkingLevelMap,
      contextWindow: model.limit.context, maxTokens: model.limit.output,
      cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cache_read ?? 0, cacheWrite: model.cost.cache_write ?? 0 },
      ...(Object.keys(compat).length ? { compat } : {}),
    }
    groups[api] ??= {}
    groups[api][id] = definition
  }
  return groups
}

/** A data cache must pass the same route/shape gate as the runtime overlay. */
function supportedGroups(base, groups) {
  const known = new Set(openCodeModels(base).map((model) => model.id))
  const result = {}
  for (const model of openCodeModels(mergeOpenCodeCatalog(base, groups))) {
    if (known.has(model.id)) continue
    result[model.api] ??= {}
    result[model.api][model.id] = model
  }
  return result
}

async function registryBody(response) {
  if (!response.ok) throw new Error(`OpenCode registry HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('OpenCode registry is too large')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('OpenCode registry has no body')
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error('OpenCode registry is too large')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export class OpenCodeGoRegistry {
  constructor({ file, base, fetchImpl = fetch }) {
    Object.assign(this, { file, base, fetchImpl })
    this.groups = {}
    this.checkedAt = null
    this.failed = false
    this.lastAdded = null
    this.requested = []
    this.lastAttempt = 0
    this.lastInventory = ''
    this.queue = Promise.resolve()
  }

  async load() {
    const saved = await readJson(this.file, null)
    if (saved?.groups && Number.isFinite(saved.checkedAt)) {
      this.groups = supportedGroups(await this.base(), saved.groups)
      this.checkedAt = saved.checkedAt
      this.requested = Array.isArray(saved.requested) ? saved.requested.filter(isModelId) : []
      this.lastAdded = saved.lastAdded ?? null
    }
    return this
  }

  /** Fills definition gaps without awaiting a pi-ai release; failed reads retain the cache. */
  refresh(liveIds, { force = false } = {}) {
    const task = this.queue.then(async () => {
      const base = await this.base()
      const known = new Set(openCodeModels(base).map((model) => model.id))
      const needed = [...new Set(liveIds)].filter((id) => isModelId(id) && !known.has(id)).sort()
      if (!needed.length) {
        this.failed = false
        return false
      }
      const inventory = JSON.stringify(needed)
      if (!force && inventory === this.lastInventory && Date.now() - this.lastAttempt < RETRY_MS) return false
      if (!force && !this.failed && this.checkedAt && Date.now() - this.checkedAt < MAX_AGE_MS
        && needed.every((id) => this.requested.includes(id))) return false
      this.lastAttempt = Date.now()
      this.lastInventory = inventory
      try {
        const response = await this.fetchImpl(OPENCODE_GO_REGISTRY_URL, {
          redirect: 'error', signal: AbortSignal.timeout(12_000),
        })
        const fresh = registryDefinitions(await registryBody(response), liveIds, base)
        const combined = {}
        for (const source of [this.groups, fresh]) for (const [api, group] of Object.entries(source)) {
          combined[api] = { ...combined[api], ...group }
        }
        const groups = supportedGroups(base, combined)
        const before = new Set(openCodeModels(this.groups).map((model) => model.id))
        const models = openCodeModels(groups).filter((model) => !before.has(model.id))
          .map(({ id, name }) => ({ provider: 'opencode-go', id, name }))
        const checkedAt = Date.now()
        const lastAdded = models.length ? { at: checkedAt, source: 'OpenCode', models } : this.lastAdded
        await writeJson(this.file, { groups, checkedAt, requested: needed, lastAdded })
        const changed = JSON.stringify(groups) !== JSON.stringify(this.groups)
        Object.assign(this, { groups, checkedAt, requested: needed, lastAdded, failed: false })
        return changed
      } catch {
        this.failed = true
        return false
      }
    })
    this.queue = task.catch(() => false)
    return task
  }
}
