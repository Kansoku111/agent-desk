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
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { fastMultiplier } from './fast-mode.js'
import { catalogDataDirs, isModelId } from './model-catalog.js'
import { catalogRates } from './pricing-rates.js'
import { deepSeekPricing, deepSeekRatesAt } from './deepseek-pricing.js'
import { addScores, emptyScore, scoreFromUsd } from '../shared/usage-score.js'
import fallbackPricing from './usage-pricing-fallback.json' with { type: 'json' }

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** Providers whose API use is billed per token with catalog rates. */
const BILLED_PROVIDERS = new Set(['anthropic', 'deepseek-official'])

export const isBilledModel = (key) => BILLED_PROVIDERS.has(key?.split('/')[0])

const decompress = promisify(zlib.zstdDecompress)
/** Frames decompressed at once (on the thread pool), and so the most work done between two turns of the event loop. */
export const FRAME_BATCH = 16

/** Where each zstd frame of a log starts (a magic number inside compressed data also counts, as in {@link decodeSessionLog}). */
export function frameStarts(buffer) {
  const starts = []
  for (let index = buffer.indexOf(ZSTD_MAGIC); index !== -1; index = buffer.indexOf(ZSTD_MAGIC, index + 4)) starts.push(index)
  return starts
}

/** The text of frames `from` up to `to` (each ends where the next starts); null for one that does not decode. */
export function frameTexts(buffer, starts, from, to) {
  const texts = []
  for (let index = from; index < to; index += 1) {
    const piece = buffer.subarray(starts[index], starts[index + 1] ?? buffer.length)
    texts.push(decompress(piece).then((text) => text.toString('utf8'), () => null))
  }
  return Promise.all(texts)
}

/** Every JSON line of a session log; the log is a run of appended zstd frames. */
export function decodeSessionLog(buffer) {
  const starts = frameStarts(buffer)
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

// dsh writes every event as `{"type":…,"seq":…,"time":…,…}`, so a line's time is known without parsing it.
const EVENT_TIME = /^\{"type":"[^"]*","seq":\d+,"time":(\d+)[,}]/

/**
 * The events of one frame's text. A line whose time lies outside [since, until],
 * or that `keep` (a test on the raw line) turns down, is not parsed.
 * `newest` is the latest time on the frame's lines, or null unless every line states one.
 */
function frameRange(text, keep, since, until) {
  const events = []
  let newest = -Infinity
  let timed = true
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const match = EVENT_TIME.exec(line)
    const time = match ? Number(match[1]) : null
    if (time === null) timed = false
    else {
      if (time > newest) newest = time
      if (time < since || time > until) continue
    }
    if (keep && !keep(line)) continue
    try {
      events.push(JSON.parse(line))
    } catch {}
  }
  return { events, newest: timed && newest > -Infinity ? newest : null }
}

/**
 * The events of a session log that matter to a caller, in log order, without
 * decoding the whole log: frames are read from the end, and reading stops once
 * two frames in a row hold only lines older than `since` (event times do not go
 * backwards in a log). Of the lines read, only those in [since, until] that
 * `keep` accepts are parsed. Unlike {@link decodeSessionLog} it hands the event
 * loop back between batches of frames.
 * @param {Buffer} buffer
 * @param {{ keep?: ((line: string) => boolean) | null, since?: number, until?: number }} [options]
 */
export async function decodeSessionRange(buffer, { keep = null, since = -Infinity, until = Infinity } = {}) {
  const starts = frameStarts(buffer)
  const found = []
  let older = 0
  for (let end = starts.length; end > 0 && older < 2; end -= FRAME_BATCH) {
    const texts = await frameTexts(buffer, starts, Math.max(0, end - FRAME_BATCH), end)
    for (let index = texts.length - 1; index >= 0 && older < 2; index -= 1) {
      if (texts[index] === null) continue
      const { events, newest } = frameRange(texts[index], keep, since, until)
      found.push(events)
      older = newest !== null && newest < since ? older + 1 : 0
    }
  }
  return found.reverse().flat()
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

const isResponse = (line) => line.includes('assistant/message')
const isResponseOrEnd = (line) => line.includes('assistant/message') || line.includes('turn/end')

/**
 * The first event of a log, from its first frame alone: null when the log has
 * no frame, undefined when the first frame does not settle it (the caller then
 * decodes the whole log).
 */
async function firstEvent(file) {
  const handle = await fs.open(file, 'r')
  try {
    const { size } = await handle.stat()
    for (let length = 64 * 1024; ; length *= 4) {
      const head = Buffer.alloc(Math.min(length, size))
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      const read = head.subarray(0, bytesRead)
      const starts = frameStarts(read)
      // The first frame ends where the second starts; without one, the log may go on past what was read.
      if (starts.length < 2 && bytesRead < size) continue
      if (!starts.length) return null
      const [text] = await frameTexts(read, starts, 0, 1)
      if (text === null) return undefined
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          return JSON.parse(line)
        } catch {}
      }
      return undefined
    }
  } finally {
    await handle.close()
  }
}

/**
 * The responses logged in [since, until] by the subagents a session started in
 * that time, grandchildren included, one list per subagent. A child runs in the
 * parent's folder and names its parent in its header (`parentSession`); only
 * folders touched since the turn began are looked at, each header is read once,
 * and a log that is not a child's is read no further than its first frame.
 */
async function childSessionLogs(parentLog, sessionId, since, until) {
  const root = path.dirname(path.dirname(parentLog))
  let entries = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === sessionId) continue
    const file = path.join(root, entry.name, 'session.v4.jsonl.zstd')
    try {
      if ((await fs.stat(file)).mtimeMs < since) continue
      const first = await firstEvent(file)
      if (first === null) continue
      if (first === undefined) {
        const events = await decodeSessionRange(await fs.readFile(file))
        if (events[0]?.type === 'session') candidates.push({ id: entry.name, parent: events[0].parentSession, file, events })
      } else if (first.type === 'session') {
        candidates.push({ id: entry.name, parent: first.parentSession, file, events: null })
      }
    } catch {}
  }
  // A subagent's own subagents sit in the same folder. Each pass adds the
  // candidates whose parent is already in the family; the Set keeps a log from
  // being added twice, and folders that only name each other are never reached.
  const family = new Set([sessionId])
  const found = []
  for (let grew = true; grew;) {
    grew = false
    for (const candidate of candidates) {
      if (family.has(candidate.id) || !family.has(candidate.parent)) continue
      family.add(candidate.id)
      found.push(candidate)
      grew = true
    }
  }
  const children = []
  for (const { file, events } of found) {
    try {
      children.push(events ?? await decodeSessionRange(await fs.readFile(file), { keep: isResponse, since, until }))
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
  total.score = addScores(a.score, b.score)
  return total
}

let pricingCache = null
let pricingRevision = 0
let fastPricingState = null
let catalogPricing = new Map()
let equivalentPricing = new Map()

/** Public first-party rates fill missing GPT equivalents only, not metered bills. */
export function setEquivalentPricing(rates) {
  const next = new Map()
  for (const [key, raw] of Object.entries(rates)) {
    const [provider, id, extra] = key.split('/')
    const valid = catalogRates(raw)
    if (provider === 'openai-codex' && isModelId(id) && extra === undefined && valid) next.set(key, valid)
  }
  const changed = JSON.stringify([...equivalentPricing]) !== JSON.stringify([...next])
  equivalentPricing = next
  resetPricing()
  return changed
}

/** App-owned bundled/fetched definitions; never borrow rates from a custom template. */
export function setCatalogPricing(rates) {
  const next = new Map(Object.entries(rates))
  const changed = JSON.stringify([...catalogPricing]) !== JSON.stringify([...next])
  catalogPricing = next
  resetPricing()
  return changed
}

/**
 * Catalog rates ($ per million tokens) by `provider/model`. The map's `fast`
 * property carries when fast mode was on ({@link setFastPricing}).
 */
export async function loadPricing() {
  if (pricingCache) return pricingCache
  const revision = pricingRevision
  const bundled = Object.entries(fallbackPricing.models).map(([key, entry]) => [key, entry.rates])
  const pricing = new Map([...bundled, ...equivalentPricing, ...deepSeekPricing()])
  pricing.fast = fastPricingState
  const [dir] = catalogDataDirs()
  for (const provider of ['openai-codex', 'anthropic', 'opencode-go']) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, `${provider}.json`), 'utf8'))
      for (const group of Object.values(data)) {
        for (const model of Object.values(group)) {
          if (model?.cost && (model.type ?? 'chat') === 'chat'
            && !['custom', 'account'].includes(model.agentDeskAdded)) pricing.set(`${provider}/${model.id}`, model.cost)
        }
      }
    } catch {}
  }
  for (const [key, rates] of catalogPricing) pricing.set(key, rates)
  if (revision !== pricingRevision) return loadPricing()
  pricingCache = pricing
  return pricing
}

/** Drops cached rates after the catalog changed. */
export function resetPricing() {
  pricingCache = null
  pricingRevision++
}

/** Sets the fast-mode periods (fast-mode.js's `fastPricing`); drops cached rates. */
export function setFastPricing(fast) {
  fastPricingState = fast
  pricingCache = null
}

/** API-price equivalent; subscriptions may have rates without being metered bills. */
function equivalentCost(pricing, key, usage, time, multiplier = fastMultiplier(pricing.fast, key, time)) {
  const rates = pricing.get(key)
  const active = rates?.schedule === 'deepseek' ? deepSeekRatesAt(rates, time) : rates
  const cost = active ? responseCost(active, usage) : null
  return cost === null ? null : cost * multiplier
}

/** Estimated bill for a metered route, never a subscription's API-price equivalent. */
export function priceResponse(pricing, key, usage, time, multiplier) {
  return isBilledModel(key) ? equivalentCost(pricing, key, usage, time, multiplier) : null
}

/** A response is scored once, using its actual model, context tier and cache split. */
export function scoreResponse(pricing, key, usage, time, multiplier) {
  return scoreFromUsd(equivalentCost(pricing, key, usage, time, multiplier))
}

/** pi-ai rates; dsh logs without a cache TTL split retain the catalog's 5m write rate. */
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
  const hourWrites = usage.cacheWrite1hTokens ?? 0
  if (!Number.isFinite(hourWrites) || hourWrites < 0 || hourWrites > cacheWrite) return null
  // Anthropic's 1h cache writes cost 2x base input; use an explicit catalog rate if available.
  // https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing
  if (hourWrites) active = { ...active, cacheWrite1h: active.cacheWrite1h ?? active.input * 2 }
  const parts = [['input', input], ['output', output], ['cacheRead', cacheRead], ['cacheWrite', cacheWrite - hourWrites], ['cacheWrite1h', hourWrites]]
  if (parts.some(([key, count]) => !Number.isFinite(count) || count < 0
    || (count > 0 && (!Number.isFinite(active[key]) || active[key] < 0)))) return null
  return parts.reduce((sum, [key, count]) => sum + (count ? active[key] * count : 0), 0) / 1_000_000
}

/**
 * Sums the responses a turn produced.
 * @param events - decoded session log events.
 * @param since - when the turn started (epoch ms).
 * @param pricing - rates from {@link loadPricing}.
 * @returns the turn's usage, or null when the log holds no response for it.
 */
export function summarizeUsage(events, since, pricing, until = Infinity) {
  const total = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null, models: [], score: emptyScore() }
  const responses = new Map()
  for (const event of events) {
    if (event?.type !== 'assistant/message' || !(event.time >= since && event.time <= until)) continue
    const id = event.data?.message?.id ?? event.seq ?? event
    // Prefer the latest recorded usage; a usage-less duplicate cannot erase it.
    if (!responses.has(id) || event.data?.usage) responses.set(id, event)
  }
  const models = new Set()
  let cost = 0
  let priced = false
  for (const event of responses.values()) {
    const source = event.data?.message?.source ?? {}
    if (source.provider && source.model) models.add(`${source.provider}/${source.model}`)
    total.requests += 1
    const usage = event.data?.usage
    if (!usage) {
      total.score = addScores(total.score, null)
      continue
    }
    total.score = addScores(total.score, scoreResponse(pricing, `${source.provider}/${source.model}`, usage, event.time))
    total.input += usage.inputTokens ?? 0
    total.output += usage.outputTokens ?? 0
    total.cacheRead += usage.cacheReadTokens ?? 0
    total.cacheWrite += usage.cacheWriteTokens ?? 0
    total.reasoning += usage.reasoningTokens ?? 0
    const price = priceResponse(pricing, `${source.provider}/${source.model}`, usage, event.time)
    if (price !== null) {
      cost += price
      priced = true
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
 * Only the end of the log is decoded ({@link decodeSessionRange}), and a log
 * that has not changed since the last look is not read again.
 */
export async function turnUsage({ dshHome, sessionId, since, until = Infinity, waitMs = 4000 }) {
  if (!sessionId) return null
  const pricing = await loadPricing()
  const deadline = Date.now() + waitMs
  let summary = null
  let seen = null
  while (true) {
    const file = await findSessionLog(dshHome, sessionId)
    if (file) {
      const stat = await fs.stat(file)
      const stamp = `${stat.size}:${stat.mtimeMs}`
      if (stamp !== seen) {
        seen = stamp
        const events = await decodeSessionRange(await fs.readFile(file), { keep: isResponseOrEnd, since, until })
        summary = summarizeUsage(events, since, pricing, until)
        const ended = events.some((event) => event?.type === 'turn/end' && event.time >= since && event.time <= until)
        if (ended) {
          // Subagents bill separately (a GPT task may delegate to Claude); a
          // child still running in the background counts what it has used so far.
          for (const child of await childSessionLogs(file, sessionId, since, until)) summary = mergeUsage(summary, summarizeUsage(child, since, pricing, until))
          return summary
        }
      }
    }
    if (Date.now() >= deadline) return summary
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
