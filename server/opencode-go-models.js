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

/** The model ids of the installed pi-ai `opencode-go` catalog (both key layouts). */
export async function installedModelIds() {
  const [dir] = catalogDataDirs()
  if (!dir) return new Set()
  try {
    const data = JSON.parse(await fs.readFile(path.join(dir, 'opencode-go.json'), 'utf8'))
    const ids = new Set()
    for (const group of Object.values(data)) {
      for (const model of Object.values(group ?? {})) {
        if ((model?.type ?? 'chat') === 'chat' && typeof model?.id === 'string') ids.add(model.id)
      }
    }
    return ids
  } catch {
    return new Set()
  }
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
   * @param {() => Promise<Set<string>>} [options.installed] - ids the catalog can serve
   */
  constructor({ file, fetchImpl = fetch, installed = installedModelIds }) {
    Object.assign(this, { file, fetchImpl, installed })
    /** @type {{ ids: string[], fetchedAt: number } | null} */
    this.saved = null
    /** Catalog models among the live ones; null serves the whole catalog. */
    this.served = null
  }

  async load() {
    const saved = await readJson(this.file, null)
    if (Array.isArray(saved?.ids) && Number.isFinite(saved.fetchedAt)) this.saved = saved
    await this.#resolve()
    return this
  }

  async #resolve() {
    const live = this.saved?.ids
    const installed = live ? await this.installed() : null
    const served = live ? [...installed].filter((id) => live.includes(id)) : []
    // A list that shares nothing with the catalog is a sign of a bad reply, not of an empty service.
    this.served = served.length ? served.sort() : null
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
      if (!response.ok) return false
      const ids = parseModelIds(await response.json())
      if (!ids) return false
      this.saved = { ids, fetchedAt: Date.now() }
      await writeJson(this.file, this.saved).catch(() => {})
    } catch {
      return false
    }
    await this.#resolve()
    return JSON.stringify(this.served) !== before
  }
}
