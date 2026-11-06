// OpenScale's documented DeepSeek Harness configuration. Limit the initial
// catalog to the two standard IDs; fast variants are separately billed.
import { OPENSCALE_REF } from './credentials.js'

// The endpoint accepts none/minimal/low/medium/high/xhigh/max/ultra for both
// models (400 otherwise), but accepting a value is not the same as acting on it.
// GLM: OpenScale documents two levels, and medium runs as high.
// DeepSeek: measured on 2026-11-06 with a counting problem, two samples per level,
// output tokens low 1.6-2.1k < high 2.8-3.2k < max 4.3-6.1k. xhigh matched low and
// medium was not separable from low, so neither is offered. ultra never finished
// within 150 s and was not measured. Chat Completions was tried too: its levels did
// not order at all, so the protocol OpenScale tested with dsh stays.
const DEEPSEEK_EFFORTS = { low: 'low', high: 'high', max: 'max' }
const GLM_EFFORTS = { low: 'low', high: 'high' }

export function openscaleRoute() {
  return {
    displayName: 'OpenScale', api: 'anthropic-messages',
    baseURL: 'https://api.openscale.so/anthropic', apiKeyEnv: OPENSCALE_REF,
    // Adaptive thinking carries the chosen effort in output_config.
    compat: { forceAdaptiveThinking: true },
    models: [
      { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1048568, maxTokens: 32768, input: ['text', 'image'], reasoningEfforts: { ...DEEPSEEK_EFFORTS } },
      { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 1048576, maxTokens: 32768, input: ['text', 'image'], reasoningEfforts: { ...GLM_EFFORTS } },
    ],
  }
}
