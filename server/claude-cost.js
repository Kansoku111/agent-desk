// What the Claude organization was actually billed, from the Usage & Cost
// Admin API (the numbers on the Claude Console's Cost page).
//
// The Admin API takes an Admin API key (sk-ant-admin…) or a personal or
// service account key that is not scoped to a workspace; ordinary workspace
// keys are refused. Costs come per UTC day. Finished days rarely change, so
// they are cached (`<home>/claude-cost.json`) and a refresh fetches only the
// last few days once a year of history is in.
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readJson, writeJson } from './json-file.js'

const COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report'
const HISTORY_DAYS = 365
const REFETCH_DAYS = 3
const DAY_MS = 86_400_000
const MAX_PAGES = 20

/** `YYYY-MM-DD` of a time in UTC, the API's day boundary. */
export function utcDay(time) {
  return new Date(time).toISOString().slice(0, 10)
}

const startOfUtcDay = (time) => Date.parse(`${utcDay(time)}T00:00:00Z`)

/** A short fingerprint, so a different key (maybe another organization) drops the cache. */
export function keyFingerprint(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16)
}

/** What a cost line is for: the model, else the kind of charge. */
function costLabel(result) {
  if (result.model) return result.model
  if (result.cost_type === 'web_search') return 'Web 検索'
  if (result.cost_type === 'code_execution') return 'コード実行'
  if (result.cost_type === 'session_usage') return 'セッション'
  return result.description || 'その他'
}

/**
 * Cost report pages reduced to US dollars by UTC day and label.
 * `amount` is a decimal string in cents.
 * @returns {Record<string, Record<string, number>>}
 */
export function parseCostReport(pages) {
  const days = {}
  for (const page of pages) {
    for (const bucket of page?.data ?? []) {
      if (typeof bucket?.starting_at !== 'string') continue
      const day = (days[bucket.starting_at.slice(0, 10)] ??= {})
      for (const result of bucket.results ?? []) {
        const cents = Number.parseFloat(result?.amount)
        if (!Number.isFinite(cents) || (result.currency && result.currency !== 'USD')) continue
        const label = costLabel(result)
        day[label] = (day[label] ?? 0) + cents / 100
      }
    }
  }
  return days
}

/**
 * Fetches daily costs from `from` (epoch ms) up to now.
 * @returns {Promise<{status: 'ok', days: object} | {status: 'invalid' | 'forbidden' | 'error', httpStatus?: number, message: string}>}
 */
export async function fetchCostDays({ key, from, fetchImpl = fetch, userAgent = 'AgentDesk' }) {
  const pages = []
  let page = null
  for (let count = 0; count < MAX_PAGES; count += 1) {
    const url = new URL(COST_URL)
    url.searchParams.set('starting_at', new Date(from).toISOString().replace(/\.\d{3}Z$/, 'Z'))
    url.searchParams.set('bucket_width', '1d')
    url.searchParams.set('limit', '31')
    url.searchParams.append('group_by[]', 'description')
    if (page) url.searchParams.set('page', page)
    let response
    try {
      response = await fetchImpl(url, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'user-agent': userAgent, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    let body = null
    try {
      body = await response.json()
    } catch {}
    if (!response.ok) {
      const message = body?.error?.message ?? `HTTP ${response.status}`
      if (response.status === 401) return { status: 'invalid', httpStatus: 401, message }
      if (response.status === 403) return { status: 'forbidden', httpStatus: 403, message }
      return { status: 'error', httpStatus: response.status, message }
    }
    pages.push(body)
    if (!body?.has_more || !body.next_page) return { status: 'ok', days: parseCostReport(pages) }
    page = body.next_page
  }
  return { status: 'ok', days: parseCostReport(pages) }
}

/** Today, this month, the last 30 days and the cached year, by UTC day. */
export function summarizeCost(days, now = Date.now()) {
  const today = utcDay(now)
  const month = today.slice(0, 7)
  const last30 = utcDay(now - 29 * DAY_MS)
  const totals = { today: 0, month: 0, last30: 0, all: 0 }
  const models = new Map()
  const months = new Map()
  let since = null
  for (const [day, byLabel] of Object.entries(days)) {
    if (!since || day < since) since = day
    for (const [label, amount] of Object.entries(byLabel)) {
      totals.all += amount
      if (day === today) totals.today += amount
      if (day.startsWith(month)) totals.month += amount
      if (day >= last30) totals.last30 += amount
      const model = models.get(label) ?? { label, month: 0, all: 0 }
      model.all += amount
      if (day.startsWith(month)) model.month += amount
      models.set(label, model)
      months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) ?? 0) + amount)
    }
  }
  return {
    ...totals,
    since,
    models: [...models.values()].filter((entry) => entry.all > 0).sort((a, b) => b.all - a.all),
    months: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([key, amount]) => ({ month: key, amount })),
  }
}

export class ClaudeCost extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.file - the cache file.
   * @param {() => Promise<{admin: string | null, api: string | null}>} options.keys - the stored keys.
   * @param {typeof fetchCostDays} [options.fetchDays]
   * @param {() => number} [options.now]
   */
  constructor({ file, keys, fetchDays = fetchCostDays, userAgent, now = Date.now }) {
    super()
    this.file = file
    this.keys = keys
    this.fetchDays = fetchDays
    this.userAgent = userAgent
    this.now = now
    this.cache = null
    // none: no key; needs-admin: the API key cannot read costs; ok; invalid / forbidden / error.
    this.state = { status: 'none', source: null, fetchedAt: null, message: null, summary: null }
    this.running = null
  }

  async load() {
    this.cache = await readJson(this.file, null)
    if (this.cache?.days) {
      this.state = { status: 'ok', source: this.cache.source ?? null, fetchedAt: this.cache.fetchedAt ?? null, message: null, summary: summarizeCost(this.cache.days, this.now()) }
    }
    return this
  }

  #set(state) {
    this.state = { status: 'none', source: null, fetchedAt: null, message: null, summary: null, ...state }
    this.emit('state', this.state)
    return this.state
  }

  /** Fetches unless the last fetch is younger than `maxAgeMs`. */
  async refresh({ maxAgeMs = 0 } = {}) {
    if (this.running) return this.running
    if (maxAgeMs > 0 && this.state.fetchedAt && this.now() - this.state.fetchedAt < maxAgeMs) return this.state
    this.running = this.#refresh().finally(() => {
      this.running = null
    })
    return this.running
  }

  async #refresh() {
    const { admin, api } = await this.keys()
    const candidates = [admin && { source: 'admin', key: admin }, !admin && api && { source: 'api', key: api }].filter(Boolean)
    if (candidates.length === 0) {
      await this.#forget()
      return this.#set({ status: 'none' })
    }
    const { source, key } = candidates[0]
    const fingerprint = keyFingerprint(key)
    const now = this.now()
    const cached = this.cache?.fingerprint === fingerprint ? this.cache : null
    const from = cached ? startOfUtcDay(now) - REFETCH_DAYS * DAY_MS : startOfUtcDay(now) - HISTORY_DAYS * DAY_MS
    const result = await this.fetchDays({ key, from, userAgent: this.userAgent })
    if (result.status !== 'ok') {
      // A plain API key that is refused just means an Admin key is needed.
      if (source === 'api' && (result.status === 'invalid' || result.status === 'forbidden' || result.httpStatus === 404)) {
        if (!cached) await this.#forget()
        return this.#set({ status: 'needs-admin', source, message: result.message })
      }
      const summary = cached ? summarizeCost(cached.days, now) : null
      return this.#set({ status: result.status, source, fetchedAt: cached?.fetchedAt ?? null, message: result.message, summary })
    }
    const days = { ...(cached?.days ?? {}) }
    for (const day of Object.keys(days)) if (Date.parse(`${day}T00:00:00Z`) >= from) delete days[day]
    Object.assign(days, result.days)
    // Keep a little over a year.
    const oldest = utcDay(now - (HISTORY_DAYS + 31) * DAY_MS)
    for (const day of Object.keys(days)) if (day < oldest) delete days[day]
    this.cache = { fingerprint, source, fetchedAt: now, days }
    await writeJson(this.file, this.cache).catch(() => {})
    return this.#set({ status: 'ok', source, fetchedAt: now, summary: summarizeCost(days, now) })
  }

  async #forget() {
    if (!this.cache) return
    this.cache = null
    await writeJson(this.file, {}).catch(() => {})
  }
}
