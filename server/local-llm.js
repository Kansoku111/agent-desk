// A local or self-hosted model server (Ollama, LM Studio, vLLM, llama.cpp)
// reached through its OpenAI-compatible Chat Completions endpoint. dsh serves
// it as one more pi-ai route; the user gives its URL, and the models it lists
// are kept in the settings so the route survives the server being offline.
import { LOCAL_LLM_REF } from './credentials.js'

/** The dsh provider route (and catalog provider) of the local server's models. */
export const LOCAL_PROVIDER = 'local-llm'

// Small models on modest machines: a window the server likely has, and room left for the reply.
const DEFAULT_CONTEXT = 32_768
const DEFAULT_MAX_TOKENS = 8_192
const MAX_MODELS = 100

/** The base URL as dsh takes it (`…/v1`, no trailing slash), or throws. */
export function normalizeBaseUrl(text) {
  let url
  try {
    url = new URL(String(text ?? '').trim())
  } catch {
    throw new Error('URL を入力してください（例: http://localhost:11434/v1）')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL は http:// か https:// で始めてください')
  if (url.username || url.password) throw new Error('URL に認証情報は含めないでください。キーは API キーの欄に入力します')
  url.search = ''
  url.hash = ''
  return url.href.replace(/\/+$/, '')
}

/** The first positive integer among a model entry's context fields (vLLM, LM Studio, llama.cpp, others). */
function contextOf(entry) {
  for (const value of [entry.context_length, entry.max_model_len, entry.context_window, entry.max_context_length, entry.meta?.n_ctx_train]) {
    if (Number.isInteger(value) && value > 0) return value
  }
  return null
}

/** The models a `GET /models` reply lists (`data` array or `models` array/map). */
export function parseModelList(body) {
  const raw = Array.isArray(body?.data) ? body.data
    : Array.isArray(body?.models) ? body.models
      : body?.models && typeof body.models === 'object' ? Object.entries(body.models).map(([id, entry]) => ({ ...entry, id }))
        : []
  const models = []
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.model ?? entry?.name
    if (!isLocalModelId(id) || models.some((model) => model.id === id)) continue
    const contextWindow = typeof entry === 'object' ? contextOf(entry) : null
    models.push(contextWindow ? { id, contextWindow } : { id })
    if (models.length >= MAX_MODELS) break
  }
  return models
}

// Local ids carry a tag or a path (qwen3:8b, org/model.gguf), unlike catalog ids.
const LOCAL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/

export function isLocalModelId(value) {
  return typeof value === 'string' && LOCAL_MODEL_ID.test(value)
}

/** Asks the server which models it serves; throws a message the settings screen shows. */
export async function discoverLocalModels(baseURL, key = null, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let response
  try {
    response = await fetchImpl(`${baseURL}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new Error(`${baseURL} に接続できませんでした。サーバーが起動しているか確認してください`)
  }
  if (response.status === 401 || response.status === 403) throw new Error('サーバーが認証を求めています。API キーを入力してください')
  if (!response.ok) throw new Error(`モデル一覧を取得できませんでした（HTTP ${response.status}）。URL が …/v1 で終わっているか確認してください`)
  let body
  try {
    body = await response.json()
  } catch {
    throw new Error('モデル一覧の応答を読めませんでした。OpenAI 互換の URL（…/v1）を指定してください')
  }
  const models = parseModelList(body)
  if (!models.length) throw new Error('サーバーにモデルがありません。先にモデルを読み込んでください（例: ollama pull qwen3）')
  return models
}

/** The settings' local server, with every field present. */
export function localLlmSettings(saved) {
  const baseURL = typeof saved?.baseURL === 'string' && saved.baseURL ? saved.baseURL : null
  const models = Array.isArray(saved?.models) ? saved.models.filter((model) => isLocalModelId(model?.id)) : []
  return { baseURL, models }
}

/**
 * The dsh route of the local server, or null when it has no models.
 * Keyless servers still get an Authorization header: pi-ai's Chat Completions
 * client refuses to send a request without one.
 */
export function localRoute(saved, { keyed = false } = {}) {
  const { baseURL, models } = localLlmSettings(saved)
  if (!baseURL || !models.length) return null
  return {
    displayName: 'ローカル LLM',
    api: 'openai-completions',
    baseURL,
    ...(keyed ? { apiKeyEnv: LOCAL_LLM_REF } : { headers: { authorization: 'Bearer local' } }),
    // Local servers speak the plain dialect: no `store`, no developer role, `max_tokens`.
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
    defaultContextWindow: DEFAULT_CONTEXT,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    retryPolicy: { mode: 'normal', maxRetries: 2 },
    models: models.map(({ id, contextWindow }) => ({
      id,
      name: id,
      input: ['text'],
      reasoningEfforts: false,
      ...(contextWindow ? { contextWindow, maxTokens: Math.min(DEFAULT_MAX_TOKENS, Math.max(1024, Math.floor(contextWindow / 4))) } : {}),
    })),
  }
}
