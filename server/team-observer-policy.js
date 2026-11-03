// The observer can inspect workspace files without gaining mutation or execution.
// Native mode is required: allowing run_code would also allow arbitrary Node code.
export const name = 'agent-desk-observer-policy'
export const inject = ['tools']
const ALLOWED = new Set(['read', 'read_image', 'glob', 'grep',
  'mcp__observer__status', 'mcp__observer__child_turns', 'mcp__observer__send', 'mcp__observer__stop'])
export function observerToolAllowed(name) { return ALLOWED.has(name) }
export function apply(ctx) {
  ctx.tools.guard((exec) => observerToolAllowed(exec.name) ? undefined : 'Observer: this tool is unavailable.')
}
