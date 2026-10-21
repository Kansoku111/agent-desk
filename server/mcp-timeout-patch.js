// How mcp-timeout-hook.js changes dsh-acp, kept apart so tests can check the
// patch without registering the hook.
//
// dsh ends every MCP tool call after 60 seconds (dsh-mcp-client's default
// `toolCallTimeoutMs`), and dsh-acp mounts the MCP servers an ACP client sends
// without a way to set it. One high-quality image takes longer than that, so
// `generate_image` failed while the image was still being drawn. The patch
// lets a stdio server Agent Desk mounts carry its own limit in the
// environment entry {@link TIMEOUT_ENV}; servers without it keep the default.

/** The environment entry of an ACP stdio MCP server that sets its tool-call timeout, in ms. */
export const TIMEOUT_ENV = 'AGENT_DESK_TOOL_TIMEOUT_MS'

const ANCHOR = '\t\t\t\t\tcwd: sessionCwd,\n\t\t\t\t\tfailOnStartupError: true\n\t\t\t\t})),\n\t\t\t\tenv\n'

/** dsh-acp's source with the timeout entry read, or null when it does not look as expected. */
export function patchMcpTimeoutSource(source) {
  const at = source.indexOf(ANCHOR)
  if (at === -1 || source.indexOf(ANCHOR, at + 1) !== -1 || !source.includes('function resolveMcpConfigs(servers, sessionCwd) {')) return null
  const timeout = `\t\t\t\t\t...Number(env[${JSON.stringify(TIMEOUT_ENV)}]) > 0 ? { toolCallTimeoutMs: Number(env[${JSON.stringify(TIMEOUT_ENV)}]) } : {},\n`
  const insert = at + ANCHOR.indexOf('\t\t\t\t\tfailOnStartupError')
  return `${source.slice(0, insert)}${timeout}${source.slice(insert)}`
}
