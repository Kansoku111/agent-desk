// Settings updates have one commit point: validate the entire patch, persist a
// candidate, publish it, then apply its effects. No application startup here.
import { CONTEXT_CHOICES, CONTEXT_PROVIDERS, INSTRUCTIONS_MAX, SUBAGENT_TOOLS } from './dsh-config.js'
import { UPDATE_CHANNELS } from './update-checks.js'
import { FAST_PROVIDERS, recordFastPeriod } from './fast-mode.js'
import { isLocalModelId, normalizeBaseUrl } from './local-llm.js'
import { isModelId } from './model-catalog.js'
import { PERMISSION_MODES } from './runtime.js'
import { mergeTeamConfig, TEAM_DEFAULTS } from './team-config.js'

// Idempotent startup migration: GPT fast is not offered by the official SIWC route.
export function migrateSettings(saved = {}) {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
    fastMode: {
      ...DEFAULT_SETTINGS.fastMode,
      ...saved.fastMode,
      'openai-codex': false,
    },
  }
}

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  defaultModel: null,
  defaultEffort: 'medium',
  defaultPermissionMode: 'workspace-write',
  workspaces: [],
  lastWorkspace: null,
  notifications: true,
  anthropicWorkspaceId: null,
  // Picker visibility only; existing tasks and runtime model definitions stay intact.
  modelVisibility: {},
  // Agent tools (desktop is opt-in and Windows only).
  browserTool: true,
  browserHeadless: false,
  desktopTool: false,
  imageTool: true,
  checkpoints: true,
  projectNames: {},
  projectColors: {},
  // null keeps each model's context size / leaves the fixed-model tool out.
  contextLimits: { 'openai-codex': null, anthropic: null },
  subagentModels: { 'openai-codex': null, anthropic: null },
  fastMode: { 'openai-codex': false, anthropic: false },
  fastModePeriods: { anthropic: [] },
  dshUpdateChannel: 'latest',
  modelAutoUpdate: true,
  remoteAccess: false,
  customInstructions: '',
  // A local OpenAI-compatible server and the models it listed (see local-llm.js).
  localLlm: { baseURL: null, models: [] },
  // 設定 → エージェントチーム (see team-config.js).
  agentTeams: structuredClone(TEAM_DEFAULTS),
}

const BOOLEAN_SETTINGS = [
  'notifications', 'browserTool', 'browserHeadless', 'desktopTool', 'imageTool',
  'checkpoints', 'modelAutoUpdate',
]
const TOOL_SETTINGS = ['browserTool', 'browserHeadless', 'desktopTool', 'imageTool']
const ENUM_SETTINGS = {
  theme: ['system', 'light', 'dark'],
  defaultPermissionMode: PERMISSION_MODES,
  dshUpdateChannel: UPDATE_CHANNELS,
}
const owns = (object, key) => Object.hasOwn(object, key)

function assertRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${name} はオブジェクトで指定してください`)
  }
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`${name} は boolean で指定してください`)
}

/**
 * Pure planning; `now` is supplied by the service for fast-mode billing periods.
 * Only requested fields are validated, so older saved settings need no migration.
 * Unrecognized fields/providers stay ignored, as in the original RPC handler.
 */
export function planSettingsUpdate(current, patch, now) {
  assertRecord(patch, 'patch')
  const next = { ...current }
  const effects = { homePatch: false, fastMode: false, modelCatalog: false, restart: false, channel: false, modelCheck: false }

  if (owns(patch, 'modelVisibility')) {
    assertRecord(patch.modelVisibility, 'modelVisibility')
    for (const [value, visible] of Object.entries(patch.modelVisibility)) {
      if (!value.trim()) throw new Error('モデルの値は空にできません')
      assertBoolean(visible, 'modelVisibility の値')
    }
    // Merge per model on the commit queue, so rapid toggles / other windows
    // cannot replace one another's choices. ACP values are opaque strings.
    next.modelVisibility = { ...current.modelVisibility, ...patch.modelVisibility }
  }
  if (owns(patch, 'contextLimits')) {
    assertRecord(patch.contextLimits, 'contextLimits')
    next.contextLimits = { ...current.contextLimits }
    for (const provider of CONTEXT_PROVIDERS) {
      if (!owns(patch.contextLimits, provider)) continue
      const value = patch.contextLimits[provider]
      if (value !== null && !CONTEXT_CHOICES.includes(value)) throw new Error('選べないコンテキストサイズです')
      next.contextLimits[provider] = value
    }
    effects.homePatch = true
  }
  if (owns(patch, 'subagentModels')) {
    assertRecord(patch.subagentModels, 'subagentModels')
    next.subagentModels = { ...DEFAULT_SETTINGS.subagentModels, ...current.subagentModels }
    for (const provider of Object.keys(SUBAGENT_TOOLS)) {
      if (!owns(patch.subagentModels, provider)) continue
      const value = patch.subagentModels[provider]
      if (value !== null && !isModelId(value)) throw new Error('使えないモデル ID です')
      next.subagentModels[provider] = value
    }
    effects.homePatch = true
  }
  if (owns(patch, 'customInstructions')) {
    const text = patch.customInstructions
    if (typeof text !== 'string') throw new Error('指示は文字列で指定してください')
    if (text.length > INSTRUCTIONS_MAX) throw new Error(`指示は ${INSTRUCTIONS_MAX.toLocaleString()} 文字までです`)
    next.customInstructions = text
    effects.homePatch = true
  }
  let localChanged = false
  if (owns(patch, 'localLlm')) {
    const value = patch.localLlm
    assertRecord(value, 'localLlm')
    const baseURL = value.baseURL === null ? null : normalizeBaseUrl(value.baseURL)
    if (!Array.isArray(value.models) || value.models.length > 100) throw new Error('localLlm.models は 100 件までの配列で指定してください')
    const models = value.models.map((model) => {
      if (!isLocalModelId(model?.id)) throw new Error('使えないモデル ID です')
      const contextWindow = model.contextWindow
      if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow <= 0)) throw new Error('contextWindow は正の整数で指定してください')
      return contextWindow ? { id: model.id, contextWindow } : { id: model.id }
    })
    next.localLlm = baseURL ? { baseURL, models } : { baseURL: null, models: [] }
    localChanged = true
  }
  if (owns(patch, 'agentTeams')) {
    // Read at a team's next launch or child; nothing restarts.
    next.agentTeams = mergeTeamConfig(current.agentTeams, patch.agentTeams)
  }
  if (owns(patch, 'fastMode')) {
    assertRecord(patch.fastMode, 'fastMode')
    next.fastMode = { ...DEFAULT_SETTINGS.fastMode, ...current.fastMode }
    for (const provider of FAST_PROVIDERS) {
      if (!owns(patch.fastMode, provider)) continue
      assertBoolean(patch.fastMode[provider], `fastMode.${provider}`)
      if (provider === 'openai-codex' && patch.fastMode[provider]) throw new Error('GPT fast mode is unavailable on the official SIWC route')
      next.fastMode[provider] = patch.fastMode[provider]
    }
    if (!Number.isFinite(now)) throw new Error('fastMode の記録時刻が不正です')
    next.fastModePeriods = {
      ...current.fastModePeriods,
      anthropic: recordFastPeriod(current.fastModePeriods?.anthropic, next.fastMode.anthropic, now),
    }
    effects.fastMode = true
  }
  for (const key of BOOLEAN_SETTINGS) {
    if (!owns(patch, key)) continue
    assertBoolean(patch[key], key)
    next[key] = patch[key]
  }
  for (const [key, values] of Object.entries(ENUM_SETTINGS)) {
    if (!owns(patch, key)) continue
    if (!values.includes(patch[key])) throw new Error(`${key} の値が不正です`)
    next[key] = patch[key]
  }
  // Model selections are ACP's opaque strings, not bare model IDs. Effort
  // values also come from the catalog, so do not hard-code a model's levels.
  for (const key of ['defaultModel', 'lastWorkspace', 'defaultEffort']) {
    if (!owns(patch, key)) continue
    if (typeof patch[key] !== 'string' && !(key !== 'defaultEffort' && patch[key] === null)) {
      throw new Error(`${key} は文字列${key === 'defaultEffort' ? '' : 'または null'}で指定してください`)
    }
    next[key] = patch[key]
  }

  effects.restart = TOOL_SETTINGS.some((key) => next[key] !== current[key])
  effects.channel = next.dshUpdateChannel !== current.dshUpdateChannel
  effects.modelCatalog = (next.modelAutoUpdate !== false) !== (current.modelAutoUpdate !== false)
  effects.homePatch ||= effects.modelCatalog
  effects.modelCheck = effects.modelCatalog && next.modelAutoUpdate !== false
  // The local route joins the catalog signature and the home patch; it fetches nothing.
  if (localChanged) {
    effects.modelCatalog = true
    effects.homePatch = true
  }
  return { settings: next, effects }
}

/**
 * Dependency-injected settings.update service. saveSettings may return a
 * decorated candidate (e.g. project colors), but must not mutate live settings.
 * publishSettings synchronously installs and announces that saved snapshot.
 * updateModelCatalog must defer home-patch/restart work and return restartRequired.
 * The queue covers effects as well as persistence; failed requests don't poison it.
 * Effects failing after commit cannot roll back the already published settings.
 */
export function createSettingsService({
  getSettings, saveSettings, publishSettings,
  applyHomePatch = () => false, applyFastMode = () => {},
  updateModelCatalog = () => ({ restartRequired: false }), restartRuntimesWhenIdle = () => {},
  onChannelChange = () => {}, checkModelUpdate = () => {}, onBackgroundError = () => {}, now = Date.now,
}) {
  let pending = Promise.resolve()
  // Other settings mutators must read and change live state inside this work,
  // not before enqueueing. Work must not await a nested run/update on this queue.
  const run = (work) => {
    const operation = pending.then(work)
    pending = operation.catch(() => {})
    return operation
  }
  const launch = (check) => {
    try {
      Promise.resolve(check()).catch(onBackgroundError)
    } catch (error) {
      onBackgroundError(error)
    }
  }
  return {
    run,
    async update(patch) {
      // Capture a caller-owned patch before it waits, but plan against the most
      // recent successful commit, not the state when the request was enqueued.
      assertRecord(patch, 'patch')
      const captured = structuredClone(patch)
      return run(async () => {
        const { settings: candidate, effects } = planSettingsUpdate(getSettings(), captured, now())
        const saved = await saveSettings(candidate) ?? candidate
        publishSettings(saved)

        if (effects.fastMode) await applyFastMode()
        let restart = effects.restart
        if (effects.modelCatalog) {
          const result = await updateModelCatalog()
          restart ||= Boolean(result?.restartRequired)
        }
        if (effects.homePatch) {
          const patched = await applyHomePatch()
          restart ||= Boolean(patched)
        }
        if (restart) await restartRuntimesWhenIdle()
        // These checks retain their background behavior. A later network fetch
        // may legitimately require another catalog refresh after this commit.
        if (effects.channel) onChannelChange()
        if (effects.modelCheck) launch(checkModelUpdate)
        return { settings: saved }
      })
    },
  }
}
