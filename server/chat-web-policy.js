// Fail closed if a future plugin registers another tool in the web-only runtime.
export const name = 'agent-desk-chat-web-policy'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.guard(({ name }) => {
    if (name !== 'web_search' && name !== 'web_fetch') return 'Only web search and fetch are available in chat mode.'
  })
}
