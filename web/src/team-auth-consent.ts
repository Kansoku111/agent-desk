import type { ClaudeAuthConfirmation, ClaudeAuthInspection, TeamSettings, TeamSummary } from './types'

export interface AuthConsentState {
  ready: boolean
  confirmation?: ClaudeAuthConfirmation
}

/** Saving a GPT-only configuration must remain possible while Claude is logged out.
 * Existing CLI children are still guarded by the server if explicitly resumed. */
export function needsClaudeAuth(config: TeamSettings, team?: TeamSummary): boolean {
  const claudeChild = config.modelMode === 'free' ? (config.freeModels ?? []).some((model) => model.provider === 'claude') : config.claude.enabled
  return (team ? team.leaderKind === 'terminal' : config.leaderProvider === 'claude') || claudeChild
}

/** A displayed challenge alone is not consent, including for unknown auth. */
export function authConsentState(inspection: ClaudeAuthInspection | null, accepted = false): AuthConsentState {
  if (!inspection || inspection.descriptor.mode === 'logged-out') return { ready: false }
  if (inspection.confirmed) return { ready: true }
  if (!accepted || !inspection.challenge) return { ready: false }
  return {
    ready: true,
    confirmation: {
      challenge: inspection.challenge,
      ...(inspection.descriptor.mode === 'unknown' ? { acknowledgeUnknown: true } : {}),
    },
  }
}
