// Validate price data before it reaches the calculator; missing rates stay unknown.
const price = (value) => Number.isFinite(value) && value >= 0
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']

/** pi-ai rates in USD per million; unsupported tier shapes cannot be approximated. */
export function catalogRates(value) {
  if (!isObject(value) || Object.keys(value).some((key) => ![...RATE_FIELDS, 'tiers'].includes(key))) return null
  const normalize = (rate, tier = false) => {
    if (!isObject(rate) || Object.keys(rate).some((key) => !RATE_FIELDS.includes(key) && !(tier && key === 'inputTokensAbove'))) return null
    if (!price(rate.input) || !price(rate.output)) return null
    if (RATE_FIELDS.some((key) => rate[key] !== undefined && !price(rate[key]))) return null
    if (tier && (!Number.isSafeInteger(rate.inputTokensAbove) || rate.inputTokensAbove <= 0)) return null
    return Object.fromEntries(Object.entries(rate))
  }
  const result = normalize(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'tiers')))
  if (!result) return null
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers)) return null
    const tiers = value.tiers.map((tier) => normalize(tier, true))
    if (tiers.some((tier) => !tier) || new Set(tiers.map((tier) => tier.inputTokensAbove)).size !== tiers.length) return null
    result.tiers = tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
  }
  return result
}

/** Models.dev v1 text rates: only explicit context tiers can be represented safely. */
export function publicTextRates(cost) {
  if (!isObject(cost)) return null
  const fields = ['input', 'output', 'cache_read', 'cache_write', 'input_audio', 'output_audio', 'reasoning', 'tiers', 'context_over_200k']
  if (Object.keys(cost).some((key) => !fields.includes(key))) return null
  if (cost.reasoning !== undefined && cost.reasoning !== cost.output) return null
  const convert = (entry, tier = false) => {
    if (!isObject(entry)) return null
    const allowed = ['input', 'output', 'cache_read', 'cache_write', ...(tier ? ['tier'] : [])]
    if (tier && Object.keys(entry).some((key) => !allowed.includes(key))) return null
    if (tier && (!isObject(entry.tier) || entry.tier.type !== 'context'
      || Object.keys(entry.tier).some((key) => !['type', 'size'].includes(key)))) return null
    return {
      input: entry.input, output: entry.output,
      ...(entry.cache_read !== undefined ? { cacheRead: entry.cache_read } : {}),
      ...(entry.cache_write !== undefined ? { cacheWrite: entry.cache_write } : {}),
      ...(tier ? { inputTokensAbove: entry.tier.size } : {}),
    }
  }
  if (cost.tiers !== undefined && !Array.isArray(cost.tiers)) return null
  if (cost.context_over_200k !== undefined && (!Array.isArray(cost.tiers) || !cost.tiers.length)) return null
  const tiers = cost.tiers?.map((entry) => convert(entry, true))
  if (tiers?.some((entry) => !entry)) return null
  if (cost.context_over_200k !== undefined) {
    const legacy = convert(cost.context_over_200k)
    if (!legacy || !tiers.some((tier) => Object.entries(legacy).every(([key, value]) => tier[key] === value))) return null
  }
  return catalogRates({ ...convert(cost), ...(tiers ? { tiers } : {}) })
}
