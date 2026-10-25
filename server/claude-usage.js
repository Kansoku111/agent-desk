import { scoreResponse } from './usage.js'
import { FAST_PRICE_MULTIPLIER } from './fast-mode.js'

/** These tools can spend tokens in separate logs; their absence is not evidence of zero use. */
export function untrackedClaudeCalls(message) {
  return (message?.content ?? []).filter((block) => block.type === 'tool_use' && block.id
    && /^(Agent|Task|Workflow)$|(?:^|__)subagent(?:_|$)/.test(block.name ?? '')).map((block) => block.id)
}

/** Claude input_tokens excludes both cache reads and cache creation. */
export function claudeUsage(message, pricing, time, saved) {
  const raw = message?.usage
  if (!raw || typeof raw !== 'object') return null
  const usage = {
    requests: 1, input: raw.input_tokens ?? 0, output: raw.output_tokens ?? 0,
    cacheRead: raw.cache_read_input_tokens ?? 0, cacheWrite: raw.cache_creation_input_tokens ?? 0,
    reasoning: raw.output_tokens_details?.thinking_tokens ?? 0, cost: null,
    models: message.model ? [`anthropic/${message.model}`] : [],
  }
  const hourWrites = raw.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const signature = JSON.stringify([message.model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, hourWrites, raw.speed])
  const rates = saved?.rates ?? pricing.get(usage.models[0])
  const recordedPricing = new Map([[usage.models[0], rates]])
  usage.score = saved?.signature === signature && saved.rates ? saved.score : scoreResponse(recordedPricing, usage.models[0], {
    inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
    cacheWrite1hTokens: hourWrites,
  }, time, raw.speed === 'fast' ? FAST_PRICE_MULTIPLIER : 1)
  return { usage, saved: { signature, score: usage.score, ...(rates ? { rates: saved?.rates ?? structuredClone(rates) } : {}) } }
}
