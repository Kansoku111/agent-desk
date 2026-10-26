// Settings updates have one commit point: validate the entire patch, persist a
// candidate, publish it, then apply its effects. No application startup here.
import { isDeepStrictEqual } from 'node:util'
import { CONTEXT_CHOICES, CONTEXT_PROVIDERS, INSTRUCTIONS_MAX, SUBAGENT_TOOLS } from './dsh-config.js'
import { UPDATE_CHANNELS } from './update-checks.js'
import { FAST_PROVIDERS, recordFastPeriod } from './fast-mode.js'
import { isLocalModelId, normalizeBaseUrl } from './local-llm.js'
import { isModelId } from './model-catalog.js'
import { PERMISSION_MODES } from './runtime.js'
import { mergeTeamConfig, TEAM_DEFAULTS } from './team-config.js'
import { parsePlaybooks, parsePolicies } from './team-playbooks.js'
import { isUsdJpyRate } from '../shared/usage-score.js'

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
  usageCurrency: 'USD',
  usdJpyRate: null,
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
  subagentsEnabled: true,
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
  // What team leaders read (see team-playbooks.js): a team's chosen policy, and the playbooks by name.
  teamPolicies: [],
  teamPlaybooks: [],
}

const BOOLEAN_SETTINGS = [
  'notifications', 'browserTool', 'browserHeadless', 'desktopTool', 'imageTool',
  'checkpoints', 'modelAutoUpdate', 'subagentsEnabled',
]
const TOOL_SETTINGS = ['browserTool', 'browserHeadless', 'desktopTool', 'imageTool']
const ENUM_SETTINGS = {
  theme: ['system', 'light', 'dark'],
  usageCurrency: ['USD', 'JPY'],
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
  const next = structuredClone(current)
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
  // Read at a leader's next launch (a playbook, when the leader opens it); nothing restarts.
  for (const [key, parse, label] of [
    ['teamPolicies', parsePolicies, '方針'],
    ['teamPlaybooks', parsePlaybooks, 'プレイブック'],
  ]) {
    if (!owns(patch, key)) continue
    // Compare on the commit queue, not on receipt: another window's save may
    // still be in flight. Require a base so older clients cannot bypass this.
    const base = patch.teamGuidesBase?.[key]
    if (!Array.isArray(base) || !isDeepStrictEqual(base, current[key] ?? [])) {
      throw new Error(`${label}が別の画面で更新されたか、編集元を確認できません。編集内容を控え、「元に戻す」で最新の内容を読み直してください。`)
    }
    next[key] = parse(patch[key])
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
  if (owns(patch, 'usdJpyRate')) {
    if (patch.usdJpyRate !== null && !isUsdJpyRate(patch.usdJpyRate)) throw new Error('1 USDあたりの円は正の数で指定してください')
    next.usdJpyRate = patch.usdJpyRate
  }
  if ((owns(patch, 'usageCurrency') || owns(patch, 'usdJpyRate'))
    && next.usageCurrency === 'JPY' && !isUsdJpyRate(next.usdJpyRate)) {
    throw new Error('JPY表示には1 USDあたりの円を設定してください')
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
  effects.homePatch ||= effects.modelCatalog || next.subagentsEnabled !== current.subagentsEnabled
  effects.modelCheck = effects.modelCatalog && next.modelAutoUpdate !== false
  // The local route joins the catalog signature and the home patch; it fetches nothing.
  if (localChanged) {
    effects.modelCatalog = true
    effects.homePatch = true
  }
  return { settings: next, effects }
}

// Only wrap effects after a successful settings commit, never the save itself.
export async function afterSettingsCommit(work) {
  try {
    return await work()
  } catch (cause) {
    const error = new Error(`設定は保存済みですが、反映処理に失敗しました: ${cause?.message ?? cause}`, { cause })
    error.settingsCommitted = true
    throw error
  }
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
  // Only settings commits own this queue. Candidate creation belongs inside it,
  // never at request receipt; nested update/mutate waits would deadlock.
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
  // The caller must install the saved snapshot synchronously before announcing it.
  // Keep the existing RPC error shape (message), but make a committed failure
  // explicit both to callers and in the message sent across the wire.
  const commit = async (candidate, { notify = true, afterCommit = () => {} } = {}) => {
    const saved = await saveSettings(candidate) ?? candidate
    await afterSettingsCommit(async () => {
      publishSettings(saved, { notify })
      await afterCommit(saved)
    })
    return { settings: saved }
  }
  return {
    // Trusted internal mutators validate and edit a detached draft on this queue.
    // Never call update/mutate from inside work or afterCommit.
    mutate(work, options) {
      return run(async () => {
        const candidate = structuredClone(getSettings())
        // Explicit false means no change, decided against the latest state on
        // this queue. Skip persistence, publication and effects in that case.
        if (await work(candidate) === false) return { settings: getSettings() }
        // Do not retain references supplied by an external resource (e.g. a team).
        return commit(structuredClone(candidate), options)
      })
    },
    async update(patch) {
      // Capture a caller-owned patch before it waits, but plan against the most
      // recent successful commit, not the state when the request was enqueued.
      assertRecord(patch, 'patch')
      const captured = structuredClone(patch)
      return run(async () => {
        const { settings: candidate, effects } = planSettingsUpdate(structuredClone(getSettings()), captured, now())
        return commit(candidate, { afterCommit: async () => {
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
        } })
      })
    },
  }
}
