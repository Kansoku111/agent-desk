// Settings of the agent teams (設定 → エージェントチーム): who leads (Claude
// Code or a dsh task, on which model), and which model each provider's
// "low" and "mid" tier means, or a list of directly selected child models.
import { assertToolMode } from './ptc.js'

/**
 * Teams' children by provider: GPT, Claude (API), DeepSeek, OpenCode Go and
 * the local server run as dsh tasks (on the ChatGPT subscription, the user's
 * Anthropic, DeepSeek, OpenCode Go and Command Code API keys, and their own machine), Claude
 * as a Claude Code task.
 */
export const TEAM_PROVIDERS = ['gpt', 'codex', 'claude', 'claudeApi', 'deepseek', 'opencodeGo', 'commandCode', 'commandCodeClaude', 'local']
/** Providers that can lead a team. */
export const LEADER_PROVIDERS = TEAM_PROVIDERS
const EXTRA_DSH_LEADERS = ['codex', 'claudeApi', 'deepseek', 'opencodeGo', 'commandCode', 'commandCodeClaude', 'local']
/**
 * Providers removed from the app, with their names. Saved settings and teams that still use one keep
 * it as saved, so its work is never moved to another provider or billing route. Picking one anew is
 * refused, and a team that uses one cannot run until its choices name other providers
 * (`assertNoRetiredProviders`).
 */
export const RETIRED_PROVIDERS = { openscale: 'OpenScale' }
export const TEAM_TIERS = ['low', 'mid']
export const PROVIDER_NAMES = { gpt: 'GPT', codex: 'Codex', claude: 'Claude', claudeApi: 'Claude（API）', deepseek: 'DeepSeek', opencodeGo: 'OpenCode Go', commandCode: 'Command Code', commandCodeClaude: 'Command Code（Claude）', local: 'ローカル LLM' }
export const MAX_CHILDREN_LIMIT = 12
export const MAX_TEAM_MODELS = 12
export const TEAM_MODEL_MODES = ['tiers', 'free']

/** A Claude Code model alias (opus) or full name (claude-haiku-5-5), as `claude --model` takes it. */
const CLAUDE_MODEL = /^[a-z0-9][a-z0-9.\-[\]]{0,79}$/i
/** A dsh model id (gpt-5.6-luna, deepseek-v4-pro). */
const DSH_MODEL = /^[a-z0-9][a-z0-9._-]{0,79}$/i
/** A local server's model id, which may carry a tag or a path (qwen3:8b). */
const LOCAL_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/
/** Reasoning levels are the catalog's (or `claude --effort`'s) words. */
const EFFORT = /^[a-z]{1,16}$/
/** Providers whose model IDs are a local server's kind (tags and paths allowed). */
const LOCAL_MODEL_PROVIDERS = ['local', 'commandCode', 'commandCodeClaude']
const modelPattern = (provider) => (provider === 'claude' ? CLAUDE_MODEL : LOCAL_MODEL_PROVIDERS.includes(provider) ? LOCAL_MODEL : DSH_MODEL)

const isRetired = (provider) => Object.hasOwn(RETIRED_PROVIDERS, provider)
const retiredError = (names) => new Error(`${names.map((name) => RETIRED_PROVIDERS[name]).join('・')} は廃止されました。別のプロバイダーを選んでください`)
/** Two saved choices name the same provider, model and reasoning level. */
const sameChoice = (a, b) => a?.provider === b?.provider && a?.model === b?.model && (a?.effort ?? null) === (b?.effort ?? null)

export const TEAM_DEFAULTS = {
  /** Claude Code and GPT retain their old fields; other dsh leaders use dshLeader. */
  leaderProvider: 'claude',
  toolMode: 'ptc',
  // The default applies to new teams; modelMode is the mode of this team.
  defaultModelMode: 'tiers',
  modelMode: 'tiers',
  freeModels: [],
  // null: Claude Code's own default.
  leader: { model: 'opus', effort: null },
  // null model: GPT's mid, low, then the first selected GPT model in free mode.
  gptLeader: { model: null, effort: 'high' },
  dshLeader: null,
  leaderFallback: '',
  fallbackEffort: '',
  // The leader runs with --permission-mode bypassPermissions (children always do).
  leaderBypass: true,
  // Every provider is off until the user turns it on (a team starts with at least one on), so
  // nothing runs, bills or signs in without a choice. A tier that is not `enabled` is not
  // offered to the leader.
  // GPT: the ChatGPT subscription.
  gpt: { enabled: false, low: { enabled: true, model: null, effort: 'medium' }, mid: { enabled: true, model: null, effort: 'high' } },
  // Codex CLI uses its own account and model list, separate from dsh GPT.
  codex: { enabled: false, low: { enabled: true, model: null, effort: 'medium' }, mid: { enabled: true, model: null, effort: 'high' } },
  // Claude Code with the user's own, explicitly confirmed auth/billing mode.
  claude: { enabled: false, low: { enabled: true, model: 'haiku', effort: null }, mid: { enabled: true, model: 'sonnet', effort: null } },
  // Claude through dsh and their Anthropic API key, billed per token.
  // Any credits are subject to the user's provider plan conditions.
  claudeApi: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  // Billed per token to their DeepSeek API key.
  deepseek: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  // Their OpenCode Go subscription (open models, with usage limits instead of a per-token bill).
  opencodeGo: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  // Command Code Provider API routes share a key and the user's plan usage.
  commandCode: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  commandCodeClaude: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  // A model server on the user's machine or network (設定 → アカウント → ローカル LLM).
  local: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  maxChildren: 6,
  // Retired providers (RETIRED_PROVIDERS) that the saved settings still turn on. Empty for new settings.
  retiredProviders: [],
  // Reports that wait while the leader works reach it together, in one turn, instead of one turn each.
  batchReports: true,
  // Children start without the browser, desktop and image tools (a Claude child without its MCP
  // servers) unless the leader's `spawn` asks for them: smaller tool lists on every turn.
  leanChildren: false,
}

/** The switches of 設定 → エージェントチーム that are not a team's own choices. */
const SWITCHES = ['leaderBypass', 'batchReports', 'leanChildren']

/** The saved team settings with every field present (older saves lack newer fields). */
export function teamConfig(saved) {
  const value = saved && typeof saved === 'object' ? saved : {}
  const tier = (provider, name) => ({ ...TEAM_DEFAULTS[provider][name], ...value[provider]?.[name] })
  const provider = (name) => ({
    enabled: value[name]?.enabled ?? TEAM_DEFAULTS[name].enabled, low: tier(name, 'low'), mid: tier(name, 'mid'),
  })
  return {
    // A retired leader is kept, not reset to Claude Code: resetting would move the team to another billing route.
    leaderProvider: LEADER_PROVIDERS.includes(value.leaderProvider) || isRetired(value.leaderProvider) ? value.leaderProvider : TEAM_DEFAULTS.leaderProvider,
    toolMode: value.toolMode ?? TEAM_DEFAULTS.toolMode,
    defaultModelMode: TEAM_MODEL_MODES.includes(value.defaultModelMode) ? value.defaultModelMode : 'tiers',
    modelMode: TEAM_MODEL_MODES.includes(value.modelMode) ? value.modelMode : 'tiers',
    freeModels: Array.isArray(value.freeModels) ? value.freeModels.map((model) => ({ ...model })) : [],
    leader: { ...TEAM_DEFAULTS.leader, ...value.leader },
    gptLeader: { ...TEAM_DEFAULTS.gptLeader, ...value.gptLeader },
    dshLeader: value.dshLeader && typeof value.dshLeader === 'object' ? { ...value.dshLeader } : null,
    leaderFallback: typeof value.leaderFallback === 'string' ? value.leaderFallback : '',
    fallbackEffort: typeof value.fallbackEffort === 'string' ? value.fallbackEffort : '',
    ...Object.fromEntries(SWITCHES.map((name) => [name, typeof value[name] === 'boolean' ? value[name] : TEAM_DEFAULTS[name]])),
    gpt: provider('gpt'),
    codex: provider('codex'),
    claude: provider('claude'),
    claudeApi: provider('claudeApi'),
    deepseek: provider('deepseek'),
    opencodeGo: provider('opencodeGo'),
    commandCode: provider('commandCode'),
    commandCodeClaude: provider('commandCodeClaude'),
    local: provider('local'),
    maxChildren: Number.isInteger(value.maxChildren) ? value.maxChildren : TEAM_DEFAULTS.maxChildren,
    retiredProviders: retiredOn(value),
  }
}

/**
 * The retired providers the saved settings still turn on. Settings saved before the removal kept
 * an `openscale` block with `enabled`; from then on the list is saved.
 */
function retiredOn(value) {
  if (Array.isArray(value.retiredProviders)) return [...new Set(value.retiredProviders.filter(isRetired))]
  return Object.keys(RETIRED_PROVIDERS).filter((name) => value[name]?.enabled === true)
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function choice(value, pattern, name) {
  if (value === null) return null
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${name} の値が不正です`)
  return value
}

/** A retired choice can only stay as it was saved: picking it anew is refused. */
function retainedChoice(entry, saved) {
  const kept = saved.find((item) => sameChoice(item, entry))
  if (!kept) throw retiredError([entry.provider])
  return { provider: kept.provider, model: kept.model, effort: kept.effort ?? null }
}

function pickFreeModel(entry) {
  if (!TEAM_PROVIDERS.includes(entry.provider)) throw new Error('子のモデルのプロバイダーが不正です')
  const model = choice(entry.model, modelPattern(entry.provider), '子のモデル')
  if (!model) throw new Error('子のモデルを選んでください')
  return { provider: entry.provider, model, effort: choice(entry.effort ?? null, EFFORT, '子の推論レベル') }
}

/**
 * Merges a settings patch into the team settings; throws on any invalid field.
 * Every provider may be off here (the saved settings start that way); a team
 * checks `assertChildrenOn` before it runs with them.
 */
export function mergeTeamConfig(current, patch) {
  if (!isRecord(patch)) throw new Error('agentTeams はオブジェクトで指定してください')
  const next = teamConfig(current)
  for (const name of ['defaultModelMode', 'modelMode']) {
    if (!Object.hasOwn(patch, name)) continue
    if (!TEAM_MODEL_MODES.includes(patch[name])) throw new Error('モデルの選び方は低中モードか自由モードで指定してください')
    next[name] = patch[name]
  }
  if (Object.hasOwn(patch, 'freeModels')) {
    if (!Array.isArray(patch.freeModels) || patch.freeModels.length > MAX_TEAM_MODELS) throw new Error(`子のモデルは ${MAX_TEAM_MODELS} 個まで選べます`)
    const saved = next.freeModels
    const seen = new Set()
    next.freeModels = patch.freeModels.map((entry) => {
      if (!isRecord(entry)) throw new Error('子のモデルのプロバイダーが不正です')
      const picked = isRetired(entry.provider) ? retainedChoice(entry, saved) : pickFreeModel(entry)
      const key = JSON.stringify([picked.provider, picked.model, picked.effort])
      if (seen.has(key)) throw new Error('同じモデルと推論レベルは複数選べません')
      seen.add(key)
      return picked
    })
  }
  if (Object.hasOwn(patch, 'toolMode')) {
    assertToolMode(patch.toolMode)
    next.toolMode = patch.toolMode
  }
  for (const name of ['leaderFallback', 'fallbackEffort']) {
    if (!Object.hasOwn(patch, name)) continue
    if (typeof patch[name] !== 'string' || patch[name].length > (name === 'leaderFallback' ? 1000 : 100)) throw new Error('フォールバック設定が不正です')
    next[name] = patch[name]
  }
  if (Object.hasOwn(patch, 'leader')) {
    if (!isRecord(patch.leader)) throw new Error('agentTeams.leader はオブジェクトで指定してください')
    if (Object.hasOwn(patch.leader, 'model')) next.leader.model = choice(patch.leader.model, CLAUDE_MODEL, 'リーダーのモデル')
    if (Object.hasOwn(patch.leader, 'effort')) next.leader.effort = choice(patch.leader.effort, EFFORT, 'リーダーの推論レベル')
  }
  if (Object.hasOwn(patch, 'leaderProvider')) {
    if (isRetired(patch.leaderProvider)) {
      if (patch.leaderProvider !== next.leaderProvider) throw retiredError([patch.leaderProvider])
    } else if (!LEADER_PROVIDERS.includes(patch.leaderProvider)) throw new Error('リーダーのプロバイダーが不正です')
    next.leaderProvider = patch.leaderProvider
  }
  if (Object.hasOwn(patch, 'gptLeader')) {
    if (!isRecord(patch.gptLeader)) throw new Error('agentTeams.gptLeader はオブジェクトで指定してください')
    if (Object.hasOwn(patch.gptLeader, 'model')) next.gptLeader.model = choice(patch.gptLeader.model, DSH_MODEL, 'GPT のリーダーのモデル')
    if (Object.hasOwn(patch.gptLeader, 'effort')) next.gptLeader.effort = choice(patch.gptLeader.effort, EFFORT, 'GPT のリーダーの推論レベル')
  }
  if (Object.hasOwn(patch, 'dshLeader')) {
    if (patch.dshLeader === null) next.dshLeader = null
    else {
      const entry = patch.dshLeader
      if (!isRecord(entry)) throw new Error('リーダーのプロバイダーが不正です')
      if (isRetired(entry.provider)) {
        if (!sameChoice(next.dshLeader, entry)) throw retiredError([entry.provider])
        next.dshLeader = { provider: entry.provider, model: entry.model, effort: entry.effort ?? null }
      } else {
        if (!EXTRA_DSH_LEADERS.includes(entry.provider)) throw new Error('リーダーのプロバイダーが不正です')
        const model = choice(entry.model, modelPattern(entry.provider), 'リーダーのモデル')
        if (!model) throw new Error('リーダーのモデルを選んでください')
        next.dshLeader = { provider: entry.provider, model, effort: choice(entry.effort ?? null, EFFORT, 'リーダーの推論レベル') }
      }
    }
  }
  if (EXTRA_DSH_LEADERS.includes(next.leaderProvider) && next.dshLeader?.provider !== next.leaderProvider) {
    throw new Error('リーダーのプロバイダーとモデルが一致しません')
  }
  for (const name of SWITCHES) {
    if (!Object.hasOwn(patch, name)) continue
    if (typeof patch[name] !== 'boolean') throw new Error(`agentTeams.${name} は boolean で指定してください`)
    next[name] = patch[name]
  }
  for (const name of Object.keys(RETIRED_PROVIDERS)) {
    // Settings clients from before the removal may still send the provider's block as off: it is ignored.
    if (isRecord(patch[name]) && patch[name].enabled === true) throw retiredError([name])
  }
  if (Object.hasOwn(patch, 'retiredProviders')) {
    // Only a switch-off: the list may shrink, a retired provider cannot be turned on again.
    const keep = patch.retiredProviders
    if (!Array.isArray(keep) || keep.some((name) => !next.retiredProviders.includes(name))) throw new Error('廃止したプロバイダーの設定は消すことだけできます')
    next.retiredProviders = [...new Set(keep)]
  }
  for (const provider of TEAM_PROVIDERS) {
    if (!Object.hasOwn(patch, provider)) continue
    const part = patch[provider]
    if (!isRecord(part)) throw new Error(`agentTeams.${provider} はオブジェクトで指定してください`)
    if (Object.hasOwn(part, 'enabled')) {
      if (typeof part.enabled !== 'boolean') throw new Error(`agentTeams.${provider}.enabled は boolean で指定してください`)
      next[provider].enabled = part.enabled
    }
    for (const tier of TEAM_TIERS) {
      if (!Object.hasOwn(part, tier)) continue
      if (!isRecord(part[tier])) throw new Error(`agentTeams.${provider}.${tier} はオブジェクトで指定してください`)
      const label = `${PROVIDER_NAMES[provider]} の${tier === 'low' ? '低' : '中'}枠`
      if (Object.hasOwn(part[tier], 'enabled')) {
        if (typeof part[tier].enabled !== 'boolean') throw new Error(`${label}のオン・オフは boolean で指定してください`)
        next[provider][tier].enabled = part[tier].enabled
      }
      if (Object.hasOwn(part[tier], 'model')) {
        next[provider][tier].model = choice(part[tier].model, modelPattern(provider), `${label}のモデル`)
      }
      if (Object.hasOwn(part[tier], 'effort')) next[provider][tier].effort = choice(part[tier].effort, EFFORT, `${label}の推論レベル`)
    }
  }
  if (Object.hasOwn(patch, 'maxChildren')) {
    const count = patch.maxChildren
    if (!Number.isInteger(count) || count < 1 || count > MAX_CHILDREN_LIMIT) throw new Error(`子の上限は 1〜${MAX_CHILDREN_LIMIT} で指定してください`)
    next.maxChildren = count
  }
  for (const provider of TEAM_PROVIDERS) {
    if (next[provider].enabled && !TEAM_TIERS.some((tier) => next[provider][tier].enabled)) {
      throw new Error(`${PROVIDER_NAMES[provider]} の低枠と中枠の少なくとも一方はオンにしてください`)
    }
  }
  return next
}

/**
 * The retired providers a team's children would still use: turned on, or a free-mode child. Tier
 * mode's unused free-mode entries are not in use, so they do not count there. The leader is not
 * here: a running leader's model is the leader thread's own (changeLeader changes it there, and the
 * saved config keeps the choice the team started with). Starting a team checks the leader
 * (`assertNotRetired`).
 */
export function retiredProvidersIn(config) {
  const used = new Set(config.retiredProviders ?? [])
  if (config.modelMode === 'free') for (const entry of config.freeModels ?? []) if (isRetired(entry?.provider)) used.add(entry.provider)
  return [...used]
}

/**
 * Throws when a retired provider is still in use by children. The work is never handed to another
 * provider instead: the user picks the choices again.
 */
export function assertNoRetiredProviders(config) {
  const used = retiredProvidersIn(config)
  if (used.length) throw retiredError(used)
}

/** Throws for a retired provider: a child or leader on it is not started. */
export function assertNotRetired(provider) {
  if (isRetired(provider)) throw retiredError([provider])
}

/** A team needs a provider to hand work to: throws when the settings turn every one off. */
export function assertChildrenOn(config) {
  assertNoRetiredProviders(config)
  if (config.modelMode === 'free') {
    if (!config.freeModels.length) throw new Error('子に使うモデルを少なくとも一つ選んでください')
    return
  }
  if (!TEAM_PROVIDERS.some((provider) => config[provider].enabled)) {
    throw new Error(`子に使う ${TEAM_PROVIDERS.map((provider) => PROVIDER_NAMES[provider]).join('・')} の少なくとも一つをオンにしてください`)
  }
}
