// The observer can read only its dedicated MCP data, not the workspace or
// unrelated tools. Native mode is required: run_code would itself be a tool.
export const name = 'agent-desk-observer-policy'
export const inject = ['tools']
const ALLOWED = new Set(['mcp__observer__status', 'mcp__observer__child_turns', 'mcp__observer__send', 'mcp__observer__stop'])
export function observerToolAllowed(name) { return ALLOWED.has(name) }
export function apply(ctx) {
  ctx.tools.guard((exec) => observerToolAllowed(exec.name) ? undefined : 'Observer: this tool is unavailable.')
}
