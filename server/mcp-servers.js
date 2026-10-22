// The MCP servers a task's session mounts (see index.js): the browser tool, the
// desktop and image tools, and a GPT team leader's team tools.
import { fileURLToPath } from 'node:url'
import { IMAGE_TIMEOUT_MS } from './imagegen.js'
import { TIMEOUT_ENV } from './mcp-timeout-patch.js'

const chromeMcpScript = fileURLToPath(new URL('./chrome-mcp.js', import.meta.url))
const desktopMcpScript = fileURLToPath(new URL('./desktop-mcp.js', import.meta.url))
const imagegenMcpScript = fileURLToPath(new URL('./imagegen-mcp.js', import.meta.url))

/** Builds `mcpServersFor(thread)`; `getSettings` and `getTeams` read index.js's current state. */
export function createMcpServerList({ paths, getSettings, getTeams }) {
  /** MCP servers mounted into a task's session; ACP stdio servers need an absolute command. */
  function mcpServersFor(thread) {
    const servers = []
    // A team's child the user keeps lean goes without them (teams.js toolsFor).
    const tools = getTeams()?.toolsFor(thread) ?? true
    if (tools && getSettings().browserTool) servers.push(chromeServer(thread))
    if (tools && getSettings().desktopTool && process.platform === 'win32') {
      servers.push({ name: 'desktop', command: process.execPath, args: [desktopMcpScript], env: [] })
    }
    if (tools && getSettings().imageTool) {
      servers.push({
        name: 'imagegen',
        command: process.execPath,
        args: [imagegenMcpScript, '--codex-home', paths.codexHome, '--settings', paths.settings, '--workspace', thread.workspace, '--previews', paths.attachmentsDir],
        // A high-quality image takes longer than dsh's 60-second tool limit;
        // imagegen-mcp.js gives up on its own after IMAGE_TIMEOUT_MS.
        env: [{ name: TIMEOUT_ENV, value: String(IMAGE_TIMEOUT_MS + 60_000) }],
      })
    }
    // A GPT team leader's tools (teams.js); no other task gets them.
    const team = getTeams()?.mcpServerFor(thread)
    if (team) servers.push(team)
    return servers
  }
  /** The browser tool: chrome-devtools-mcp relayed through chrome-mcp.js. */
  function chromeServer(thread) {
    return {
      name: 'chrome',
      command: process.execPath,
      args: [
        chromeMcpScript,
        '--state', paths.chromeState,
        '--profile', paths.chromeProfile,
        '--workspace', thread.workspace,
        ...(getSettings().browserHeadless ? ['--headless'] : []),
      ],
      env: [],
    }
  }
  return mcpServersFor
}
