// Checks for newer releases of Agent Desk itself and of what it runs on: the
// embedded dsh, the bundled Codex app-server and the user's Claude Code.
//
// Agent Desk updates itself from its GitHub releases (app-update.js).
//
// Nothing here installs dsh or Codex. Both are pinned in package.json and a
// new release usually needs code changes, so an update is handed to an AI
// agent working in the repository: the UI copies `prompt`, which states the
// facts (versions, repository, release notes) and leaves the steps to
// docs/updating.md, so it stays right as the procedure changes. Claude Code is
// the user's own CLI and updates itself with `claude update`.
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { findClaude, INHERITED_MARKERS, launchCommand } from './terminal-helpers.js'

export const DSH_PACKAGES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-atomic-write']
const CODEX_PACKAGE = '@openai/codex'
const CLAUDE_PACKAGE = '@anthropic-ai/claude-code'

/** dsh release channels (npm dist-tags), from the most to the least stable. */
export const UPDATE_CHANNELS = ['latest', 'next', 'alpha']

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 15_000

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function isVersion(value) {
  return typeof value === 'string' && VERSION.test(value)
}

/** Semantic-version order, prereleases included: negative when a < b. */
export function compareVersions(a, b) {
  const left = VERSION.exec(a)
  const right = VERSION.exec(b)
  if (!left || !right) throw new Error(`not a version: ${left ? b : a}`)
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i])
    if (diff) return Math.sign(diff)
  }
  // A release ranks above its prereleases.
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0
  const x = left[4].split('.')
  const y = right[4].split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    const xNum = /^\d+$/.test(x[i])
    const yNum = /^\d+$/.test(y[i])
    if (xNum && yNum) {
      const diff = Number(x[i]) - Number(y[i])
      if (diff) return Math.sign(diff)
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1
    } else if (x[i] !== y[i]) {
      return x[i] < y[i] ? -1 : 1
    }
  }
  return 0
}

/** `candidate` when it is newer than `installed`, else null. */
export function newer(installed, candidate) {
  return isVersion(installed) && isVersion(candidate) && compareVersions(candidate, installed) > 0 ? candidate : null
}

/**
 * The dsh release to move to, or null. A channel also takes the releases of the
 * more stable channels, so `alpha` never lags behind `latest`.
 * @param {{ installed: string, channel: string, distTags: Record<string, string>, companionVersions: string[] }} input
 */
export function pickUpdate({ installed, channel, distTags, companionVersions }) {
  const reach = UPDATE_CHANNELS.slice(0, Math.max(0, UPDATE_CHANNELS.indexOf(channel)) + 1)
  let best = null
  for (const tag of reach) {
    const version = distTags?.[tag]
    if (!isVersion(version)) continue
    // dsh-atomic-write is pinned to the same release; without it the install cannot succeed.
    if (!companionVersions.includes(version)) continue
    if (!best || compareVersions(version, best) > 0) best = version
  }
  return best ? newer(installed, best) : null
}

/** Runs npm in the project folder; resolves with its output. */
export function runNpm(args, { cwd, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    // npm is a .cmd script on Windows, which only a shell can start. Every
    // argument is a constant or a checked version, so the joined line is safe.
    const child = process.platform === 'win32'
      ? spawn(`npm ${args.join(' ')}`, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('npm', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`npm ${args[0]} が失敗しました（コード ${code}）\n${(stderr || stdout).trim().slice(-1500)}`))
    })
  })
}

/** Published releases, through npm so the user's registry and proxy settings apply. */
export async function lookupReleases({ cwd, npm = runNpm }) {
  const view = async (args) => JSON.parse((await npm(['view', ...args, '--json'], { cwd, timeoutMs: 60_000 })).stdout)
  const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }))
  const [dsh, companion, codex, claude] = await Promise.all([
    settle(view([DSH_PACKAGES[0], 'dist-tags'])),
    settle(view([DSH_PACKAGES[1], 'versions'])),
    settle(view([CODEX_PACKAGE, 'dist-tags'])),
    settle(view([CLAUDE_PACKAGE, 'dist-tags'])),
  ])
  return {
    dsh: dsh.error ?? companion.error
      ? { error: dsh.error ?? companion.error }
      : { distTags: dsh.value ?? {}, companionVersions: [companion.value].flat() },
    codex: codex.error ? { error: codex.error } : { latest: codex.value?.latest ?? null },
    claude: claude.error ? { error: claude.error } : { latest: claude.value?.latest ?? null },
  }
}

const claudeEnv = () => {
  const env = { ...process.env }
  for (const name of INHERITED_MARKERS) delete env[name]
  return env
}

/** Runs the installed `claude` with `args`; resolves with its output, null when it is not installed. */
export function runClaude(args, { timeoutMs = 30_000 } = {}) {
  const claude = findClaude()
  if (!claude) return Promise.resolve(null)
  const { file, args: argv } = launchCommand(claude, args)
  return new Promise((resolve, reject) => {
    execFile(file, argv, { env: claudeEnv(), timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${(stderr || stdout || error.message).trim().slice(-1500)}`))
      resolve(stdout)
    })
  })
}

/** The version `claude --version` reports ("2.1.3 (Claude Code)"), or null when it is not installed. */
export async function claudeVersion({ run = runClaude } = {}) {
  const output = await run(['--version'])
  if (output === null) return null
  const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0]
  if (!version) throw new Error(`claude --version の出力を読めません: ${output.trim().slice(0, 100)}`)
  return version
}

const RELEASE_NOTES = {
  dsh: (version) => `https://www.npmjs.com/package/${DSH_PACKAGES[0]}/v/${version}`,
  codex: (version) => `https://github.com/openai/codex/releases/tag/rust-v${version}`,
}
const NAMES = { dsh: 'Agent Desk の dsh（@deepseek-ai/dsh）', codex: 'Agent Desk に同梱の Codex app-server（@openai/codex）' }

/** The text handed to an AI agent: facts only; the steps live in the repository. */
export function updatePrompt(kind, { root, installed, available, channel }) {
  return [
    `${NAMES[kind]}を ${installed} から ${available} に更新してください${channel ? `（${channel} チャンネル）` : ''}。`,
    `リポジトリ: ${root}`,
    `リリースノート: ${RELEASE_NOTES[kind](available)}`,
    `手順はリポジトリの docs/updating.md に従ってください。互換性の問題で進められない場合は、変更を戻して理由を報告してください。`,
  ].join('\n')
}

function firstLine(error, max = 300) {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n').find((line) => line.trim())?.trim().slice(0, max) ?? ''
}

export class UpdateChecker extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.root   project folder
   * @param {{ dsh: string, codex: string }} options.installed  versions this server runs
   * @param {() => string} options.getChannel  dsh release channel
   * @param {object} [options.app]  Agent Desk itself: `installed`, `method` ('git', 'zip' or null when it
   *   cannot install), `lookup()` for the newest release, `install(release, setPhase)` and the last update's `result`
   */
  constructor({
    root, installed, getChannel, lookup = lookupReleases, readClaude = claudeVersion,
    updateClaude = () => runClaude(['update'], { timeoutMs: 600_000 }),
    source = fs.existsSync(path.join(root, '.git')), app = null, log = () => {},
  }) {
    super()
    Object.assign(this, { root, getChannel, lookup, readClaude, runClaudeUpdate: updateClaude, source, app, log })
    this.releases = null
    this.appRelease = null
    // A failed update stays on screen until the next try.
    this.appError = app?.result && !app.result.ok
      ? `${app.result.to} に更新できなかったので、元の版に戻しました: ${firstLine(app.result.error ?? '')}` : null
    this.state = {
      checking: false,
      checkedAt: null,
      // Without a git checkout there is no code for an agent to change: no prompts.
      source,
      dsh: { installed: installed.dsh, available: null, error: null, prompt: null },
      codex: { installed: installed.codex, available: null, error: null, prompt: null },
      claude: { installed: null, available: null, error: null, updating: false },
      app: app
        ? { installed: app.installed, available: null, url: null, method: app.method ?? null, phase: 'idle', error: this.appError }
        : null,
    }
    this.timer = null
    this.pending = null
  }

  snapshot() {
    return structuredClone(this.state)
  }

  #emit() {
    this.emit('state', this.snapshot())
  }

  /** Checks shortly after start and then every few hours. */
  start() {
    const schedule = (delay) => {
      this.timer = setTimeout(() => {
        void this.check()
        schedule(CHECK_INTERVAL_MS)
      }, delay)
      this.timer.unref?.()
    }
    schedule(FIRST_CHECK_MS)
  }

  stop() {
    clearTimeout(this.timer)
  }

  /** Asks the registry and the installed Claude Code; one item's failure leaves the others. */
  check() {
    this.pending ??= this.#check().finally(() => { this.pending = null })
    return this.pending
  }

  async #check() {
    this.state.checking = true
    this.#emit()
    const [releases, claude, ownRelease] = await Promise.all([
      this.lookup({ cwd: this.root }).catch((error) => ({ dsh: { error }, codex: { error }, claude: { error } })),
      this.readClaude().then((version) => ({ version }), (error) => ({ error })),
      this.app?.lookup().then((release) => ({ release }), (error) => ({ error })),
    ])
    if (ownRelease) this.#applyApp(ownRelease)
    this.releases = releases
    this.#apply()
    const item = this.state.claude
    item.installed = claude.version ?? null
    item.available = releases.claude.error ? null : newer(item.installed, releases.claude.latest)
    item.error = claude.error ? `バージョンを読めません: ${firstLine(claude.error)}`
      : releases.claude.error ? `確認に失敗しました: ${firstLine(releases.claude.error)}` : null
    this.state.checking = false
    this.state.checkedAt = Date.now()
    this.#emit()
    return this.snapshot()
  }

  /** Recomputes dsh and Codex from the last registry answer (also when the channel changes). */
  #apply() {
    const releases = this.releases
    if (!releases) return
    const channel = this.getChannel()
    const { dsh, codex } = this.state
    dsh.available = releases.dsh.error ? null : pickUpdate({ installed: dsh.installed, channel, ...releases.dsh })
    codex.available = releases.codex.error ? null : newer(codex.installed, releases.codex.latest)
    for (const [kind, item] of [['dsh', dsh], ['codex', codex]]) {
      const error = releases[kind].error
      item.error = error ? `確認に失敗しました: ${firstLine(error)}` : null
      item.prompt = item.available && this.source
        ? updatePrompt(kind, { root: this.root, installed: item.installed, available: item.available, channel: kind === 'dsh' ? channel : null })
        : null
    }
  }

  #applyApp({ release, error }) {
    const item = this.state.app
    if (!error) this.appRelease = release ?? null
    item.available = error ? null : newer(item.installed, release?.version)
    item.url = item.available ? release.url : null
    if (item.phase === 'idle') item.error = this.appError ?? (error ? `確認に失敗しました: ${firstLine(error)}` : null)
  }

  /**
   * The update button: downloads the release and hands over to the updater,
   * which restarts Agent Desk. Resolves while this server is shutting down;
   * a failure before that is shown on the row.
   */
  async installApp() {
    const item = this.state.app
    if (!item || item.phase !== 'idle') return this.snapshot()
    if (!item.available || !this.appRelease || !item.method) throw new Error('入れられる新しい版がありません')
    this.appError = item.error = null
    try {
      await this.app.install(this.appRelease, (phase) => {
        item.phase = phase
        this.#emit()
      })
    } catch (error) {
      item.phase = 'idle'
      this.appError = item.error = `更新できませんでした: ${firstLine(error)}`
      this.log('app update:', error.message)
      this.#emit()
    }
    return this.snapshot()
  }

  channelChanged() {
    this.#apply()
    this.#emit()
  }

  /** Runs `claude update`, then reads the version again. */
  async updateClaude() {
    const item = this.state.claude
    if (item.updating) return this.snapshot()
    item.updating = true
    item.error = null
    this.#emit()
    try {
      const output = await this.runClaudeUpdate()
      if (output === null) throw new Error('Claude Code が見つかりません')
      this.log('claude update:', firstLine(output))
      item.installed = await this.readClaude()
      if (item.available && item.installed && !newer(item.installed, item.available)) item.available = null
    } catch (error) {
      item.error = `更新に失敗しました: ${firstLine(error)}`
    } finally {
      item.updating = false
      this.#emit()
    }
    return this.snapshot()
  }
}
