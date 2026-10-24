// Matches the service's available ids against the model definitions dsh can
// serve. Failed or inconsistent responses preserve the last verified list.
import { readJson, writeJson } from './json-file.js'
import { isModelId, readOpenCodeCatalog } from './model-catalog.js'
import { openCodeModels } from './opencode-go-catalog.js'

export const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models'
const MAX_AGE_MS = 6 * 60 * 60 * 1000

/** The chat models of the installed pi-ai `opencode-go` catalog: id → name. */
export async function installedModels(fetched = null) {
  return new Map(openCodeModels(await readOpenCodeCatalog(fetched)).map((model) => [model.id, model.name ?? model.id]))
}

/** The ids of an OpenAI-style `/models` body, or null for an invalid/empty list. */
export function parseModelIds(body) {
  if (!Array.isArray(body?.data) || !body.data.length || body.data.some((entry) => !isModelId(entry?.id))) return null
  return [...new Set(body.data.map((entry) => entry.id))]
}

export class OpenCodeGoModels {
  constructor({ file, fetchImpl = fetch, installed = installedModels, refreshDefinitions = null }) {
    Object.assign(this, { file, fetchImpl, installed, refreshDefinitions })
    this.saved = null
    this.served = null
    this.hidden = []
    this.missing = []
    this.failed = false
    this.queue = Promise.resolve()
  }

  get checkedAt() {
    return this.saved?.fetchedAt ?? null
  }

  async load() {
    const saved = await readJson(this.file, null)
    const ids = parseModelIds({ data: saved?.ids?.map?.((id) => ({ id })) })
    if (ids && Number.isFinite(saved.fetchedAt)) {
      try {
        const resolved = await this.#resolve(ids)
        this.saved = { ids, fetchedAt: saved.fetchedAt }
        Object.assign(this, resolved)
      } catch {
        this.failed = true
      }
    }
    return this
  }

  async #resolve(ids, { refreshDefinitions = false, force = false } = {}) {
    if (refreshDefinitions && this.refreshDefinitions) {
      // Metadata failures must leave the valid live inventory visible as a
      // partial sync, not hide new ids behind a supposedly successful check.
      try { await this.refreshDefinitions(ids, { force }) } catch {}
    }
    const installed = await this.installed()
    const live = new Set(ids)
    const served = [...installed.keys()].filter((id) => live.has(id)).sort()
    if (!served.length) throw new Error('No service models match the supported catalog')
    return {
      served,
      hidden: [...installed].filter(([id]) => !live.has(id)).map(([id, name]) => ({ id, name })),
      missing: ids.filter((id) => !installed.has(id)).sort(),
    }
  }

  /** Refreshes are serialized, including validation and persistence. */
  refresh(key, { maxAgeMs = MAX_AGE_MS } = {}) {
    const task = this.queue.then(async () => {
      if (!key) return false
      const before = JSON.stringify(this.served)
      try {
        // Re-resolve cached ids too: a pi-ai update may have added definitions.
        if (this.saved && !this.failed && Date.now() - this.saved.fetchedAt < maxAgeMs) {
          Object.assign(this, await this.#resolve(this.saved.ids, { refreshDefinitions: true, force: maxAgeMs === 0 }))
          return JSON.stringify(this.served) !== before
        }
        const response = await this.fetchImpl(OPENCODE_GO_MODELS_URL, {
          headers: { authorization: `Bearer ${key}` },
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
        })
        const ids = response.ok ? parseModelIds(await response.json()) : null
        if (!ids) throw new Error('Unreadable model list')
        // Validate before replacing either memory or the persistent last-good list.
        const resolved = await this.#resolve(ids, { refreshDefinitions: true, force: maxAgeMs === 0 })
        const saved = { ids, fetchedAt: Date.now() }
        await writeJson(this.file, saved)
        this.saved = saved
        Object.assign(this, resolved)
        this.failed = false
      } catch {
        this.failed = true
        return false
      }
      return JSON.stringify(this.served) !== before
    })
    this.queue = task.catch(() => false)
    return task
  }
}
