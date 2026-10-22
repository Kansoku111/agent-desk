// Which sign-in `claude` would use, asked before a team's Claude child starts.
// `claude auth status` answers from Claude Code's own settings and environment
// without asking any model anything, so a run that would be billed to an API
// key or a cloud account is refused before the first request exists. (The
// `init` event of the run itself comes too late: the request follows it by a
// few tens of milliseconds, before a kill can land.)
import { spawn as spawnProcess } from 'node:child_process'
import { launchCommand } from './terminal-helpers.js'

const TIMEOUT_MS = 15_000

/** How each sign-in that is not the Claude subscription is named to the user. */
const BILLED = {
  api_key: 'API キー',
  api_key_helper: 'apiKeyHelper（API キーを出力する設定）',
}
const CLOUD = { bedrock: 'Amazon Bedrock', vertex: 'Google Cloud Vertex AI', foundry: 'Microsoft Foundry' }

/**
 * Why a team's Claude child must not run on this sign-in, or null when it may.
 * An unreadable or unknown answer is let through: the run's own `init` check
 * still stops an API key that slips by.
 */
export function authProblem(status) {
  if (!status || typeof status !== 'object') return null
  if (status.loggedIn === false) {
    return 'Claude Code にログインしていません。ターミナルで claude を開いてログインしてから、もう一度送ってください。'
  }
  const how = BILLED[status.authMethod] ?? CLOUD[status.apiProvider]
  if (!how) return null
  return `Claude Code が${how}で動こうとしているため、起動しませんでした。チームの Claude Code の子は Claude のサブスクリプションでしか動かしません。`
    + 'Claude Code の設定から外すか、API キーで使いたいときはチームの設定で「Claude（API）」の子を使ってください。'
}

/** The parsed answer of `claude auth status` in `cwd` (a project may carry its own settings), or null when it cannot be read. */
export function claudeAuthStatus({ claude, cwd, env, spawn = spawnProcess, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const command = launchCommand(claude, ['auth', 'status'])
    let proc
    try {
      proc = spawn(command.file, command.args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      return resolve(null)
    }
    let out = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {}
      done(null)
    }, timeoutMs)
    timer.unref?.()
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk) => { out += chunk })
    proc.on('error', () => done(null))
    proc.on('close', () => {
      try {
        done(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)))
      } catch {
        done(null)
      }
    })
  })
}

/** The check a runner makes before it starts a turn: a message when the run must not start, else null. */
export async function checkClaudeAuth(context, options = {}) {
  return authProblem(await claudeAuthStatus({ ...context, ...options }))
}
