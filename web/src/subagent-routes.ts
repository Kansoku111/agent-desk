import type { Settings } from './types'
import type { RouteParent, SubagentRoute } from './types'

export type { RouteParent, SubagentRoute }

export const ROUTE_KINDS: { id: RouteParent; name: string }[] = [
  { id: 'dsh', name: 'DSH' },
  { id: 'cl', name: 'Claude Code' },
  { id: 'gp', name: 'GP' },
]

/** DSH providers a subagent can run on (server/dsh-config.js SUBAGENT_TOOLS); the server refuses any other. */
const DSH_PROVIDERS = ['openai-codex', 'anthropic', 'deepseek-official', 'opencode-go', 'command-code', 'command-code-claude', 'openscale', 'local-llm']

export const DROP_TYPE = 'application/x-agent-desk-subagent'

interface Group { id: string; models: { value: string; name: string }[] }

/** The groups of the model menu that a route to `target` can use; a model belongs to one kind of task. */
export function targetGroups<T extends Group>(groups: T[], target: RouteParent): T[] {
  const ids = target === 'cl' ? ['claude-code'] : target === 'gp' ? ['codex'] : DSH_PROVIDERS
  return groups.filter((group) => ids.includes(group.id))
}

/** Routes as the settings hold them; an older save without routes sends every kind to itself. */
export function routesOf(settings: Pick<Settings, 'subagentRoutes'>): Record<RouteParent, SubagentRoute> {
  return settings.subagentRoutes ?? {
    dsh: { target: 'dsh', model: null, effort: null },
    cl: { target: 'cl', model: null, effort: null },
    gp: { target: 'gp', model: null, effort: null },
  }
}

/** A subagent on the Claude API is billed per token, which a ChatGPT or Claude Code user may not expect. */
export function usesClaudeApi(settings: Pick<Settings, 'subagentRoutes' | 'subagentsEnabled'>) {
  if (settings.subagentsEnabled === false) return false
  return Object.values(routesOf(settings)).some((route) => route.target === 'dsh' && route.model?.startsWith('["anthropic",'))
}
