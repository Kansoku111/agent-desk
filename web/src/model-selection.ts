import type { AppState, CatalogModel, TeamProvider } from './types'

export function providerReady(server: AppState, provider: string) {
  if (provider === 'openai-codex') return server.accounts.chatgpt.signedIn
  if (provider === 'anthropic') return server.accounts.claude.configured
  if (provider === 'deepseek-official') return server.accounts.deepseek.configured
  if (provider === 'opencode-go') return Boolean(server.accounts.opencodeGo?.configured)
  if (provider === 'local-llm') return Boolean(server.accounts.localLlm?.configured)
  return false
}

/** Explicit choices win; models possibly retired are hidden by default. */
export function isModelVisible(server: AppState, model: Pick<CatalogModel, 'value' | 'retired'>) {
  return server.settings.modelVisibility?.[model.value] ?? !model.retired
}

/** Keep the full catalog for settings and existing tasks; filter only new choices. */
export function visibleModels(server: AppState) {
  return server.catalog.models.filter((model) => isModelVisible(server, model))
}

const EXECUTION_ROUTES: Partial<Record<TeamProvider, string>> = { claudeApi: 'anthropic', gpt: 'openai-codex', deepseek: 'deepseek-official', opencodeGo: 'opencode-go', local: 'local-llm' }

/** Translate a picker value to EX's persisted provider/model pair, without changing routes. */
export function executionChildChoice(server: AppState, value: string): { provider: TeamProvider; model: string } | null {
  if (['claude:opus', 'claude:sonnet', 'claude:haiku'].includes(value)) return { provider: 'claude', model: value.slice(7) }
  const model = visibleModels(server).find((entry) => entry.value === value && !entry.retired && providerReady(server, entry.provider))
  const provider = model && (Object.keys(EXECUTION_ROUTES) as TeamProvider[]).find((key) => EXECUTION_ROUTES[key] === model.provider)
  return model && provider ? { provider, model: model.id } : null
}

/** EX restores exact choices only; never substitute a model or billing route. */
export function executionModelSelection(server: AppState, provider: string, leader: string, child: string) {
  const routes = EXECUTION_ROUTES as Record<string, string>
  const available = server.catalog.models.filter((entry) => !entry.retired && isModelVisible(server, entry) && providerReady(server, entry.provider))
  const leaderModels = available.filter((entry) => ['anthropic', 'openai-codex'].includes(entry.provider))
  const childModels = available.filter((entry) => entry.provider === routes[provider])
  return {
    leaderModels, childModels,
    leader: ['claude:opus', 'claude:sonnet'].includes(leader) || leaderModels.some((entry) => entry.value === leader) ? leader : '',
    model: (provider === 'claude' ? ['haiku', 'sonnet', 'opus'].includes(child) : childModels.some((entry) => entry.id === child)) ? child : '',
  }
}

/** A visible, connected model for a new task. Never fall back to a hidden choice. */
export function pickDefaultModel(server: AppState, current: string | null): string | null {
  const models = visibleModels(server)
  // Prefer available models over possibly retired ones explicitly shown by the user.
  const pick = (allowRetired: boolean) => {
    const usable = (value: string | null) => {
      const model = models.find((entry) => entry.value === value)
      return model && providerReady(server, model.provider) && (allowRetired || !model.retired) ? model : null
    }
    if (usable(current)) return current
    if (usable(server.settings.defaultModel)) return server.settings.defaultModel
    const preferred = ['["openai-codex","gpt-6.1-sol"]', '["openai-codex","gpt-5.5"]', '["anthropic","claude-sonnet-5-5"]', '["anthropic","claude-sonnet-5"]']
    for (const value of preferred) if (usable(value)) return value
    return models.find((model) => providerReady(server, model.provider) && (allowRetired || !model.retired))?.value ?? null
  }
  return pick(false) ?? pick(true)
}
