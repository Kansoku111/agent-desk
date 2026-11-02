// The MCP servers a task's session mounts (see index.js): the browser tool, the
// desktop and image tools, and a GPT team leader's team tools.
import { fileURLToPath } from 'node:url'
import { IMAGE_TIMEOUT_MS } from './imagegen.js'
import { TIMEOUT_ENV } from './mcp-timeout-patch.js'

const chromeMcpScript = fileURLToPath(new URL('./chrome-mcp.js', import.meta.url))
const desktopMcpScript = fileURLToPath(new URL('./desktop-mcp.js', import.meta.url))
const imagegenMcpScript = fileURLToPath(new URL('./imagegen-mcp.js', import.meta.url))
const historyMcpScript = fileURLToPath(new URL('./history-mcp.js', import.meta.url))

/** The same isolated Codex image server for dsh and Claude Code sessions. */
export function imageMcpServer(paths, workspace) {
  return {
    name: 'imagegen', command: process.execPath,
    args: [imagegenMcpScript, '--codex-home', paths.codexHome, '--settings', paths.settings, '--workspace', workspace, '--previews', paths.attachmentsDir],
    // dsh otherwise stops MCP calls at 60 seconds; Claude Code ignores this entry.
    env: [{ name: TIMEOUT_ENV, value: String(IMAGE_TIMEOUT_MS + 60_000) }],
  }
}

/** Convert an ACP stdio server to Claude Code's MCP config format. */
export function claudeMcpServer(server) {
  return { type: 'stdio', command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }
}

/** Builds `mcpServersFor(thread)`; `getSettings` and `getTeams` read index.js's current state. */
export function createMcpServerList({ paths, getSettings, getTeams }) {
  /** MCP servers mounted into a task's session; ACP stdio servers need an absolute command. */
  function mcpServersFor(thread) {
    const servers = []
    // Fail closed: observer sessions never inherit ordinary task or leader MCPs.
    if (thread.team?.role === 'observer') {
      const server = getTeams()?.observerMcpFor(thread)
      if (!server) throw new Error('観測者のセッションを確認できません')
      return [server]
    }
    if (thread.preset) return thread.preset.browser ? [chromeServer(thread)] : servers
    // Consultation cannot use browser/desktop tools to bypass its read-only sandbox.
    // WebSearch/WebFetch are native tools in the non-lean AB runtime.
    if (thread.ab && !thread.ab.writable) return servers
    // A team's child the user keeps lean goes without them (teams.js toolsFor).
    const tools = getTeams()?.toolsFor(thread) ?? true
    if (tools && getSettings().browserTool) servers.push(chromeServer(thread))
    if (tools && getSettings().desktopTool && process.platform === 'win32') {
      // Keep agent-desktop's snapshots (they hold on-screen text) in Agent Desk's own folder, not the user's home.
      const env = paths.desktopUiHome ? [{ name: 'AGENT_DESKTOP_HOME', value: paths.desktopUiHome }] : []
      servers.push({ name: 'desktop', command: process.execPath, args: [desktopMcpScript], env })
    }
    if (tools && getSettings().historyTool === true) {
      servers.push({ name: 'history', command: process.execPath,
        args: [historyMcpScript, '--home', paths.home, '--settings', paths.settings, '--workspace', thread.workspace], env: [] })
    }
    if (tools && getSettings().imageTool) {
      servers.push(imageMcpServer(paths, thread.workspace))
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
