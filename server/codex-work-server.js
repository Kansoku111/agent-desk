import path from 'node:path'
import { CodexAppServer, DISABLED_CODEX_FEATURES, prepareCodexHome } from './codex-app-server.js'

// The work process shares credentials, not the image process's ephemeral state or policy.
export class CodexWorkServer extends CodexAppServer {
  constructor(options) {
    super(options)
    this.cwd = path.resolve(options.cwd ?? process.cwd())
    this.runtimeHome = path.join(this.home, 'work-state')
  }

  async prepare() {
    await prepareCodexHome(this.home)
  }

  defaultArgs() {
    const disabled = DISABLED_CODEX_FEATURES.filter(feature => !['shell_tool', 'unified_exec', 'view_image'].includes(feature))
    return [
      ...disabled.flatMap(feature => ['-c', `features.${feature}=false`]),
      '-c', 'features.shell_tool=true',
      '-c', 'features.unified_exec=true',
      '-c', `sqlite_home=${JSON.stringify(this.runtimeHome)}`,
      '-c', `log_dir=${JSON.stringify(path.join(this.runtimeHome, 'log'))}`,
      'app-server', '--listen', 'stdio://',
    ]
  }

  serverRequest(child, { id, method, params }) {
    if (child === this.child) this.emit('request', { id, method, params: params ?? {} })
  }

  respond(id, result) {
    if (!this.child?.stdin) throw new Error('Codex transport closed')
    this.child.stdin.write(JSON.stringify({ id, result }) + '\n')
  }

  reject(id, error) {
    if (!this.child?.stdin) throw new Error('Codex transport closed')
    this.child.stdin.write(JSON.stringify({ id, error }) + '\n')
  }

  async cleanupRuntime() {
    // Work diagnostics and session state persist across process restarts.
  }
}
