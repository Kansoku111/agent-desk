// Where each kind of task sends its subagents (settings.subagentRoutes).
//
// Three kinds of task can start subagents: DSH (dsh's own tasks), CL (Claude
// Code) and GP (Codex). Each kind has one route: the kind of task its subagents
// run as, with a model and a reasoning level. By default a kind sends them to
// itself. A route to another kind goes through the bridge MCP
// (subagent-bridge-mcp.js) and replaces the task's own delegation tools.
import { SUBAGENT_TOOLS } from './dsh-config.js'
import { isLocalModelId } from './local-llm.js'

export const PARENTS = ['dsh', 'cl', 'gp']
export const CLAUDE_PREFIX = 'claude:'
export const CODEX_PREFIX = 'codex:'
/** A Claude Code alias (sonnet[1m]) or full model name, as `claude --model` takes it. */
const CLAUDE_ID = /^[a-z0-9][a-z0-9.\-[\]]{0,79}$/i
const CODEX_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i

const owns = (value, key) => Object.hasOwn(value, key)

export const defaultRoutes = () => Object.fromEntries(PARENTS.map((parent) => [parent, { target: parent, model: null, effort: null }]))

/** `{ provider, model }` of a DSH model value (`["provider","id"]`), or null when it cannot be a subagent. */
export function dshModelParts(value) {
  let parts
  try {
    parts = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parts) || parts.length < 2 || typeof parts[0] !== 'string' || typeof parts[1] !== 'string') return null
  return SUBAGENT_TOOLS[parts[0]] && isLocalModelId(parts[1]) ? { provider: parts[0], model: parts[1] } : null
}

const MODEL_CHECK = {
  dsh: (value) => dshModelParts(value) !== null,
  cl: (value) => value.startsWith(CLAUDE_PREFIX) && CLAUDE_ID.test(value.slice(CLAUDE_PREFIX.length)),
  gp: (value) => value.startsWith(CODEX_PREFIX) && CODEX_ID.test(value.slice(CODEX_PREFIX.length)),
}

/** One route, checked; throws the message the settings screen shows. */
export function validateRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('サブエージェントの設定が不正です')
  const { target, model = null, effort = null } = route
  if (!PARENTS.includes(target)) throw new Error('サブエージェントの種類が不正です')
  if (model !== null && (typeof model !== 'string' || model.length > 1000 || !MODEL_CHECK[target](model))) throw new Error('この種類では使えないモデルです')
  if (effort !== null && (typeof effort !== 'string' || effort.length > 100)) throw new Error('使えない推論レベルです')
  return { target, model, effort: model === null ? null : effort }
}

/**
 * The routes after a patch of `{ dsh?, cl?, gp? }`, each a partial route. A
 * changed `target` clears a model the patch does not replace, because a model
 * belongs to one kind.
 */
export function mergeRoutes(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('subagentRoutes はオブジェクトで指定してください')
  const next = { ...defaultRoutes(), ...current }
  for (const parent of PARENTS) {
    if (!owns(patch, parent)) continue
    const change = patch[parent]
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('サブエージェントの設定が不正です')
    const base = next[parent]
    const moved = owns(change, 'target') && change.target !== base.target
    next[parent] = validateRoute({
      target: owns(change, 'target') ? change.target : base.target,
      model: owns(change, 'model') ? change.model : moved ? null : base.model,
      effort: owns(change, 'effort') ? change.effort : moved ? null : base.effort,
    })
  }
  return next
}

/**
 * Routes for settings saved before they existed, which kept a model per
 * provider (`subagentModels`). A GPT model keeps working where it did: DSH
 * pinned it, Claude Code ran it in a headless dsh. Where both providers were
 * set, GPT wins: its route is covered by the ChatGPT subscription, so no
 * billing route changes without the user knowing.
 */
export function routesFromLegacy(saved) {
  const routes = defaultRoutes()
  const models = saved?.subagentModels ?? {}
  const efforts = saved?.subagentEfforts ?? {}
  const provider = ['openai-codex', 'anthropic'].find((entry) => typeof models[entry] === 'string' && models[entry])
  if (!provider) return routes
  const route = { target: 'dsh', model: JSON.stringify([provider, models[provider]]), effort: efforts[provider] ?? null }
  routes.dsh = route
  // Claude Code only ever had the GPT route.
  if (provider === 'openai-codex') routes.cl = { ...route }
  try {
    for (const parent of PARENTS) validateRoute(routes[parent])
  } catch {
    return defaultRoutes()
  }
  return routes
}

/** The saved routes, or those a legacy save implies; never throws on a damaged value. */
export function savedRoutes(saved) {
  if (!saved?.subagentRoutes) return routesFromLegacy(saved)
  const routes = defaultRoutes()
  for (const parent of PARENTS) {
    try {
      routes[parent] = validateRoute(saved.subagentRoutes[parent])
    } catch {}
  }
  return routes
}

/**
 * What a kind of task gets for its route.
 * - `native`: its own delegation tools (dsh `subagent`, Claude Code's Agent).
 *   `pinned` adds a DSH tool on the route's model; `claudeModel` makes Claude
 *   Code's subagents run on a model.
 * - `bridge`: the bridge MCP to `target`, and no native tools. Codex has no
 *   native tools (its multi-agent feature is off), so it always bridges.
 * A route to another kind without a model is not set up yet, so the task keeps
 * its own tools.
 */
export function routePlan(parent, route) {
  const own = route.target === parent
  if (!own && !route.model) return { mode: 'native' }
  if (parent === 'gp' || !own) return { mode: 'bridge', target: route.target, model: route.model, effort: route.effort }
  if (!route.model) return { mode: 'native' }
  if (parent === 'dsh') return { mode: 'native', pinned: { ...dshModelParts(route.model), effort: route.effort } }
  return { mode: 'native', claudeModel: route.model.slice(CLAUDE_PREFIX.length) }
}
