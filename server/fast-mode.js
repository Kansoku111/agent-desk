// Fast mode: the same model, served faster at a higher price.
//
// - Claude: `speed: "fast"` under the `fast-mode-2026-02-01` beta (research
//   preview, Claude API only). Opus 5.5, Opus 5 and Opus 4.8 take it; every
//   token type costs twice the standard rate.
// - GPT: unavailable on official SIWC; priority was measured to return default.
//   Historical provider keys are retained for saved model/settings compatibility.
//
// dsh does not pass either field to pi-ai, so a module hook inside each dsh
// process (fast-mode-hook.js) adds them to the request body. It reads the
// state file written here on every request, so a switch applies to the next
// model request without restarting dsh.
import { writeJson } from './json-file.js'

export const FAST_PROVIDERS = ['anthropic', 'openai-codex']
export const CLAUDE_FAST_BETA = 'fast-mode-2026-02-01'
export const CLAUDE_FAST_NOTE = '最大 2.5 倍速、料金は 2 倍'
/** Claude models that accept `speed: "fast"`. */
export const CLAUDE_FAST_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']
/** Fast mode bills every Claude token type at this multiple of the standard rate. */
export const FAST_PRICE_MULTIPLIER = 2

/**
 * Models that offer fast mode, with a short note, by provider.
 * @param {Record<string, { fast?: string | null }>} codexModels - the Codex
 *   model list as kept by codex-models.js.
 */
export function fastModels(codexModels = {}) {
  // SIWC currently ignores priority and returns default: GPT fast is unavailable.
  const codex = {}
  return {
    anthropic: Object.fromEntries(CLAUDE_FAST_MODELS.map((id) => [id, CLAUDE_FAST_NOTE])),
    'openai-codex': codex,
  }
}

/** What the hook in each dsh process reads: per provider, whether fast mode is on and for which models. */
export function fastModeState(enabled, models) {
  return Object.fromEntries(FAST_PROVIDERS.map((provider) => [provider, {
    enabled: provider === 'anthropic' && Boolean(enabled?.[provider]),
    models: Object.keys(models?.[provider] ?? {}),
  }]))
}

export function writeFastModeState(file, enabled, models) {
  return writeJson(file, fastModeState(enabled, models))
}

/**
 * The request body with fast mode applied, or undefined to send it unchanged.
 * @param {object} payload - the body pi-ai built (Anthropic Messages params or a Codex Responses body).
 * @param {{ api: string, provider: string, id: string }} model - the pi-ai model.
 * @param {ReturnType<typeof fastModeState> | null} state
 */
export function applyFastMode(payload, model, state) {
  const entry = state?.[model?.provider]
  if (!payload || !entry?.enabled || !entry.models?.includes(model.id)) return undefined
  if (model.api === 'anthropic-messages') {
    return { ...payload, speed: 'fast', betas: [...new Set([...(payload.betas ?? []), CLAUDE_FAST_BETA])] }
  }
  return undefined
}

/**
 * Records a switch in the periods Claude fast mode was on, so usage logged
 * then is priced at the fast rate. Each period is `[start, end | null]`.
 * @returns {[number, number | null][]} the new list.
 */
export function recordFastPeriod(periods = [], enabled, now = Date.now()) {
  const list = periods.map((period) => [...period])
  const open = list.length > 0 && list[list.length - 1][1] === null
  if (enabled && !open) list.push([now, null])
  if (!enabled && open) list[list.length - 1][1] = now
  return list
}

/** Pricing data for usage.js: the fast-capable `provider/model` keys and when fast mode was on. */
export function fastPricing(periods = []) {
  return { models: CLAUDE_FAST_MODELS.map((id) => `anthropic/${id}`), periods }
}

/** The rate multiple for a response of `key` (`provider/model`) logged at `time`. */
export function fastMultiplier(fast, key, time) {
  if (!fast?.models?.includes(key) || typeof time !== 'number') return 1
  const on = fast.periods?.some(([start, end]) => time >= start && (end === null || time <= end))
  return on ? FAST_PRICE_MULTIPLIER : 1
}
