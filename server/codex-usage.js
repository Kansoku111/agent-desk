// Codex reports a cumulative thread total and the last model response. The
// reference rate's context tier belongs to each response, never their sum.
import { addScores, emptyScore } from '../shared/usage-score.js'
import { scoreResponse } from './usage.js'

const FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens']

function counts(value) {
  if (!value || typeof value !== 'object') return null
  const result = { inputTokens: value.inputTokens, cachedInputTokens: value.cachedInputTokens,
    cacheWriteInputTokens: value.cacheWriteInputTokens ?? 0, outputTokens: value.outputTokens, reasoningOutputTokens: value.reasoningOutputTokens ?? 0 }
  if (FIELDS.some(key => !Number.isSafeInteger(result[key]) || result[key] < 0)) return null
  if (result.cachedInputTokens + result.cacheWriteInputTokens > result.inputTokens || result.reasoningOutputTokens > result.outputTokens) return null
  return result
}

const difference = (a, b) => Object.fromEntries(FIELDS.map(key => [key, a[key] - b[key]]))
const same = (a, b) => FIELDS.every(key => a[key] === b[key])
const empty = value => value.inputTokens === 0 && value.outputTokens === 0
const priceUsage = value => ({ inputTokens: value.inputTokens - value.cachedInputTokens - value.cacheWriteInputTokens,
  cacheReadTokens: value.cachedInputTokens, cacheWriteTokens: value.cacheWriteInputTokens, outputTokens: value.outputTokens })

export const isLegacyCodexUsage = usage => usage?.requestsExact === undefined && Array.isArray(usage?.models) && usage.models.some(model => typeof model === 'string' && model.startsWith('codex/'))

export class CodexUsageAccumulator {
  constructor(baseline, baselineKnown) {
    this.baseline = baselineKnown ? counts(baseline ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }) : null
    this.previous = this.baseline
    this.lastForTotal = null
    this.complete = this.baseline !== null
    this.latest = null
    this.latestRejected = false
    this.responses = []
  }

  observe(update) {
    const total = counts(update?.total)
    if (!total) { this.complete = false; this.latestRejected = true; return false }
    if (!this.previous) { this.latest = update; this.previous = total; this.complete = false; this.latestRejected = false; return true }
    const delta = difference(total, this.previous)
    // A monotonic total can still imply an impossible cache or reasoning delta.
    if (!counts(delta)) { this.complete = false; this.latestRejected = true; return false }
    this.latest = update
    this.previous = total
    const last = counts(update.last)
    if (empty(delta)) {
      // Repeated snapshots are common. A zero or changed last response cannot
      // be distinguished safely from a corrected/zero-token response.
      if (!last || empty(last) || (this.lastForTotal && !same(last, this.lastForTotal))) this.complete = false
      this.lastForTotal = last
      return true
    }
    this.latestRejected = false
    this.lastForTotal = last
    // On a missed notification the last response is still usable as a lower
    // bound only when it fits wholly inside the unseen cumulative delta.
    if (last && !empty(last) && counts(difference(delta, last))) this.responses.push(priceUsage(last))
    if (!last || !same(delta, last)) this.complete = false
    return true
  }

  summarize(pricing, model, time) {
    if (!this.baseline || !this.previous || !this.latest) return null
    const delta = difference(this.previous, this.baseline)
    let score = this.responses.reduce((sum, response) => addScores(sum, scoreResponse(pricing, 'openai-codex/' + model, response, time, 1)), emptyScore())
    const requestsExact = this.complete && this.responses.length > 0
    if (!requestsExact) score = addScores(score, null)
    return { requests: this.responses.length, requestsExact, input: delta.inputTokens - delta.cachedInputTokens - delta.cacheWriteInputTokens,
      output: delta.outputTokens, cacheRead: delta.cachedInputTokens, cacheWrite: delta.cacheWriteInputTokens, reasoning: delta.reasoningOutputTokens,
      cost: null, models: ['codex/' + model], score }
  }
}
