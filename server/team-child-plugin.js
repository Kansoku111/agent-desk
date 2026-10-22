// A dsh plugin: the standing instructions of an agent team's child. The team
// children's layer (dsh-config.js teamChildPatch) loads it into their runtimes
// only, with the text as config; as a system prompt section it stays through
// compaction, which a first message would not.

export const name = 'agent-desk-team-child'
export const inject = ['systemPrompt']

export const SECTION_NAME = 'agent-desk:team-child'

export function apply(ctx, config) {
  const text = typeof config?.text === 'string' ? config.text.trim() : ''
  if (!text) return
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    // After the deployment persona, before the user's own instructions (instructions-plugin.js).
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 50,
    text,
    interpolate: false,
  })
}
