// The model catalog the composer shows before a thread has a live session.
// It is learned from ACP session config options and cached on disk.
import { readJson, writeJson } from './json-file.js'
import { parseConfigOptions } from './transcript.js'

export const PROVIDER_LABELS = {
  'openai-codex': 'ChatGPT',
  anthropic: 'Claude',
  'deepseek-official': 'DeepSeek',
}

const FALLBACK_EFFORTS = [
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
]

// A runtime can finish learning options it fetched before the catalog signature
// changed (for example, while a DeepSeek key is being saved). Such a snapshot
// must not make that new signature look current.
function matchesSignature(signature, models) {
  let requirements
  try {
    requirements = JSON.parse(signature)
  } catch {
    return true
  }
  if (!requirements || typeof requirements !== 'object') return true
  return typeof requirements.deepseek !== 'boolean'
    || models.some((model) => model.provider === 'deepseek-official') === requirements.deepseek
}

export class Catalog {
  /**
   * @param file - the cache file.
   * @param signature - what the served catalog depends on (dsh version and
   *   the models Agent Desk adds); a cache learned under another one is stale.
   */
  constructor(file, signature = null) {
    this.file = file
    this.signature = signature
    this.data = { models: [], effortsByModel: {}, updatedAt: null, signature: null }
  }

  async load() {
    this.data = await readJson(this.file, this.data)
    this.data.models ??= []
    this.data.effortsByModel ??= {}
    return this
  }

  get empty() {
    return this.data.models.length === 0
  }

  get stale() {
    return this.empty || this.data.signature !== this.signature
  }

  /** Marks the cache stale after the served catalog changed. */
  setSignature(signature) {
    this.signature = signature
  }

  /** Learns from one config-options snapshot; returns true when something changed. */
  learn(configOptions) {
    const parsed = parseConfigOptions(configOptions)
    let changed = false
    const models = parsed.models.filter((model) => PROVIDER_LABELS[model.provider])
    const current = models.length > 0 && matchesSignature(this.signature, models)
    if (models.length && JSON.stringify(models) !== JSON.stringify(this.data.models)) {
      this.data.models = models
      changed = true
    }
    if (current && this.data.signature !== this.signature) {
      this.data.signature = this.signature
      changed = true
    }
    if (parsed.currentModel && parsed.efforts.length) {
      const before = JSON.stringify(this.data.effortsByModel[parsed.currentModel] ?? null)
      if (before !== JSON.stringify(parsed.efforts)) {
        this.data.effortsByModel[parsed.currentModel] = parsed.efforts
        changed = true
      }
    }
    if (changed) {
      this.data.updatedAt = Date.now()
      void writeJson(this.file, this.data).catch(() => {})
    }
    return changed
  }

  snapshot() {
    return {
      providers: PROVIDER_LABELS,
      models: this.data.models,
      effortsByModel: this.data.effortsByModel,
      fallbackEfforts: FALLBACK_EFFORTS,
    }
  }
}
