// Settings of the agent teams (設定 → エージェントチーム): who leads (Claude
// Code or a GPT dsh task, on which model), and which model each provider's
// "low" and "mid" tier means, or a list of directly selected child models.
import { ENTRY_ID } from './team-playbooks.js'
import { assertToolMode } from './ptc.js'

/**
 * Teams' children by provider: GPT, Claude (API), DeepSeek, OpenCode Go and
 * the local server run as dsh tasks (on the ChatGPT subscription, the user's
 * Anthropic, DeepSeek and OpenCode Go API keys, and their own machine), Claude
 * as a Claude Code task.
 */
export const TEAM_PROVIDERS = ['gpt', 'claude', 'claudeApi', 'deepseek', 'opencodeGo', 'local']
/** Who can lead: DeepSeek, OpenCode Go and local models only work as children. */
export const LEADER_PROVIDERS = ['claude', 'gpt']
export const TEAM_TIERS = ['low', 'mid']
export const PROVIDER_NAMES = { gpt: 'GPT', claude: 'Claude', claudeApi: 'Claude（API）', deepseek: 'DeepSeek', opencodeGo: 'OpenCode Go', local: 'ローカル LLM' }
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

export const TEAM_DEFAULTS = {
  /** Who leads a new team: Claude Code (`leader`) or GPT as a dsh task (`gptLeader`). */
  leaderProvider: 'claude',
  toolMode: 'native',
  // The default applies to new teams; modelMode is the mode of this team.
  defaultModelMode: 'tiers',
  modelMode: 'tiers',
  freeModels: [],
  // null: Claude Code's own default.
  leader: { model: 'opus', effort: null },
  // null model: GPT's mid, low, then the first selected GPT model in free mode.
  gptLeader: { model: null, effort: 'high' },
  // The leader runs with --permission-mode bypassPermissions (children always do).
  leaderBypass: true,
  // Every provider is off until the user turns it on (a team starts with at least one on), so
  // nothing runs, bills or signs in without a choice. A tier that is not `enabled` is not
  // offered to the leader.
  // GPT: the ChatGPT subscription.
  gpt: { enabled: false, low: { enabled: true, model: null, effort: 'medium' }, mid: { enabled: true, model: null, effort: 'high' } },
  // Claude Code with the user's own, explicitly confirmed auth/billing mode.
  claude: { enabled: false, low: { enabled: true, model: 'haiku', effort: null }, mid: { enabled: true, model: 'sonnet', effort: null } },
  // Claude through dsh and their Anthropic API key, billed per token.
  // Any credits are subject to the user's provider plan conditions.
  claudeApi: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  // Billed per token to their DeepSeek API key.
  deepseek: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  // Their OpenCode Go subscription (open models, with usage limits instead of a per-token bill).
  opencodeGo: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  // A model server on the user's machine or network (設定 → アカウント → ローカル LLM).
  local: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  maxChildren: 6,
  // Reports that wait while the leader works reach it together, in one turn, instead of one turn each.
  batchReports: true,
  // Children start without the browser, desktop and image tools (a Claude child without its MCP
  // servers) unless the leader's `spawn` asks for them: smaller tool lists on every turn.
  leanChildren: false,
  // The policy (team-playbooks.js) a new team's leader reads; null: none.
  policy: null,
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
    leaderProvider: LEADER_PROVIDERS.includes(value.leaderProvider) ? value.leaderProvider : TEAM_DEFAULTS.leaderProvider,
    toolMode: value.toolMode ?? 'native',
    defaultModelMode: TEAM_MODEL_MODES.includes(value.defaultModelMode) ? value.defaultModelMode : 'tiers',
    modelMode: TEAM_MODEL_MODES.includes(value.modelMode) ? value.modelMode : 'tiers',
    freeModels: Array.isArray(value.freeModels) ? value.freeModels.map((model) => ({ ...model })) : [],
    leader: { ...TEAM_DEFAULTS.leader, ...value.leader },
    gptLeader: { ...TEAM_DEFAULTS.gptLeader, ...value.gptLeader },
    ...Object.fromEntries(SWITCHES.map((name) => [name, typeof value[name] === 'boolean' ? value[name] : TEAM_DEFAULTS[name]])),
    gpt: provider('gpt'),
    claude: provider('claude'),
    claudeApi: provider('claudeApi'),
    deepseek: provider('deepseek'),
    opencodeGo: provider('opencodeGo'),
    local: provider('local'),
    maxChildren: Number.isInteger(value.maxChildren) ? value.maxChildren : TEAM_DEFAULTS.maxChildren,
    policy: typeof value.policy === 'string' && ENTRY_ID.test(value.policy) ? value.policy : null,
  }
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function choice(value, pattern, name) {
  if (value === null) return null
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${name} の値が不正です`)
  return value
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
    const seen = new Set()
    next.freeModels = patch.freeModels.map((entry) => {
      if (!isRecord(entry) || !TEAM_PROVIDERS.includes(entry.provider)) throw new Error('子のモデルのプロバイダーが不正です')
      const model = choice(entry.model, entry.provider === 'claude' ? CLAUDE_MODEL : entry.provider === 'local' ? LOCAL_MODEL : DSH_MODEL, '子のモデル')
      if (!model) throw new Error('子のモデルを選んでください')
      const key = JSON.stringify([entry.provider, model])
      if (seen.has(key)) throw new Error('同じモデルは複数選べません')
      seen.add(key)
      return { provider: entry.provider, model, effort: choice(entry.effort ?? null, EFFORT, '子の推論レベル') }
    })
  }
  if (Object.hasOwn(patch, 'toolMode')) {
    assertToolMode(patch.toolMode)
    next.toolMode = patch.toolMode
  }
  if (Object.hasOwn(patch, 'leader')) {
    if (!isRecord(patch.leader)) throw new Error('agentTeams.leader はオブジェクトで指定してください')
    if (Object.hasOwn(patch.leader, 'model')) next.leader.model = choice(patch.leader.model, CLAUDE_MODEL, 'リーダーのモデル')
    if (Object.hasOwn(patch.leader, 'effort')) next.leader.effort = choice(patch.leader.effort, EFFORT, 'リーダーの推論レベル')
  }
  if (Object.hasOwn(patch, 'leaderProvider')) {
    if (!LEADER_PROVIDERS.includes(patch.leaderProvider)) throw new Error('リーダーは "claude" か "gpt" で指定してください')
    next.leaderProvider = patch.leaderProvider
  }
  if (Object.hasOwn(patch, 'gptLeader')) {
    if (!isRecord(patch.gptLeader)) throw new Error('agentTeams.gptLeader はオブジェクトで指定してください')
    if (Object.hasOwn(patch.gptLeader, 'model')) next.gptLeader.model = choice(patch.gptLeader.model, DSH_MODEL, 'GPT のリーダーのモデル')
    if (Object.hasOwn(patch.gptLeader, 'effort')) next.gptLeader.effort = choice(patch.gptLeader.effort, EFFORT, 'GPT のリーダーの推論レベル')
  }
  for (const name of SWITCHES) {
    if (!Object.hasOwn(patch, name)) continue
    if (typeof patch[name] !== 'boolean') throw new Error(`agentTeams.${name} は boolean で指定してください`)
    next[name] = patch[name]
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
        next[provider][tier].model = choice(part[tier].model, provider === 'claude' ? CLAUDE_MODEL : provider === 'local' ? LOCAL_MODEL : DSH_MODEL, `${label}のモデル`)
      }
      if (Object.hasOwn(part[tier], 'effort')) next[provider][tier].effort = choice(part[tier].effort, EFFORT, `${label}の推論レベル`)
    }
  }
  if (Object.hasOwn(patch, 'maxChildren')) {
    const count = patch.maxChildren
    if (!Number.isInteger(count) || count < 1 || count > MAX_CHILDREN_LIMIT) throw new Error(`子の上限は 1〜${MAX_CHILDREN_LIMIT} で指定してください`)
    next.maxChildren = count
  }
  if (Object.hasOwn(patch, 'policy')) next.policy = choice(patch.policy, ENTRY_ID, '方針')
  for (const provider of TEAM_PROVIDERS) {
    if (next[provider].enabled && !TEAM_TIERS.some((tier) => next[provider][tier].enabled)) {
      throw new Error(`${PROVIDER_NAMES[provider]} の低枠と中枠の少なくとも一方はオンにしてください`)
    }
  }
  return next
}

/** A team needs a provider to hand work to: throws when the settings turn every one off. */
export function assertChildrenOn(config) {
  if (config.modelMode === 'free') {
    if (!config.freeModels.length) throw new Error('子に使うモデルを少なくとも一つ選んでください')
    return
  }
  if (!TEAM_PROVIDERS.some((provider) => config[provider].enabled)) {
    throw new Error('子に使う GPT・Claude・Claude（API）・DeepSeek・OpenCode Go・ローカル LLM の少なくとも一つをオンにしてください')
  }
}
