// The Provider API inventory describes protocol and context, not plan entitlement.
// Reasoning levels are a separate, pinned snapshot from the official CLI catalog.
import { readJson, writeJson } from './json-file.js'
import { isLocalModelId } from './local-llm.js'
import { COMMAND_CODE_REF } from './credentials.js'
import effortCatalog from './command-code-efforts.json' with { type: 'json' }

export const COMMAND_CODE_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models'
export const COMMAND_CODE_ROOT = 'https://api.commandcode.ai/provider'
export const COMMAND_CODE_CHAT = 'command-code'
export const COMMAND_CODE_MESSAGES = 'command-code-claude'
const MAX_AGE_MS = 6 * 60 * 60 * 1000
const MAX_MODELS = 2000
const MAX_CONTEXT = 100_000_000
const MAX_OUTPUT = 8192
// Reasoning consumes the output budget too; keep other models at the conservative default.
const DEEPSEEK_FLASH_OUTPUT = 65536
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
const HAIKU_55_OUTPUT = 128000

function usable(entry) {
  return entry && isLocalModelId(entry.id)
    && typeof entry.name === 'string' && entry.name.trim().length > 0 && entry.name.length <= 200
    && Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0 && entry.contextWindow <= MAX_CONTEXT
    && ['chat', 'messages'].includes(entry.endpoint)
}

/** Keep only the fields the official inventory supplies and the protocols dsh supports. */
export function parseCommandCodeModels(body) {
  if (!Array.isArray(body?.data) || body.data.length === 0 || body.data.length > MAX_MODELS) throw new Error('Command Code のモデル一覧を読めませんでした')
  const models = [], ids = new Set()
  let skipped = 0
  for (const entry of body.data) {
    const endpoints = entry?.supported_endpoints
    const endpoint = Array.isArray(endpoints) && endpoints.includes('/chat/completions') ? 'chat'
      : Array.isArray(endpoints) && endpoints.includes('/messages') ? 'messages' : null
    const model = { id: entry?.id, name: entry?.name, contextWindow: entry?.context_length, endpoint }
    if (!usable(model) || ids.has(model.id)) { skipped++; continue }
    ids.add(model.id)
    models.push(model)
  }
  if (!models.length) throw new Error('Command Code の対応モデルが一覧にありません')
  return { models, skipped }
}

/** The inventory has no effort metadata; unknown and explicitly unsupported models stay unselectable. */
export function commandCodeEfforts(id, endpoint) {
  const levels = Object.hasOwn(effortCatalog.models, id) ? effortCatalog.models[id] : []
  // The CLI lists xhigh for Sonnet 4.6, but Anthropic's Messages API does not.
  // https://platform.claude.com/docs/en/build-with-claude/effort
  return endpoint === 'messages' && id === 'claude-sonnet-4-6' ? levels.filter((level) => level !== 'xhigh') : levels
}

/** The picker must contain each model's known levels, or an explicit empty state. */
export function matchesCommandCodeEfforts(models, effortsByModel) {
  return models.every(({ id, endpoint }) => {
    const expected = commandCodeEfforts(id, endpoint)
    const provider = endpoint === 'messages' ? COMMAND_CODE_MESSAGES : COMMAND_CODE_CHAT
    const entries = effortsByModel[JSON.stringify([provider, id])]
    if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.value !== 'string')) return false
    const actual = entries.map((entry) => entry.value).filter(Boolean).sort()
    return JSON.stringify(actual) === JSON.stringify([...expected].sort())
  })
}

/** Both fixed protocol routes use the user's key and the same Command Code account. */
export function commandCodeRoutes(models, { zdr = false, root = COMMAND_CODE_ROOT } = {}) {
  const routes = {}
  for (const [endpoint, provider, api, baseURL, displayName] of [
    ['chat', COMMAND_CODE_CHAT, 'openai-completions', root + '/v1', 'Command Code'],
    ['messages', COMMAND_CODE_MESSAGES, 'anthropic-messages', root, 'Command Code（Claude）'],
  ]) {
    const selected = models.filter((model) => usable(model) && model.endpoint === endpoint)
    if (!selected.length) continue
    routes[provider] = {
      displayName, api, baseURL, apiKeyEnv: COMMAND_CODE_REF,
      ...(zdr ? { headers: { 'x-cmd-zdr': '1' } } : {}),
      compat: endpoint === 'chat'
        ? { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, thinkingFormat: 'openai', maxTokensField: 'max_tokens' }
        : { forceAdaptiveThinking: true },
      defaultMaxTokens: MAX_OUTPUT,
      models: selected.map(({ id, name, contextWindow }) => {
        const levels = commandCodeEfforts(id, endpoint)
        const output = endpoint === 'chat' && id === 'deepseek/deepseek-v4.1-flash' ? DEEPSEEK_FLASH_OUTPUT
          : endpoint === 'messages' && id === 'claude-haiku-5-5' ? HAIKU_55_OUTPUT : MAX_OUTPUT
        return {
          id, name, contextWindow, maxTokens: Math.min(output, Math.max(1, Math.floor(contextWindow / 4))),
          input: ['text'], reasoningEfforts: levels.length ? Object.fromEntries(levels.map((level) => [level, level])) : false,
        }
      }),
    }
  }
  return routes
}

/** Refreshes are serialized; bad responses leave the last verified inventory intact. */
export class CommandCodeModels {
  constructor({ file, fetchImpl = fetch }) {
    Object.assign(this, { file, fetchImpl })
    this.models = []
    this.checkedAt = null
    this.skipped = 0
    this.failed = false
    this.queue = Promise.resolve()
  }

  async load() {
    const saved = await readJson(this.file, null)
    if (Array.isArray(saved?.models) && saved.models.length > 0 && saved.models.length <= MAX_MODELS
      && saved.models.every(usable) && new Set(saved.models.map((model) => model.id)).size === saved.models.length
      && Number.isFinite(saved.checkedAt)) {
      this.models = saved.models.map(({ id, name, contextWindow, endpoint }) => ({ id, name, contextWindow, endpoint }))
      this.checkedAt = saved.checkedAt
      this.skipped = Number.isSafeInteger(saved.skipped) && saved.skipped >= 0 ? saved.skipped : 0
    }
    return this
  }

  refresh({ maxAgeMs = MAX_AGE_MS } = {}) {
    const task = this.queue.then(async () => {
      if (!this.failed && this.checkedAt && Date.now() - this.checkedAt < maxAgeMs) return false
      const before = JSON.stringify(this.models)
      try {
        // This public endpoint does not authenticate: never send the user's key.
        const response = await this.fetchImpl(COMMAND_CODE_MODELS_URL, { redirect: 'error', signal: AbortSignal.timeout(8000) })
        if (!response.ok) throw new Error('model list unavailable')
        const { models, skipped } = parseCommandCodeModels(await response.json())
        const checkedAt = Date.now()
        await writeJson(this.file, { models, skipped, checkedAt })
        Object.assign(this, { models, skipped, checkedAt, failed: false })
      } catch {
        this.failed = true
        return false
      }
      return before !== JSON.stringify(this.models)
    })
    this.queue = task.catch(() => false)
    return task
  }
}
