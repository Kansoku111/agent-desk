// Running totals of model usage across every task, for the usage screen.
//
// dsh logs each model response with its token counts (see usage.js). This
// scans every session log under DSH_HOME, sums the responses by local day and
// model, and caches those sums per log (`<home>/usage-history.json`) so a later
// scan decodes only the logs that changed. A log that disappears keeps its
// sums, so the totals still count tasks whose logs were cleaned up.
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJson } from './json-file.js'
import { decodeSessionLog, loadPricing, priceResponse } from './usage.js'

const CACHE_VERSION = 1
const LOG_NAME = 'session.v4.jsonl.zstd'
const DAILY_DAYS = 30

const pad = (value) => String(value).padStart(2, '0')

/** `YYYY-MM-DD` of a time in the local time zone. */
export function localDay(time) {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * A changed rate table invalidates the cached costs. Fast-mode periods only
 * grow, and a log is repriced whenever it changes, so they need not count.
 */
export function pricingSignature(pricing) {
  const entries = [...pricing.entries()].sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16)
}

const emptyTotals = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null })

function addTotals(into, from) {
  into.requests += from.requests
  into.input += from.input
  into.output += from.output
  into.cacheRead += from.cacheRead
  into.cacheWrite += from.cacheWrite
  into.reasoning += from.reasoning
  if (from.cost !== null) into.cost = (into.cost ?? 0) + from.cost
  return into
}

/**
 * One log's responses summed by local day and `provider/model`.
 * @returns {Record<string, Record<string, ReturnType<typeof emptyTotals>>>}
 */
export function dailyUsage(events, pricing) {
  const days = {}
  for (const event of events) {
    if (event?.type !== 'assistant/message' || typeof event.time !== 'number') continue
    const usage = event.data?.usage
    if (!usage) continue
    const source = event.data?.message?.source ?? {}
    const model = source.provider && source.model ? `${source.provider}/${source.model}` : 'unknown'
    const day = (days[localDay(event.time)] ??= {})
    const totals = (day[model] ??= emptyTotals())
    addTotals(totals, {
      requests: 1,
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      reasoning: usage.reasoningTokens ?? 0,
      cost: priceResponse(pricing, model, usage, event.time),
    })
  }
  return days
}

/**
 * Totals for today, this month and all time, overall and per model and
 * provider, plus the last 30 days for a chart.
 * @param files - cached per-log sums, as kept in the cache file.
 */
export function summarizeHistory(files, now = Date.now()) {
  const today = localDay(now)
  const month = today.slice(0, 7)
  const firstDaily = localDay(now - (DAILY_DAYS - 1) * 86_400_000)
  const overall = { today: emptyTotals(), month: emptyTotals(), all: emptyTotals() }
  const models = new Map()
  const providers = new Map()
  const daily = new Map()
  let since = null
  for (const entry of Object.values(files)) {
    for (const [day, byModel] of Object.entries(entry.days ?? {})) {
      if (!since || day < since) since = day
      for (const [model, totals] of Object.entries(byModel)) {
        const provider = model.split('/')[0]
        const scopes = [overall]
        if (!models.has(model)) models.set(model, { model, month: emptyTotals(), all: emptyTotals() })
        if (!providers.has(provider)) providers.set(provider, { today: emptyTotals(), month: emptyTotals(), all: emptyTotals() })
        scopes.push(models.get(model), providers.get(provider))
        for (const scope of scopes) {
          addTotals(scope.all, totals)
          if (day.startsWith(month)) addTotals(scope.month, totals)
          if (day === today && scope.today) addTotals(scope.today, totals)
        }
        if (day >= firstDaily) {
          const point = daily.get(day) ?? { day, cost: 0, tokens: 0 }
          point.cost += totals.cost ?? 0
          point.tokens += totals.input + totals.output + totals.cacheRead + totals.cacheWrite
          daily.set(day, point)
        }
      }
    }
  }
  const days = []
  for (let index = DAILY_DAYS - 1; index >= 0; index -= 1) {
    const day = localDay(now - index * 86_400_000)
    if (!days.some((point) => point.day === day)) days.push(daily.get(day) ?? { day, cost: 0, tokens: 0 })
  }
  const weight = (totals) => totals.cost ?? 0
  const tokens = (totals) => totals.input + totals.output + totals.cacheRead + totals.cacheWrite
  return {
    ...overall,
    since,
    providers: Object.fromEntries(providers),
    models: [...models.values()].sort((a, b) => weight(b.all) - weight(a.all) || tokens(b.all) - tokens(a.all)),
    daily: days,
    updatedAt: now,
  }
}

export class UsageHistory extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.dshHome - dsh's home; logs live under `sessions/`.
   * @param {string} options.file - the cache file.
   * @param {() => Promise<Map<string, object>>} [options.pricing] - rates by `provider/model`.
   * @param {() => number} [options.now]
   */
  constructor({ dshHome, file, pricing = loadPricing, now = Date.now }) {
    super()
    this.root = path.join(dshHome, 'sessions')
    this.file = file
    this.pricing = pricing
    this.now = now
    this.cache = null
    this.summary = null
    this.running = null
    this.again = false
  }

  async #load() {
    const data = await readJson(this.file, null)
    this.cache = data?.version === CACHE_VERSION ? data : { version: CACHE_VERSION, pricing: null, files: {} }
  }

  async #logs() {
    const logs = []
    let dirs = []
    try {
      dirs = await fs.readdir(this.root)
    } catch {
      return logs
    }
    for (const dir of dirs) {
      let sessions = []
      try {
        sessions = await fs.readdir(path.join(this.root, dir))
      } catch {
        continue
      }
      for (const session of sessions) {
        const file = path.join(this.root, dir, session, LOG_NAME)
        try {
          const stat = await fs.stat(file)
          if (stat.isFile()) logs.push({ key: `${dir}/${session}`, file, size: stat.size, mtimeMs: stat.mtimeMs })
        } catch {}
      }
    }
    return logs
  }

  async #scan() {
    if (!this.cache) await this.#load()
    const pricing = await this.pricing()
    const signature = pricingSignature(pricing)
    const repriced = this.cache.pricing !== signature
    let changed = repriced
    for (const log of await this.#logs()) {
      const cached = this.cache.files[log.key]
      if (!repriced && cached?.size === log.size && cached?.mtimeMs === log.mtimeMs) continue
      let events
      try {
        events = decodeSessionLog(await fs.readFile(log.file))
      } catch {
        continue
      }
      this.cache.files[log.key] = { size: log.size, mtimeMs: log.mtimeMs, days: dailyUsage(events, pricing) }
      changed = true
    }
    this.cache.pricing = signature
    if (changed) await writeJson(this.file, this.cache).catch(() => {})
    this.summary = summarizeHistory(this.cache.files, this.now())
    this.emit('summary', this.summary)
    return this.summary
  }

  /** Rescans the logs; calls during a scan run one more scan afterwards. */
  async refresh() {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        let summary
        do {
          this.again = false
          summary = await this.#scan()
        } while (this.again)
        return summary
      } finally {
        this.running = null
      }
    })()
    return this.running
  }
}
