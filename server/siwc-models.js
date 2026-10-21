import { readJson, writeJson } from './json-file.js'
import { SiwcClient } from './siwc-client.js'
import { SIWC_RECORD } from './credentials.js'
import { isModelId } from './model-catalog.js'
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export function siwcModelDefinitions(models) {
  // Only capability metadata is consumed. Never copy model_messages/Codex instructions from the service catalog.
  return models.filter(model => model.visibility === 'list' && isModelId(model.slug)).map(model => {
    const efforts = (model.supported_reasoning_levels ?? [])
      .map(entry => entry.effort)
      .filter(effort => LEVELS.includes(effort) && !['off', 'minimal'].includes(effort))
    const supported = efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh']
    return {
      id: model.slug,
      name: model.display_name ?? model.slug,
      contextWindow: Number.isSafeInteger(model.context_window) && model.context_window > 0 ? model.context_window : 272000,
      maxTokens: 32768,
      input: (model.input_modalities ?? ['text', 'image']).filter(value => ['text', 'image'].includes(value)),
      reasoningEfforts: Object.fromEntries(LEVELS.filter(level => supported.includes(level)).map(level => [level, level]))
    }
  })
}
export class SiwcModelCatalog {
  constructor(file) {
    this.file = file
    this.definitions = []
    this.limits = {}
    this.availability = {
      offered: [],
      known: []
    }
    this.status = null
    this.checkedAt = null
    this.queue = Promise.resolve()
  }
  async load() {
    const saved = await readJson(this.file, {})
    this.definitions = saved.definitions ?? []
    this.ceilings = saved.ceilings ?? {}
    this.identity = saved.identity
    this.apply()
    this.checkedAt = saved.fetchedAt ?? null
    return this
  }
  apply() {
    this.limits = Object.fromEntries(this.definitions.map(model => [model.id, {
      contextWindow: model.contextWindow,
      maxContextWindow: Math.max(model.contextWindow, this.ceilings?.[model.id] ?? model.contextWindow)
    }]))
    this.availability = {
      offered: this.definitions.map(model => ({
        id: model.id,
        name: model.name
      })),
      known: this.definitions.map(model => model.id)
    }
  }
  refresh(store) {
    const task = this.queue.then(async () => {
      const before = (await store.read()).records?.[SIWC_RECORD]?.payload
      const identity = before?.subject ? `${before.client_id}:${before.subject}` : null
      if (!identity || identity !== this.identity) {
        this.definitions = []
        this.ceilings = {}
        this.apply()
      }
      if (!before?.access_token) {
        this.status = 'signed-out'
        return false
      }
      try {
        const offered = await new SiwcClient(store).models()
        const definitions = siwcModelDefinitions(offered)
        const ceilings = Object.fromEntries(offered
          .filter(model => isModelId(model.slug)
            && Number.isSafeInteger(model.max_context_window) && model.max_context_window > 0)
          .map(model => [model.slug, model.max_context_window]))
        const after = (await store.read()).records?.[SIWC_RECORD]?.payload
        if (`${after?.client_id}:${after?.subject}` !== identity) return false
        const changed = JSON.stringify(this.definitions) !== JSON.stringify(definitions)
          || JSON.stringify(this.ceilings ?? {}) !== JSON.stringify(ceilings)
        this.definitions = definitions
        this.ceilings = ceilings
        this.identity = identity
        this.apply()
        this.status = 'ok'
        this.checkedAt = Date.now()
        await writeJson(this.file, {
          identity,
          definitions,
          ceilings,
          fetchedAt: this.checkedAt
        })
        return changed
      } catch {
        this.status = 'error'
        return false
      }
    })
    this.queue = task.catch(() => false)
    return task
  }
}
