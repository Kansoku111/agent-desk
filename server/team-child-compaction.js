// A child-role policy, not a provider/model allowlist. The upstream backend still
// owns pruning, balanced cuts, summary calls, persistence, cancellation and retries.
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'

export const CHILD_CONTEXT_BUDGET = 400_000

/** Translate an absolute child budget to the upstream exact-route policy. */
export function childCompactionPolicy(config, target, info, replyTokens) {
  const original = config.modelPolicies.find((p) => p.provider === target.provider && p.model === target.model)
  const window = info.context?.contextWindow
  // Capacity/pressure errors remain the upstream backend's responsibility.
  if (!Number.isInteger(window) || window <= 0 || !Number.isInteger(replyTokens) || replyTokens < 0) return original
  const ratio = original?.thresholdRatio ?? config.thresholdRatio
  const thresholdRatio = Math.min(ratio, CHILD_CONTEXT_BUDGET / window)
  if (thresholdRatio === ratio) return original
  const messageBudget = window - replyTokens
  const pressureBudget = messageBudget - (original?.headroomTokens ?? config.headroomTokens)
  const previousThreshold = Math.floor(Math.min(window * ratio, pressureBudget))
  const threshold = Math.floor(Math.min(window * thresholdRatio, pressureBudget))
  if (threshold <= 0 || threshold >= previousThreshold) return original

  const policy = { ...original, ...target, thresholdRatio }
  const retained = original?.retainTokens ?? (original?.retainRatio !== undefined
    ? Math.floor(messageBudget * original.retainRatio)
    : config.retainTokens ?? Math.floor(messageBudget * config.retainRatio))
  // A custom/very-large-model tail must not occupy the whole new budget. Leave
  // legal existing tails alone; shrink only ones the earlier threshold invalidates.
  if (retained >= threshold) {
    delete policy.retainRatio
    policy.retainTokens = Math.floor(threshold / 2)
  }
  return Object.freeze(policy)
}

export class TeamChildCompaction extends BasicCompactionEngine {
  constructor(ctx, config) {
    super(ctx, config)
    this.originalConfig = this.config
  }

  async compactIfNeeded(agent, trigger, signal) {
    if (trigger === 'pressure') {
      signal?.throwIfAborted()
      const request = agent.session.requestHeader()?.config
      if (request?.provider && request.model) {
        const target = { provider: request.provider, model: request.model }
        // This is adapter metadata, not a model request. Do not substitute a
        // fabricated context window: output caps and all other roles stay intact.
        const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
        signal?.throwIfAborted()
        const policy = childCompactionPolicy(this.originalConfig, target, info, request.maxTokens ?? info.defaultMaxTokens ?? 0)
        // Runtimes can host concurrent routes. Replace just this route, always
        // deriving from the original policy so caps never compound on resume.
        const modelPolicies = this.config.modelPolicies.filter((p) => p.provider !== target.provider || p.model !== target.model)
        if (policy) modelPolicies.push(policy)
        this.config = Object.freeze({ ...this.config, modelPolicies: Object.freeze(modelPolicies) })
      }
    }
    return super.compactIfNeeded(agent, trigger, signal)
  }
}

// Patch names are assertions, not renames. Disable the stock row and mount the
// child backend separately, evaluating the retained config in its original scope.
export default {
  inject: ['loader', ...BasicCompactionEngine.inject],
  apply(ctx) {
    // A profile is an Include: its sibling entries are not in the global root.
    const entry = ctx.fiber.entry.parent.tree.resolve('compaction-basic')
    if (!entry || entry.options.name !== '@deepseek-ai/dsh-compaction-basic' || !entry.disabled) {
      throw new Error('The child context budget requires the disabled stock compaction-basic entry')
    }
    ctx.plugin(TeamChildCompaction, interpolate(entry.ctx, entry.options.config ?? {}))
  },
}

