// Public API equivalents supplement missing GPT prices, never metered bills.
import { readJson, writeJson } from './json-file.js'
import { isModelId } from './model-catalog.js'
import { MODEL_REGISTRY_URL } from './model-registry.js'
import { catalogRates, publicTextRates } from './pricing-rates.js'

const MAX_AGE_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 0

/** Only exact first-party OpenAI ids are meaningful for the ChatGPT equivalent. */
export function publicEquivalentRates(body) {
  const provider = body?.openai
  if (provider?.id !== 'openai' || !provider.models || typeof provider.models !== 'object' || Array.isArray(provider.models)) {
    throw new Error('Model registry has no OpenAI catalog')
  }
  const result = {}
  for (const [id, model] of Object.entries(provider.models)) {
    if (!isModelId(id) || model?.id !== id || (model.type ?? 'chat') !== 'chat') continue
    const rates = publicTextRates(model.cost)
    if (rates) result['openai-codex/' + id] = rates
  }
  if (!Object.keys(result).length) throw new Error('Model registry has no usable OpenAI prices')
  return result
}

/** Persist last-good validated prices and refresh without blocking a model turn. */
export class EquivalentPricing {
  constructor({ file, registry, enabled = () => true, onChange = () => {}, now = Date.now, log = () => {} }) {
    Object.assign(this, { file, registry, enabled, onChange, now, log })
    this.entries = {}
    this.checkedAt = null
    this.failed = false
    this.pending = null
    this.timer = null
    this.stopped = false
  }

  get rates() {
    return this.enabled() ? Object.fromEntries(Object.entries(this.entries).map(([key, entry]) => [key, entry.rates])) : {}
  }

  async load() {
    const saved = await readJson(this.file, null)
    if (saved?.version === 1 && saved.entries && typeof saved.entries === 'object' && !Array.isArray(saved.entries)) {
      for (const [key, entry] of Object.entries(saved.entries)) {
        const id = key.startsWith('openai-codex/') ? key.slice('openai-codex/'.length) : null
        const rates = catalogRates(entry?.rates)
        if (isModelId(id) && rates && entry.source === MODEL_REGISTRY_URL && Number.isFinite(entry.checkedAt)) {
          this.entries[key] = { rates, source: MODEL_REGISTRY_URL, checkedAt: entry.checkedAt }
        }
      }
      if (Object.keys(this.entries).length && Number.isFinite(saved.checkedAt)) this.checkedAt = saved.checkedAt
    }
    return this
  }

  refresh({ force = false } = {}) {
    if (this.stopped || !this.enabled()) return Promise.resolve(false)
    if (this.pending) return this.pending
    if (!force && this.checkedAt !== null && this.now() - this.checkedAt < MAX_AGE_MS) return Promise.resolve(false)
    const work = (async () => {
      try {
        const incoming = publicEquivalentRates(await this.registry.get({ force }))
        if (this.stopped) return false
        const checkedAt = this.now()
        const entries = { ...this.entries }
        for (const [key, rates] of Object.entries(incoming)) entries[key] = { rates, source: MODEL_REGISTRY_URL, checkedAt }
        await writeJson(this.file, { version: 1, checkedAt, entries })
        const changed = JSON.stringify(this.rates) !== JSON.stringify(this.enabled()
          ? Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.rates])) : {})
        this.entries = entries
        this.checkedAt = checkedAt
        this.failed = false
        if (changed && this.enabled()) this.onChange(this.rates)
        return changed
      } catch (error) {
        this.failed = true
        this.log('could not refresh equivalent prices:', error.message)
        return false
      }
    })()
    this.pending = work
    void work.finally(() => { if (this.pending === work) this.pending = null }).catch(() => {})
    return work
  }

  start() {
    const schedule = (delay) => {
      this.timer = setTimeout(() => { void this.refresh(); schedule(MAX_AGE_MS) }, delay)
      this.timer.unref?.()
    }
    schedule(FIRST_CHECK_MS)
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    await this.pending
  }
}
