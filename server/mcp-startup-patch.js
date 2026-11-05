// The ACP factory still validates the complete list before starting plugins.
export function patchMcpStartupSource(source) {
  const anchor = 'for (const config of configs) await agentCtx.plugin(McpClient, config);'
  if (source.includes('agentDeskMountMcp') || source.split(anchor).length !== 2
    || !source.includes('const configs = resolveMcpConfigs(servers, sessionCwd);')) return null
  const imports = 'import { mountMcpServers as agentDeskMountMcp } from ' + JSON.stringify(new URL('./mcp-startup.js', import.meta.url).href) + ';\n'
  return imports + source.replace(anchor, 'await agentDeskMountMcp(agentCtx, configs, McpClient);')
}
