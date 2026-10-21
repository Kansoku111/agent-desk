// Where Agent Desk keeps its data. Everything lives under one app home so the
// embedded DeepSeek Harness never touches a user's own ~/.dsh.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function defaultAppHome() {
  if (process.env.AGENT_DESK_HOME) return path.resolve(process.env.AGENT_DESK_HOME)
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'AgentDesk')
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'AgentDesk')
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'agent-desk')
}

/** All derived locations for one app home. */
export function appPaths(home = defaultAppHome()) {
  const dshHome = path.join(home, 'dsh-home')
  return {
    home,
    settings: path.join(home, 'settings.json'),
    codexHome: path.join(home, 'codex-home'),
    threadsIndex: path.join(home, 'threads.json'),
    threadsDir: path.join(home, 'threads'),
    attachmentsDir: path.join(home, 'attachments'),
    catalog: path.join(home, 'catalog.json'),
    browserProfile: path.join(home, 'browser-profile'),
    runtimeCwd: path.join(home, 'runtime-cwd'),
    // "My PC": the working folder for tasks that belong to no project.
    myPc: path.join(home, 'my-pc'),
    // The browser tool's own Chrome profile and its debugging-port record.
    chromeProfile: path.join(home, 'chrome-tool-profile'),
    chromeState: path.join(home, 'chrome-tool.json'),
    // Snapshots of task workspaces, for undoing a turn's file changes.
    checkpoints: path.join(home, 'checkpoints'),
    // Which providers run in fast mode, read by each dsh process per request.
    fastMode: path.join(home, 'fast-mode.json'),
    // The extra dsh layer of agent teams' children (dsh-config.js teamChildPatch).
    teamChildPatch: path.join(home, 'team-child.patch.yml'),
    dshHome,
    credentials: path.join(dshHome, '.credentials.yaml'),
    homePatch: path.join(dshHome, 'cordis.patch.yml'),
  }
}

export const dshBin = path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
export const webDist = path.join(projectRoot, 'web', 'dist')
