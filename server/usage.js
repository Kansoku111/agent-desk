// Per-turn token usage and an estimated API cost.
//
// ACP reports only how full the context window is, not what a turn consumed.
// dsh does record each model response's token usage in its session log
// (`<DSH_HOME>/sessions/<cwd>/<sessionId>/session.v4.jsonl.zstd`), so after a
// turn ends Agent Desk sums the responses logged since the turn started and
// prices them with the pi-ai catalog rates, the same way pi-ai's own
// `calculateCost` does. Only routes billed per token get a cost: the ChatGPT
// subscription is not. Native DeepSeek uses its official time-based rates.
// The log does not say whether a response ran in fast mode, so Claude
// responses on fast-capable models logged while fast mode was on are priced
// at the fast rate (see fast-mode.js).
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fastMultiplier } from './fast-mode.js'
import { catalogDataDirs } from './model-catalog.js'
import { deepSeekPricing, deepSeekRatesAt } from './deepseek-pricing.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** Providers whose API use is billed per token with catalog rates. */
const BILLED_PROVIDERS = new Set(['anthropic', 'deepseek-official'])

/** Every JSON line of a session log; the log is a run of appended zstd frames. */
export function decodeSessionLog(buffer) {
  const starts = []
  for (let index = buffer.indexOf(ZSTD_MAGIC); index !== -1; index = buffer.indexOf(ZSTD_MAGIC, index + 4)) starts.push(index)
  const events = []
  for (let frame = 0; frame < starts.length; frame += 1) {
    let text
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(starts[frame], starts[frame + 1] ?? buffer.length)).toString('utf8')
    } catch {
      // A magic number inside compressed data, or a frame still being written.
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {}
    }
  }
  return events
}

export async function findSessionLog(dshHome, sessionId) {
  const root = path.join(dshHome, 'sessions')
  let dirs = []
  try {
    dirs = await fs.readdir(root)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const file = path.join(root, dir, sessionId, 'session.v4.jsonl.zstd')
    try {
      await fs.access(file)
      return file
    } catch {}
  }
  return null
}

/**
 * Logs of the subagents a session started since `since`. A child runs in the
 * parent's folder and names it in its header (`parentSession`); only folders
 * touched since the turn began are read.
 */
async function childSessionLogs(parentLog, sessionId, since) {
  const root = path.dirname(path.dirname(parentLog))
  let entries = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const children = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === sessionId) continue
    const file = path.join(root, entry.name, 'session.v4.jsonl.zstd')
    try {
      if ((await fs.stat(file)).mtimeMs < since) continue
      const events = decodeSessionLog(await fs.readFile(file))
      if (events[0]?.type === 'session' && events[0].parentSession === sessionId) children.push(events)
    } catch {}
  }
  return children
}

/** Adds one turn summary to another (either may be null). */
export function mergeUsage(a, b) {
  if (!a || !b) return a ?? b ?? null
  const total = { ...a }
  for (const key of ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) total[key] = a[key] + b[key]
  total.cost = a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0)
  total.models = [...new Set([...a.models, ...b.models])]
  return total
}

let pricingCache = null
let fastPricingState = null

/**
 * Catalog rates ($ per million tokens) by `provider/model`. The map's `fast`
 * property carries when fast mode was on ({@link setFastPricing}).
 */
export async function loadPricing() {
  if (pricingCache) return pricingCache
  const pricing = new Map(deepSeekPricing())
  pricing.fast = fastPricingState
  const [dir] = catalogDataDirs()
  for (const provider of ['anthropic']) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, `${provider}.json`), 'utf8'))
      for (const group of Object.values(data)) {
        for (const model of Object.values(group)) {
          if (model?.cost && (model.type ?? 'chat') === 'chat') pricing.set(`${provider}/${model.id}`, model.cost)
        }
      }
    } catch {}
  }
  pricingCache = pricing
  return pricing
}

/** Drops cached rates after the catalog changed. */
export function resetPricing() {
  pricingCache = null
}

/** Sets the fast-mode periods (fast-mode.js's `fastPricing`); drops cached rates. */
export function setFastPricing(fast) {
  fastPricingState = fast
  pricingCache = null
}

/** One logged response's cost, or null when the model has no rates. */
export function priceResponse(pricing, key, usage, time) {
  const rates = pricing.get(key)
  const active = rates?.schedule === 'deepseek' ? deepSeekRatesAt(rates, time) : rates
  return active ? responseCost(active, usage) * fastMultiplier(pricing.fast, key, time) : null
}

/** pi-ai's calculateCost for one response; the log has no 1h-cache split, so writes use the 5m rate. */
export function responseCost(rates, usage) {
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  let active = rates
  let matched = -1
  for (const tier of rates.tiers ?? []) {
    if (input + cacheRead + cacheWrite > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
      active = tier
      matched = tier.inputTokensAbove
    }
  }
  return (active.input * input + active.output * output + active.cacheRead * cacheRead + active.cacheWrite * cacheWrite) / 1_000_000
}

/**
 * Sums the responses a turn produced.
 * @param events - decoded session log events.
 * @param since - when the turn started (epoch ms).
 * @param pricing - rates from {@link loadPricing}.
 * @returns the turn's usage, or null when the log holds no response for it.
 */
export function summarizeUsage(events, since, pricing, until = Infinity) {
  const total = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null, models: [] }
  const models = new Set()
  let cost = 0
  let priced = false
  for (const event of events) {
    if (event?.type !== 'assistant/message' || !(event.time >= since && event.time <= until)) continue
    const usage = event.data?.usage
    if (!usage) continue
    const source = event.data?.message?.source ?? {}
    total.requests += 1
    total.input += usage.inputTokens ?? 0
    total.output += usage.outputTokens ?? 0
    total.cacheRead += usage.cacheReadTokens ?? 0
    total.cacheWrite += usage.cacheWriteTokens ?? 0
    total.reasoning += usage.reasoningTokens ?? 0
    if (source.provider && source.model) models.add(`${source.provider}/${source.model}`)
    if (BILLED_PROVIDERS.has(source.provider)) {
      const price = priceResponse(pricing, `${source.provider}/${source.model}`, usage, event.time)
      if (price !== null) {
        cost += price
        priced = true
      }
    }
  }
  if (total.requests === 0) return null
  total.models = [...models]
  total.cost = priced ? cost : null
  return total
}

/**
 * Usage for one finished turn. dsh may still be appending the log when the
 * prompt resolves, so this waits for the turn's end record for a moment.
 */
export async function turnUsage({ dshHome, sessionId, since, until = Infinity, waitMs = 4000 }) {
  if (!sessionId) return null
  const pricing = await loadPricing()
  const deadline = Date.now() + waitMs
  let summary = null
  while (true) {
    const file = await findSessionLog(dshHome, sessionId)
    if (file) {
      const events = decodeSessionLog(await fs.readFile(file))
      summary = summarizeUsage(events, since, pricing, until)
      const ended = events.some((event) => event?.type === 'turn/end' && event.time >= since && event.time <= until)
      if (ended) {
        // Subagents bill separately (a GPT task may delegate to Claude); a
        // child still running in the background counts what it has used so far.
        for (const child of await childSessionLogs(file, sessionId, since)) summary = mergeUsage(summary, summarizeUsage(child, since, pricing, until))
        return summary
      }
    }
    if (Date.now() >= deadline) return summary
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
