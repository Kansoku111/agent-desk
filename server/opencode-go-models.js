// Keeps the OpenCode Go model list in line with what OpenCode serves.
//
// The models come from the pi-ai catalog dsh bundles, which is a snapshot: it
// can still offer models OpenCode has since withdrawn (experimental codenames,
// renamed previews). While a key is saved, the ids the service lists at
// `/v1/models` are read and the picker is narrowed to the catalog models among
// them. Models the catalog lacks cannot be added here: a route's wire protocol
// comes from the catalog entry, so they arrive with a newer pi-ai.
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJson } from './json-file.js'
import { catalogDataDirs, isModelId } from './model-catalog.js'

export const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models'

const MAX_AGE_MS = 6 * 60 * 60 * 1000

/** The chat models of the installed pi-ai `opencode-go` catalog (both key layouts): id → name. */
export async function installedModels() {
  const [dir] = catalogDataDirs()
  const models = new Map()
  if (!dir) return models
  try {
    const data = JSON.parse(await fs.readFile(path.join(dir, 'opencode-go.json'), 'utf8'))
    for (const group of Object.values(data)) {
      for (const model of Object.values(group ?? {})) {
        if ((model?.type ?? 'chat') === 'chat' && typeof model?.id === 'string') models.set(model.id, model.name ?? model.id)
      }
    }
  } catch {}
  return models
}

/** The ids of an OpenAI-style `/models` body, or null when it does not look like one. */
export function parseModelIds(body) {
  if (!Array.isArray(body?.data)) return null
  const ids = body.data.map((entry) => entry?.id).filter(isModelId)
  return ids.length ? [...new Set(ids)] : null
}

export class OpenCodeGoModels {
  /**
   * @param {object} options
   * @param {string} options.file - where the last list is kept
   * @param {typeof fetch} [options.fetchImpl]
   * @param {() => Promise<Map<string, string>>} [options.installed] - the models the catalog can serve
   */
  constructor({ file, fetchImpl = fetch, installed = installedModels }) {
    Object.assign(this, { file, fetchImpl, installed })
    /** @type {{ ids: string[], fetchedAt: number } | null} */
    this.saved = null
    /** Catalog models among the live ones; null serves the whole catalog. */
    this.served = null
    /** Catalog models the service no longer lists. */
    this.hidden = []
    /** Whether the last read failed (the previous list is still used). */
    this.failed = false
  }

  get checkedAt() {
    return this.saved?.fetchedAt ?? null
  }

  async load() {
    const saved = await readJson(this.file, null)
    if (Array.isArray(saved?.ids) && Number.isFinite(saved.fetchedAt)) this.saved = saved
    await this.#resolve()
    return this
  }

  async #resolve() {
    const live = this.saved?.ids
    const installed = live ? await this.installed() : new Map()
    const served = [...installed.keys()].filter((id) => live?.includes(id))
    // A list that shares nothing with the catalog is a sign of a bad reply, not of an empty service.
    this.served = served.length ? served.sort() : null
    this.hidden = this.served ? [...installed].filter(([id]) => !live.includes(id)).map(([id, name]) => ({ id, name })) : []
  }

  /**
   * Reads the live list with the saved key; true when the served models changed.
   * A failed read keeps the previous list.
   */
  async refresh(key, { maxAgeMs = MAX_AGE_MS } = {}) {
    if (!key || (this.saved && Date.now() - this.saved.fetchedAt < maxAgeMs)) return false
    const before = JSON.stringify(this.served)
    try {
      const response = await this.fetchImpl(OPENCODE_GO_MODELS_URL, {
        headers: { authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      })
      const ids = response.ok ? parseModelIds(await response.json()) : null
      if (!ids) throw new Error('unreadable list')
      this.saved = { ids, fetchedAt: Date.now() }
      this.failed = false
      await writeJson(this.file, this.saved).catch(() => {})
    } catch {
      this.failed = true
      return false
    }
    await this.#resolve()
    return JSON.stringify(this.served) !== before
  }
}