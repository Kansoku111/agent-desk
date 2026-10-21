// A dsh plugin: the user's custom instructions from 設定 → パーソナライズ.
// The home patch (dsh-config.js) loads it into every dsh process with the
// text as config; it adds one system prompt section, read before every step.

export const name = 'agent-desk-instructions'
export const inject = ['systemPrompt']

export const SECTION_NAME = 'agent-desk:custom-instructions'

/** The section text: the user's words, framed so the agent knows whose they are. */
export function instructionsSection(text) {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) return ''
  return [
    '# User instructions',
    'The user wrote these standing instructions in Agent Desk\'s settings. Read them before you start any task and follow them in every reply and action. A request the user makes in the conversation takes precedence when the two conflict.',
    `<user_instructions>\n${body}\n</user_instructions>`,
  ].join('\n\n')
}

export function apply(ctx, config) {
  const text = instructionsSection(config?.text)
  if (!text) return
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    // Last, after the deployment persona, so nothing later restates over it.
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 100,
    text,
    // The user's text is literal: `{{…}}` in it is not a prompt variable.
    interpolate: false,
  })
}
