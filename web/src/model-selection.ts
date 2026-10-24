import type { AppState, CatalogModel } from './types'

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
