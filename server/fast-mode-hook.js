// Loaded into every dsh process with `node --import` (see runtime.js).
//
// pi-ai loads each API implementation lazily and calls the module's `stream`
// and `streamSimple` exports. For the two APIs fast mode covers (Anthropic
// Messages and Codex Responses), a module hook serves a stand-in that
// re-exports the real module, loaded under a distinct URL, and passes those
// two calls' options through `withFastMode`. That adds an `onPayload` step,
// the one request-body hook pi-ai keeps on both routes, which applies fast
// mode when the state file (`AGENT_DESK_FAST_MODE`) says so.
//
// The same stand-in also drops Anthropic's server-side model fallback. pi-ai's
// catalog lets Claude Fable answer from Claude Opus when Fable is busy
// (`compat.allowedFallbackModels`, sent as `fallbacks` plus a beta header), and
// dsh keeps catalog compat it does not let a profile change. Agent Desk does not
// show which model answered, so that would switch models without telling the
// user; a busy model fails and goes through the normal retry instead.
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { applyFastMode } from './fast-mode.js'
import { withSiwc } from './siwc-request.js'

const TARGET = /\/@earendil-works\/pi-ai\/dist\/api\/(?:anthropic-messages|openai-codex-responses|openai-responses)\.js$/
const REAL = 'agent-desk-real'

/** The stand-in module source for a wrapped pi-ai API module. */
export function wrapperSource(url) {
  const real = JSON.stringify(`${url}?${REAL}`)
  return [
    `import * as real from ${real}`,
    `import { withFastMode, withoutServerFallback } from ${JSON.stringify(import.meta.url)}`,
    `export * from ${real}`,
    'export const stream = (model, context, options) => { model = withoutServerFallback(model); return real.stream(model, context, withFastMode(options, model)) }',
    'export const streamSimple = (model, context, options) => { model = withoutServerFallback(model); return real.streamSimple(model, context, withFastMode(options, model)) }',
    '',
  ].join('\n')
}

export function isWrapped(url) {
  if (!url.startsWith('file:')) return false
  const { pathname, search } = new URL(url)
  return !search && TARGET.test(pathname)
}

const file = process.env.AGENT_DESK_FAST_MODE
let cached = { stamp: null, state: null }

/** The state file, re-read when it changed; a failed read keeps the last good state. */
function currentState() {
  if (!file) return null
  try {
    const stat = fs.statSync(file)
    const stamp = `${stat.mtimeMs}:${stat.size}`
    if (stamp !== cached.stamp) cached = { stamp, state: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {}
  return cached.state
}

/** The model without Anthropic's server-side fallback list; anything else is returned unchanged. */
export function withoutServerFallback(model) {
  if (!model?.compat || !Object.hasOwn(model.compat, 'allowedFallbackModels')) return model
  const { allowedFallbackModels, ...compat } = model.compat
  return { ...model, compat }
}

/** The stream options with fast mode's body step after any `onPayload` already set. */
export function withFastMode(options, model) {
  const previous = options?.onPayload
  const wrapped = {
    ...options,
    onPayload: async (payload, model) => {
      const changed = await previous?.(payload, model)
      return applyFastMode(changed ?? payload, model, currentState()) ?? changed
    },
  }
  return withSiwc(model, wrapped)
}

if (file || process.env.AGENT_DESK_SIWC_CREDENTIALS) {
  registerHooks({
    load(url, context, nextLoad) {
      if (!isWrapped(url)) return nextLoad(url, context)
      return { format: 'module', source: wrapperSource(url), shortCircuit: true }
    },
  })
}
