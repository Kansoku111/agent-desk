// Settings of the agent teams (設定 → エージェントチーム): who leads (Claude
// Code or a GPT dsh task, on which model), and which model each provider's
// "low" and "mid" tier means (or that the tier is not used). The
// leader only ever picks a tier and a provider; the user maps them to models
// here, so new models need no change to how the leader works.

/**
 * Teams' children by provider: GPT and DeepSeek run as dsh tasks (on the
 * ChatGPT subscription, and on the user's DeepSeek API key), Claude as a Claude Code task.
 */
export const TEAM_PROVIDERS = ['gpt', 'claude', 'deepseek']
/** Who can lead: DeepSeek only works as a child. */
export const LEADER_PROVIDERS = ['claude', 'gpt']
export const TEAM_TIERS = ['low', 'mid']
export const PROVIDER_NAMES = { gpt: 'GPT', claude: 'Claude', deepseek: 'DeepSeek' }
export const MAX_CHILDREN_LIMIT = 12

/** A Claude Code model alias (opus) or full name (claude-haiku-5-5), as `claude --model` takes it. */
const CLAUDE_MODEL = /^[a-z0-9][a-z0-9.\-[\]]{0,79}$/i
/** A dsh model id (gpt-5.6-luna, deepseek-v4-pro). */
const DSH_MODEL = /^[a-z0-9][a-z0-9._-]{0,79}$/i
/** Reasoning levels are the catalog's (or `claude --effort`'s) words. */
const EFFORT = /^[a-z]{1,16}$/

export const TEAM_DEFAULTS = {
  /** Who leads a new team: Claude Code (`leader`) or GPT as a dsh task (`gptLeader`). */
  leaderProvider: 'claude',
  // null: Claude Code's own default.
  leader: { model: 'opus', effort: null },
  // null model: the GPT "mid" tier's.
  gptLeader: { model: null, effort: 'high' },
  // The leader runs with --permission-mode bypassPermissions (children always do).
  leaderBypass: true,
  // A tier that is not `enabled` is not offered to the leader.
  gpt: { enabled: true, low: { enabled: true, model: null, effort: 'medium' }, mid: { enabled: true, model: null, effort: 'high' } },
  claude: { enabled: true, low: { enabled: true, model: 'haiku', effort: null }, mid: { enabled: true, model: 'sonnet', effort: null } },
  // Off until the user turns it on: it is billed per token to their DeepSeek API key.
  deepseek: { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  maxChildren: 6,
}

/** The saved team settings with every field present (older saves lack newer fields). */
export function teamConfig(saved) {
  const value = saved && typeof saved === 'object' ? saved : {}
  const tier = (provider, name) => ({ ...TEAM_DEFAULTS[provider][name], ...value[provider]?.[name] })
  const provider = (name) => ({
    enabled: value[name]?.enabled ?? TEAM_DEFAULTS[name].enabled, low: tier(name, 'low'), mid: tier(name, 'mid'),
  })
  return {
    leaderProvider: LEADER_PROVIDERS.includes(value.leaderProvider) ? value.leaderProvider : TEAM_DEFAULTS.leaderProvider,
    leader: { ...TEAM_DEFAULTS.leader, ...value.leader },
    gptLeader: { ...TEAM_DEFAULTS.gptLeader, ...value.gptLeader },
    leaderBypass: typeof value.leaderBypass === 'boolean' ? value.leaderBypass : TEAM_DEFAULTS.leaderBypass,
    gpt: provider('gpt'),
    claude: provider('claude'),
    deepseek: provider('deepseek'),
    maxChildren: Number.isInteger(value.maxChildren) ? value.maxChildren : TEAM_DEFAULTS.maxChildren,
  }
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function choice(value, pattern, name) {
  if (value === null) return null
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${name} の値が不正です`)
  return value
}

/** Merges a settings patch into the team settings; throws on any invalid field. */
export function mergeTeamConfig(current, patch) {
  if (!isRecord(patch)) throw new Error('agentTeams はオブジェクトで指定してください')
  const next = teamConfig(current)
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
  if (Object.hasOwn(patch, 'leaderBypass')) {
    if (typeof patch.leaderBypass !== 'boolean') throw new Error('agentTeams.leaderBypass は boolean で指定してください')
    next.leaderBypass = patch.leaderBypass
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
        next[provider][tier].model = choice(part[tier].model, provider === 'claude' ? CLAUDE_MODEL : DSH_MODEL, `${label}のモデル`)
      }
      if (Object.hasOwn(part[tier], 'effort')) next[provider][tier].effort = choice(part[tier].effort, EFFORT, `${label}の推論レベル`)
    }
  }
  if (Object.hasOwn(patch, 'maxChildren')) {
    const count = patch.maxChildren
    if (!Number.isInteger(count) || count < 1 || count > MAX_CHILDREN_LIMIT) throw new Error(`子の上限は 1〜${MAX_CHILDREN_LIMIT} で指定してください`)
    next.maxChildren = count
  }
  if (!TEAM_PROVIDERS.some((provider) => next[provider].enabled)) throw new Error('GPT・Claude・DeepSeek の少なくとも一つはオンにしてください')
  for (const provider of TEAM_PROVIDERS) {
    if (next[provider].enabled && !TEAM_TIERS.some((tier) => next[provider][tier].enabled)) {
      throw new Error(`${PROVIDER_NAMES[provider]} の低枠と中枠の少なくとも一方はオンにしてください`)
    }
  }
  return next
}
