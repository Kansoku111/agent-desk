// Model-free Claude Code auth inspection and descriptor-bound consent, remembered once per auth mode.
// This is a warning/confirmation boundary, not a guaranteed spending cap.
import { randomUUID } from 'node:crypto'
import { spawn as spawnProcess } from 'node:child_process'
import path from 'node:path'
import { launchCommand, findClaude, INHERITED_MARKERS } from './terminal-helpers.js'

const TIMEOUT_MS = 15_000
const METHODS = ['claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party']
const PROVIDERS = ['firstParty', 'bedrock', 'vertex', 'foundry']
export const AUTH_REQUIRED = 'Claude Code の認証方法の確認が必要です。チームの設定を開いて、課金の可能性を確認してください。'
export function authDescriptor(status) {
  const authMethod = METHODS.includes(status?.authMethod) ? status.authMethod : 'unknown'
  const apiProvider = PROVIDERS.includes(status?.apiProvider) ? status.apiProvider : 'unknown'
  let mode = 'unknown'
  if (status?.loggedIn === false) mode = 'logged-out'
  else if (status?.loggedIn === true) {
    if (['bedrock', 'vertex', 'foundry'].includes(apiProvider)) mode = 'cloud'
    else if (apiProvider === 'firstParty' && ['api_key', 'api_key_helper'].includes(authMethod)) mode = 'api'
    else if (apiProvider === 'firstParty' && authMethod === 'claude.ai') mode = 'subscription'
  }
  return { version: 1, mode, authMethod, apiProvider }
}
export function authProblem(status) {
  return authDescriptor(status).mode === 'logged-out'
    ? 'Claude Code にログインしていません。Claude Code でログインしてから再確認してください。' : null
}
export function claudeAuthEnv() {
  const env = { ...process.env }
  for (const name of INHERITED_MARKERS) delete env[name]
  return env
}
function parseStatus(out, code) {
  try {
    const value = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
    // Some CLI versions return nonzero for a known logged-out state.
    return code === 0 || value?.loggedIn === false ? value : null
  } catch { return null }
}
// Batch only checks queued before a CLI process starts. A later consent or
// launch must inspect again, even while that process is still running.
const pendingChecks = []
function sameEnv(left, right) {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((name) => Object.hasOwn(right, name) && left[name] === right[name])
}
export function claudeAuthStatus({ claude, cwd, env, spawn = spawnProcess, timeoutMs = TIMEOUT_MS }) {
  if (!claude) return Promise.resolve(null)
  const context = { claude, cwd, env: { ...(env ?? process.env) }, spawn, timeoutMs }
  const pending = pendingChecks.find((entry) => entry.claude === claude && entry.cwd === cwd
    && entry.spawn === spawn && entry.timeoutMs === timeoutMs && sameEnv(entry.env, context.env))
  if (pending) return pending.promise
  const entry = { ...context, promise: null }
  const promise = Promise.resolve().then(() => {
    const index = pendingChecks.indexOf(entry)
    if (index !== -1) pendingChecks.splice(index, 1)
    return new Promise((resolve) => {
      const command = launchCommand(claude, ['auth', 'status'])
      let proc
      try { proc = spawn(command.file, command.args, { cwd, env: context.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }) }
      catch { return resolve(null) }
      let out = '', settled = false
      const done = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) }
      const timer = setTimeout(() => { try { proc.kill() } catch {}; done(null) }, timeoutMs)
      timer.unref?.()
      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (chunk) => { out += chunk; if (out.length > 65536) { try { proc.kill() } catch {}; done(null) } })
      proc.on('error', () => done(null))
      proc.on('close', (code) => done(parseStatus(out, code)))
    })
  })
  entry.promise = promise
  pendingChecks.push(entry)
  return promise
}
export async function checkClaudeAuth(context, options = {}) {
  const status = await claudeAuthStatus({ ...context, ...options })
  return authProblem(status) ?? AUTH_REQUIRED
}
const key = (descriptor) => JSON.stringify(descriptor)
export class TeamClaudeAuth {
  constructor({ detect = claudeAuthStatus, find = findClaude, now = Date.now } = {}) {
    Object.assign(this, { detect, find, now })
    this.challenges = new Map()
    this.inspections = []
    /** Auth modes the user confirmed once for every team: [{ descriptor, acknowledgeUnknown, confirmedAt }]. */
    this.accepted = []
  }
  /** Replaces the remembered confirmations with what a save held. */
  restore(saved) {
    this.accepted = (Array.isArray(saved) ? saved : []).filter((item) => item?.descriptor && typeof item.descriptor === 'object')
  }
  context(workspace) { return { claude: this.find(), cwd: workspace, env: claudeAuthEnv() } }
  async descriptor(context) { try { return authDescriptor(await this.detect(context)) } catch { return authDescriptor(null) } }
  /** A confirmation counts when it names this exact auth mode, whichever team or folder it was given for. */
  matches(team, descriptor) {
    const consent = team?.claudeAuthConsent
    const same = (item) => key(item.descriptor) === key(descriptor) && (descriptor.mode !== 'unknown' || item.acknowledgeUnknown === true)
    return this.accepted.some(same)
      || (Boolean(team) && consent?.teamId === team.id && consent?.workspace === path.resolve(team.workspace) && same(consent))
  }
  async inspect(workspace, team = null) {
    const context = this.context(workspace)
    // Display-only inspections can share a running check. Confirmation and
    // launch guards must still inspect independently before authorizing work.
    let inspection = this.inspections.find((entry) => entry.context.claude === context.claude
      && entry.context.cwd === context.cwd && sameEnv(entry.context.env, context.env))
    if (!inspection) {
      inspection = { context, promise: this.descriptor(context) }
      this.inspections.push(inspection)
      const entry = inspection
      const clear = () => { const index = this.inspections.indexOf(entry); if (index !== -1) this.inspections.splice(index, 1) }
      void entry.promise.then(clear, clear)
    }
    const descriptor = await inspection.promise
    for (const [id, entry] of this.challenges) if (entry.expires < this.now()) this.challenges.delete(id)
    const challenge = descriptor.mode === 'logged-out' ? null : randomUUID()
    if (challenge) this.challenges.set(challenge, { workspace: path.resolve(workspace), teamId: team?.id ?? null, descriptor, expires: this.now() + 300000 })
    return { descriptor, challenge, confirmed: descriptor.mode !== 'logged-out' && this.matches(team, descriptor) }
  }
  async confirm(team, confirmation, existing = true, isCurrent = () => true) {
    const entry = this.challenges.get(confirmation?.challenge)
    if (!entry || entry.expires < this.now() || entry.workspace !== path.resolve(team.workspace) || entry.teamId !== (existing ? team.id : null)) throw new Error(AUTH_REQUIRED)
    if (entry.descriptor.mode === 'unknown' && confirmation.acknowledgeUnknown !== true) throw new Error('認証方法が不明です。課金の可能性が不明なリスクを明示的に確認してください。')
    // Reserve before awaiting inspection: a challenge authorizes only one action.
    this.challenges.delete(confirmation.challenge)
    const descriptor = await this.descriptor(this.context(team.workspace))
    if (!isCurrent() || key(descriptor) !== key(entry.descriptor) || descriptor.mode === 'logged-out') throw new Error(AUTH_REQUIRED)
    const acknowledgeUnknown = confirmation.acknowledgeUnknown === true
    team.claudeAuthConsent = { teamId: team.id, workspace: path.resolve(team.workspace), descriptor, acknowledgeUnknown, confirmedAt: this.now() }
    // Remembered for later teams: the box is ticked once per auth mode, not once per team (TeamManager saves it).
    this.adopt({ descriptor, acknowledgeUnknown, confirmedAt: this.now() })
  }
  /** Remembers a confirmation for every team (one per auth mode; the newest wins). */
  adopt(consent) {
    if (!consent?.descriptor || typeof consent.descriptor !== 'object') return
    const { descriptor, acknowledgeUnknown = false, confirmedAt = this.now() } = consent
    this.accepted = [...this.accepted.filter((item) => key(item.descriptor) !== key(descriptor)), { descriptor, acknowledgeUnknown: acknowledgeUnknown === true, confirmedAt }]
  }
  problem(team, descriptor) {
    if (descriptor.mode === 'logged-out') return authProblem({ loggedIn: false })
    return this.matches(team, descriptor) ? null : AUTH_REQUIRED
  }
  async guard(team, context) { return this.problem(team, await this.descriptor(context)) }
}
