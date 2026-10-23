// Keeps the model list current without an Agent Desk release.
//
// New Claude and GPT models reach the pi-ai package (whose catalog dsh reads,
// see model-catalog.js) within days of their launch, while the pi-ai Agent
// Desk installs stays on the version dsh was built against. Every few hours
// the newest pi-ai release is looked up on npm; when it is newer than the one
// last read, its tarball is downloaded and checked against the registry's
// sha512, the two catalog files Agent Desk uses are read straight from it, and
// the models the installed catalog lacks are kept in the data folder. Nothing
// is installed: model-catalog.js adds the kept definitions like its bundled ones.
//
// Only what the installed pi-ai can use is kept: chat models of an API it
// speaks, sent to a base URL it already uses for that provider, with the
// fields it knows (a newer release's other fields would be ignored anyway).
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import zlib from 'node:zlib'
import extras from './catalog-extras.json' with { type: 'json' }
import { GPT_PROVIDER, siwcCatalog } from './siwc-route.js'
import { compareVersions, isVersion, runNpm } from './update-checks.js'
import { readJson, writeJson } from './json-file.js'
import { BUNDLED_SOURCE, CUSTOM_MODEL_PROVIDERS, isModelId, shippedCatalog } from './model-catalog.js'

export const PI_AI_PACKAGE = '@earendil-works/pi-ai'

/** Normalize old on-disk GPT update caches before exposing them. */
function routedUpdates(catalog) {
  if (!catalog?.providers?.[GPT_PROVIDER]) return catalog
  return {
    ...catalog,
    providers: {
      ...catalog.providers,
      [GPT_PROVIDER]: siwcCatalog(catalog.providers[GPT_PROVIDER]),
    },
  }
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 30_000
const MAX_TARBALL_BYTES = 50 * 1024 * 1024
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024
const CATALOG_PATH = 'dist/providers/data'

/** The newest pi-ai release, through npm so the user's registry settings apply. */
export async function lookupLatest({ cwd, npm = runNpm }) {
  const { stdout } = await npm(['view', `${PI_AI_PACKAGE}@latest`, 'version', 'dist.tarball', 'dist.integrity', '--json'], { cwd, timeoutMs: 60_000 })
  const info = JSON.parse(stdout)
  const release = { version: info?.version, tarball: info?.['dist.tarball'], integrity: info?.['dist.integrity'] }
  if (!isVersion(release.version)) throw new Error('npm から pi-ai のバージョンを読み取れませんでした')
  if (typeof release.tarball !== 'string' || !release.tarball.startsWith('https://')) throw new Error('pi-ai の配布ファイルの場所が不正です')
  return release
}

/** Downloads a release tarball and checks it against the registry's sha512. */
export async function downloadTarball({ tarball, integrity }, fetchImpl = fetch) {
  const expected = String(integrity ?? '').split(/\s+/).find((entry) => entry.startsWith('sha512-'))?.slice('sha512-'.length)
  if (!expected) throw new Error('npm が pi-ai のハッシュ（sha512）を返しませんでした')
  const response = await fetchImpl(tarball, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`pi-ai をダウンロードできませんでした（HTTP ${response.status}）`)
  if (Number(response.headers?.get?.('content-length')) > MAX_TARBALL_BYTES) throw new Error('pi-ai の配布ファイルが大きすぎます')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_TARBALL_BYTES) throw new Error('pi-ai の配布ファイルが大きすぎます')
  if (createHash('sha512').update(buffer).digest('base64') !== expected) {
    throw new Error('ダウンロードした pi-ai が npm の記録と一致しません')
  }
  return buffer
}

/**
 * Reads files out of a .tgz package. `wanted` holds paths inside the package
 * folder (npm puts everything under one top folder, normally `package/`).
 * @returns {Map<string, Buffer>}
 */
export function readTarFiles(tgz, wanted) {
  const tar = zlib.gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED_BYTES })
  const files = new Map()
  let offset = 0
  let longName = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) throw new Error('pi-ai の配布ファイルを読めませんでした')
    const type = String.fromCharCode(header[156])
    const prefix = field(257, 6).startsWith('ustar') ? field(345, 155) : ''
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const body = tar.subarray(offset + 512, offset + 512 + size)
    if (type === 'x') {
      // A pax header: its `path` record names the next entry.
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null
    } else if (type === 'L') {
      longName = body.toString('utf8').replace(/\0[\s\S]*$/, '')
    } else if (type === '0' || type === '\0') {
      const inner = name.replace(/^\.\//, '').replace(/^[^/]+\//, '')
      if (wanted.has(inner)) files.set(inner, Buffer.from(body))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

function isUsableModel(model, { id, api, provider, baseUrls }) {
  return Boolean(model) && typeof model === 'object' && !Array.isArray(model)
    && model.id === id && isModelId(id) && model.api === api && model.provider === provider
    && typeof model.name === 'string' && baseUrls.has(model.baseUrl)
    && Number.isInteger(model.contextWindow) && model.contextWindow > 0
    && Number.isInteger(model.maxTokens) && model.maxTokens > 0
    && Array.isArray(model.input)
    && Boolean(model.cost) && typeof model.cost.input === 'number' && typeof model.cost.output === 'number'
}

/**
 * The models of a newer pi-ai catalog file that the installed catalog lacks,
 * reduced to what the installed pi-ai understands. Reads both the bare-id
 * layout (pi-ai 0.x) and pi-ai 1.x's `<type>:<id>` keys.
 * @param {object} data      the newer `<provider>.json`
 * @param {object} shipped   the installed `<provider>.json` without Agent Desk's additions
 * @param {Set<string>} keys model fields the installed pi-ai uses
 * @returns {{ groups: Record<string, Record<string, object>>, models: { id: string, name: string }[] }}
 */
export function newerModels({ provider, data, shipped, keys }) {
  const groups = {}
  const models = []
  if (!data || typeof data !== 'object' || !shipped) return { groups, models }
  if (provider === GPT_PROVIDER) {
    data = siwcCatalog(data)
    shipped = siwcCatalog(shipped)
  }
  const baseUrls = new Set(Object.values(shipped).flatMap((group) => Object.values(group).map((model) => model.baseUrl)))
  const known = (id) => Object.values(shipped).some((group) => group[id])
  for (const [api, group] of Object.entries(data)) {
    // An API the installed pi-ai does not speak.
    if (!shipped[api] || !group || typeof group !== 'object') continue
    for (const [key, model] of Object.entries(group)) {
      const colon = key.indexOf(':')
      const type = colon >= 0 ? key.slice(0, colon) : 'chat'
      const id = colon >= 0 ? key.slice(colon + 1) : key
      if (type !== 'chat' || (model?.type ?? 'chat') !== 'chat') continue
      if (known(id) || !isUsableModel(model, { id, api, provider, baseUrls })) continue
      groups[api] ??= {}
      groups[api][id] = Object.fromEntries(Object.entries(model).filter(([name]) => keys.has(name)))
      models.push({ id, name: model.name })
    }
  }
  return { groups, models }
}

/** The ids, by provider, of a `{ providers: { [provider]: { [api]: { [id]: model } } } }` set. */
function modelIds(set) {
  const ids = new Set()
  for (const [provider, groups] of Object.entries(set?.providers ?? {})) {
    for (const group of Object.values(groups ?? {})) for (const id of Object.keys(group ?? {})) ids.add(`${provider}/${id}`)
  }
  return ids
}

export class ModelCatalogUpdater extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.root          project folder (where npm runs)
   * @param {string} options.home          Agent Desk data folder
   * @param {() => boolean} options.enabled  whether to check by itself and use what it fetched
   * @param {() => Promise<void>} options.onCatalog  applies newly fetched definitions
   */
  constructor({
    root, home, enabled, onCatalog,
    npm = runNpm, lookup = lookupLatest, download = downloadTarball, shipped = shippedCatalog, log = () => {},
  }) {
    super()
    Object.assign(this, { root, enabled, onCatalog, npm, lookup, download, shipped, log })
    this.file = path.join(home, 'model-updates.json')
    /** @type {{ source: string, fetchedAt: number, providers: object } | null} */
    this.catalog = null
    this.state = { phase: 'idle', checkedAt: null, latest: null, error: null, lastAdded: null }
    this.timer = null
  }

  async load() {
    const saved = await readJson(this.file, {})
    if (isVersion(saved.catalog?.source) && saved.catalog.providers && typeof saved.catalog.providers === 'object') this.catalog = routedUpdates(saved.catalog)
    this.state.checkedAt = saved.checkedAt ?? null
    this.state.latest = saved.latest ?? null
    this.state.lastAdded = saved.lastAdded ?? null
    return this
  }

  /** The definitions model-catalog.js should add, or null while turned off. */
  get fetched() {
    return this.enabled() ? this.catalog : null
  }

  snapshot() {
    return { ...this.state, source: this.catalog?.source ?? BUNDLED_SOURCE }
  }

  #set(patch) {
    Object.assign(this.state, patch)
    this.emit('state', this.snapshot())
  }

  async #save() {
    const { checkedAt, latest, lastAdded } = this.state
    await writeJson(this.file, { checkedAt, latest, lastAdded, catalog: this.catalog })
      .catch((error) => this.log('could not save model updates:', error.message))
  }

  /** Checks shortly after start and then every few hours, while turned on. */
  start() {
    const schedule = (delay) => {
      this.timer = setTimeout(() => {
        if (this.enabled()) void this.check()
        schedule(CHECK_INTERVAL_MS)
      }, delay)
      this.timer.unref?.()
    }
    schedule(FIRST_CHECK_MS)
  }

  stop() {
    clearTimeout(this.timer)
  }

  /** Looks for a newer pi-ai release and keeps the models it adds. */
  async check() {
    if (this.state.phase === 'checking') return this.snapshot()
    this.#set({ phase: 'checking', error: null })
    try {
      const release = await this.lookup({ cwd: this.root, npm: this.npm })
      const have = this.catalog?.source ?? BUNDLED_SOURCE
      if (!have || compareVersions(release.version, have) > 0) await this.#read(release)
      this.#set({ phase: 'idle', checkedAt: Date.now(), latest: release.version })
      await this.#save()
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split('\n').find((line) => line.trim())?.trim().slice(0, 300) ?? ''
      this.#set({ phase: 'idle', error: `モデル一覧の更新を確認できませんでした: ${message}` })
    }
    return this.snapshot()
  }

  async #read(release) {
    const tgz = await this.download(release)
    const wanted = new Set(CUSTOM_MODEL_PROVIDERS.map((provider) => `${CATALOG_PATH}/${provider}.json`))
    const files = readTarFiles(tgz, wanted)
    const { providers: shipped, keys } = await this.shipped()
    const providers = {}
    for (const provider of CUSTOM_MODEL_PROVIDERS) {
      const file = files.get(`${CATALOG_PATH}/${provider}.json`)
      if (!file) throw new Error(`pi-ai ${release.version} に ${provider} のモデル一覧がありません`)
      const { groups } = newerModels({ provider, data: JSON.parse(file.toString('utf8')), shipped: shipped[provider], keys })
      if (Object.keys(groups).length) providers[provider] = groups
    }
    const next = { source: release.version, fetchedAt: Date.now(), providers }
    // What this release brings that Agent Desk did not offer before.
    const before = new Set([...modelIds(extras), ...modelIds(this.catalog)])
    const fresh = []
    for (const [provider, groups] of Object.entries(providers)) {
      for (const group of Object.values(groups)) {
        for (const [id, model] of Object.entries(group)) if (!before.has(`${provider}/${id}`)) fresh.push({ provider, id, name: model.name ?? id })
      }
    }
    const changed = JSON.stringify(providers) !== JSON.stringify(this.catalog?.providers ?? null)
    this.catalog = next
    if (fresh.length) {
      this.state.lastAdded = { at: Date.now(), source: release.version, models: fresh }
      this.log(`pi-ai ${release.version} adds ${fresh.map((model) => `${model.provider}/${model.id}`).join(', ')}`)
    }
    await this.#save()
    if (changed && this.enabled()) await this.onCatalog()
  }
}

/** The kept definitions as model-catalog.js takes them, for processes other than the server. */
export async function readFetchedCatalog(home) {
  const saved = await readJson(path.join(home, 'model-updates.json'), {})
  return isVersion(saved.catalog?.source) && saved.catalog.providers ? routedUpdates(saved.catalog) : null
}
