// Keeps the embedded dsh up to date.
//
// dsh is a developer preview whose releases often break compatibility, so an
// update is never a blind `npm install`:
//   1. the npm registry is asked for the newest release on the chosen channel,
//   2. once no task is running, the runtimes stop and package.json,
//      package-lock.json and the dsh home are backed up,
//   3. dsh (and dsh-atomic-write, which must match it) is installed,
//   4. a fresh process boots the new dsh the way Agent Desk uses it
//      (scripts/check-dsh.mjs),
//   5. on failure everything is put back; on success the server restarts so
//      it runs against the new release.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeJson } from './json-file.js'

export const DSH_PACKAGES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-atomic-write']

/** Release channels (npm dist-tags), from the most to the least stable. */
export const UPDATE_CHANNELS = ['latest', 'next', 'alpha']

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 15_000
const RESTART_TIMEOUT_MS = 90_000
const VERIFY_TIMEOUT_MS = 180_000

/** Phases during which dsh must not run and the server must not be replaced. */
const LOCKED = new Set(['installing', 'verifying', 'rolling-back', 'recovery-required'])
const INTERRUPTED = new Set(['installing', 'verifying', 'rolling-back', 'recovery-required'])
const PHASES = new Set(['idle', 'checking', 'available', 'waiting', 'restarting', ...INTERRUPTED])
const RECOVERY_STAGES = new Set(['lock', 'backup', 'install', 'verify', 'unknown'])

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function isVersion(value) {
  return typeof value === 'string' && VERSION.test(value)
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isStringMap = (value) => isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
const isTimestamp = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

function validRecovery(value) {
  if (!isRecord(value) || !RECOVERY_STAGES.has(value.stage)) return false
  const unknown = value.stage === 'unknown'
  return (isVersion(value.from) || (unknown && value.from === null))
    && (isVersion(value.version) || (unknown && value.version === null))
    && typeof value.packages === 'boolean' && typeof value.home === 'boolean'
    && isStringMap(value.errors)
}

/** Legacy metadata had no phase; accept it without trusting malformed journals. */
function validJournal(value) {
  if (!isRecord(value)) return false
  if ('phase' in value && !PHASES.has(value.phase)) return false
  if ('installed' in value && !isVersion(value.installed)) return false
  for (const field of ['target', 'available']) {
    if (field in value && value[field] !== null && !isVersion(value[field])) return false
  }
  if ('checkedAt' in value && value.checkedAt !== null && !isTimestamp(value.checkedAt)) return false
  if ('error' in value && value.error !== null && typeof value.error !== 'string') return false
  if ('failed' in value && (!isStringMap(value.failed) || !Object.keys(value.failed).every(isVersion))) return false
  if (value.lastResult !== undefined && value.lastResult !== null) {
    const result = value.lastResult
    if (!isRecord(result) || typeof result.ok !== 'boolean' || !isVersion(result.from) || !isVersion(result.to) || !isTimestamp(result.at)) return false
    if ('error' in result && typeof result.error !== 'string') return false
    if ('recovered' in result && typeof result.recovered !== 'boolean') return false
  }
  if (value.recovery !== undefined && value.recovery !== null && !validRecovery(value.recovery)) return false
  if (INTERRUPTED.has(value.phase) && !validRecovery(value.recovery)) return false
  return true
}

function unknownRecovery(error) {
  return { from: null, version: null, stage: 'unknown', packages: true, home: true, errors: { state: firstLine(error) } }
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

/**
 * The release to move to, or null. A channel also takes the releases of the
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
  return best && compareVersions(best, installed) > 0 ? best : null
}

function lastLine(text) {
  return text.trim().split('\n').at(-1) ?? ''
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

/** Published dsh releases, through npm so the user's registry and proxy settings apply. */
export async function lookupReleases({ cwd, npm = runNpm }) {
  const [main, companion] = await Promise.all([
    npm(['view', DSH_PACKAGES[0], 'dist-tags', 'versions', '--json'], { cwd, timeoutMs: 60_000 }),
    npm(['view', DSH_PACKAGES[1], 'versions', '--json'], { cwd, timeoutMs: 60_000 }),
  ])
  const info = JSON.parse(main.stdout)
  const versions = JSON.parse(companion.stdout)
  return { distTags: info['dist-tags'] ?? {}, companionVersions: Array.isArray(versions) ? versions : [versions] }
}

/** Boots the installed dsh in a fresh process (scripts/check-dsh.mjs). */
export function verifyInstall({ root, timeoutMs = VERIFY_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'check-dsh.mjs')], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
      let report = null
      try {
        report = JSON.parse(lastLine(stdout))
      } catch {}
      if (code === 0 && report?.ok && report.compatibility?.ok === true) return resolve(report)
      reject(new Error(report?.error ?? (code === 0 && report?.ok
        ? '必須の互換性検証結果が返されませんでした'
        : `動作確認が終了しませんでした（コード ${code}）\n${stderr.trim().slice(-1500)}`)))
    })
  })
}

export class DshUpdater extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.root          project folder (package.json, node_modules)
   * @param {string} options.home          Agent Desk data folder
   * @param {string} options.dshHome       dsh home inside it
   * @param {string} options.installed     dsh version this server runs
   * @param {() => { channel: string, auto: boolean }} options.getSettings
   * @param {() => boolean} options.isBusy  true while an agent works
   * @param {() => Promise<void>} options.lock     stops the runtimes and keeps them from starting
   * @param {() => void} options.unlock
   * @param {() => Promise<boolean>} options.restart  replaces this server; false when it cannot
   */
  constructor({
    root, home, dshHome, installed, getSettings, isBusy, lock, unlock, restart,
    npm = runNpm, lookup = lookupReleases, verify = verifyInstall, log = () => {},
    restoreHome = restoreDir, saveState = writeJson,
  }) {
    super()
    Object.assign(this, { root, home, dshHome, getSettings, isBusy, lock, unlock, restart, npm, lookup, verify, log, restoreHome, saveState })
    this.file = path.join(home, 'dsh-update.json')
    this.backupDir = path.join(home, 'dsh-update-backup')
    this.state = {
      phase: 'idle',
      installed,
      available: null,
      target: null,
      checkedAt: null,
      error: null,
      failed: {},
      lastResult: null,
      recovery: null,
    }
    this.timer = null
    this.saveChain = Promise.resolve()
  }

  async load() {
    let saved
    try {
      // Unlike preferences, an unreadable transaction journal must fail closed.
      saved = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (!validJournal(saved)) throw new Error('invalid update journal or recovery shape')
    } catch (error) {
      if (error.code === 'ENOENT') return this
      this.#set({
        phase: 'recovery-required',
        recovery: unknownRecovery(error),
        error: '更新の復旧記録を読めません。実行を停止しています。バックアップを確認し、設定の「復旧を再試行」を実行してください。',
      })
      return this
    }
    this.state.checkedAt = saved.checkedAt ?? null
    this.state.failed = saved.failed ?? {}
    this.state.lastResult = saved.lastResult ?? null
    if (INTERRUPTED.has(saved.phase) || saved.recovery) {
      this.#set({
        phase: 'recovery-required',
        target: saved.target ?? null,
        available: saved.available ?? null,
        recovery: saved.recovery,
        error: saved.error ?? '前回の更新が途中で終了しました。実行を停止しています。設定の「復旧を再試行」で元の状態に戻してください。',
      })
    }
    return this
  }

  snapshot() {
    return structuredClone(this.state)
  }

  /** True while dsh is being replaced: no runtime may start and the server must stay. */
  get locked() {
    return LOCKED.has(this.state.phase)
  }

  /** True from the install until the restart: new tasks have to wait. */
  get blocking() {
    return this.locked || this.state.phase === 'restarting'
  }

  #set(patch) {
    Object.assign(this.state, patch)
    this.emit('state', this.snapshot())
  }

  async #save(patch = {}) {
    // Serialize snapshots: an older registry check must not overwrite the journal.
    const saved = { ...this.snapshot(), ...patch }
    const pending = this.saveChain.then(() => this.saveState(this.file, saved))
    this.saveChain = pending.catch(() => {})
    await pending
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

  /** Asks the registry for a newer release; with auto update on, installs it. */
  async check() {
    if (this.blocking || this.state.phase === 'checking' || this.state.phase === 'waiting') return this.snapshot()
    this.#set({ phase: 'checking', error: null })
    try {
      const releases = await this.lookup({ cwd: this.root, npm: this.npm })
      const { channel } = this.getSettings()
      let available = pickUpdate({ installed: this.state.installed, channel, ...releases })
      this.#set({ phase: available ? 'available' : 'idle', available, checkedAt: Date.now() })
      await this.#save()
      // Settings may have changed while the registry was being checked or state saved.
      const latest = this.getSettings()
      available = pickUpdate({ installed: this.state.installed, channel: latest.channel, ...releases })
      const autoInstall = available && latest.auto && !this.state.failed[available]
      if (available !== this.state.available) {
        this.#set({ phase: available ? 'available' : 'idle', available })
        if (!autoInstall) await this.#save()
      }
      if (autoInstall) {
        this.log(`dsh ${available} is available; updating automatically`)
        await this.apply(available)
      }
    } catch (error) {
      if (!this.blocking) this.#set({ phase: this.state.available ? 'available' : 'idle', error: `更新の確認に失敗しました: ${firstLine(error)}` })
      else this.log('update remains blocked:', firstLine(error))
    }
    return this.snapshot()
  }

  /** Installs `version` now, or as soon as no task is running. */
  async apply(version) {
    if (this.blocking) throw new Error(this.state.phase === 'recovery-required' ? 'dsh の復旧が必要です。設定から復旧を再試行してください' : 'dsh を更新しています')
    if (!['available', 'waiting'].includes(this.state.phase) || !version || version !== this.state.available) throw new Error('インストールできるバージョンではありません。もう一度確認してください')
    if (this.isBusy()) {
      this.#set({ phase: 'waiting', target: version, error: null })
      return this.snapshot()
    }
    await this.#install(version)
    return this.snapshot()
  }

  /** Called when a task finishes: a waiting update starts once all are done. */
  onIdle() {
    if (this.state.phase !== 'waiting' || this.isBusy()) return
    void this.#install(this.state.target).catch((error) => this.log('update failed:', error.message))
  }

  cancel() {
    if (this.state.phase === 'waiting') this.#set({ phase: 'available', target: null })
    return this.snapshot()
  }

  async #install(version) {
    const from = this.state.installed
    // Synchronously, before any await: no turn may start from here on.
    this.#set({
      phase: 'installing', target: version, error: null,
      recovery: { from, version, stage: 'lock', packages: false, home: false, errors: {} },
    })
    this.log(`updating dsh ${from} -> ${version}`)
    let stage = 'lock'
    try {
      // Persist before stopping runtimes or changing any installed files.
      await this.#save()
      await this.lock()
      stage = 'backup'
      await this.#backup(from)
      stage = 'install'
      Object.assign(this.state.recovery, { stage, packages: true })
      await this.#save()
      await this.npm(['install', '--save-exact', '--no-audit', '--no-fund', ...DSH_PACKAGES.map((name) => `${name}@${version}`)], { cwd: this.root })
      stage = 'verify'
      this.state.recovery.stage = stage
      this.state.recovery.home = true
      this.#set({ phase: 'verifying' })
      await this.#save()
      await this.verify({ root: this.root })
      // Commit the successful transaction before advertising success.
      await this.#save({ phase: 'restarting', installed: version, available: null, recovery: null,
        failed: Object.fromEntries(Object.entries(this.state.failed).filter(([key]) => key !== version)),
        lastResult: { ok: true, from, to: version, at: Date.now() } })
    } catch (error) {
      await this.#rollBack({ from, version, error, stage })
      return
    }
    const lastResult = { ok: true, from, to: version, at: Date.now() }
    this.state.failed = Object.fromEntries(Object.entries(this.state.failed).filter(([key]) => key !== version))
    this.#set({ phase: 'restarting', installed: version, available: null, lastResult, recovery: null })
    this.log(`dsh ${version} installed and verified`)
    let restarting = false
    try {
      restarting = await this.restart()
    } catch (error) {
      this.log('restart failed:', error.message)
    }
    if (!restarting) {
      // New runtimes start the new dsh from disk; only this server's own modules stay old.
      this.unlock()
      this.#set({ phase: 'idle', target: null })
      return
    }
    // The new server asks this one to quit. If that never happens, carry on here.
    setTimeout(() => {
      if (this.state.phase !== 'restarting') return
      this.unlock()
      this.#set({ phase: 'idle', target: null, error: 'アプリを自動で再起動できませんでした。新しい dsh は次のタスクから使われます。表示を更新するにはアプリを開き直してください' })
    }, RESTART_TIMEOUT_MS).unref?.()
  }

  async #backup(from) {
    await fs.rm(this.backupDir, { recursive: true, force: true })
    await fs.mkdir(this.backupDir, { recursive: true })
    for (const name of ['package.json', 'package-lock.json']) {
      await fs.copyFile(path.join(this.root, name), path.join(this.backupDir, name))
    }
    await fs.cp(this.dshHome, path.join(this.backupDir, 'dsh-home'), { recursive: true })
    await fs.writeFile(path.join(this.backupDir, 'RECOVERY.md'), this.#recoveryGuide(from), 'utf8')
    await writeJson(path.join(this.backupDir, 'backup.json'), { dshVersion: from, at: Date.now() })
  }

  #recoveryGuide(from) {
    const quote = (text) => `'${text.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
    const commands = process.platform === 'win32'
      ? [
        `$backup = ${quote(this.backupDir)}`, `$project = ${quote(this.root)}`,
        ...['package.json', 'package-lock.json'].map((name) => `Copy-Item -LiteralPath (Join-Path $backup '${name}') -Destination (Join-Path $project '${name}') -Force`),
        'Set-Location -LiteralPath $project', 'npm ci --no-audit --no-fund',
      ]
      : [
        ...['package.json', 'package-lock.json'].map((name) => `cp -- ${quote(path.join(this.backupDir, name))} ${quote(path.join(this.root, name))}`),
        `cd -- ${quote(this.root)}`, 'npm ci --no-audit --no-fund',
      ]
    return [
      '# dsh 更新からの復旧', '', `復旧先: dsh ${from}`, '',
      '通常はアプリの設定 → dsh のアップデート →「復旧を再試行」を使用します。',
      'npm 復旧の失敗でアプリ自体が起動できない場合は、以下の順で復旧してください。', '',
      '1. Agent Desk とその dsh プロセスをすべて停止します。バックアップは削除しないでください。',
      '2. ネットワーク、ディスク空き容量、書き込み権限を確認し、ターミナルで次を順に実行します。失敗したコマンドがあれば原因を解消してから再実行してください。', '',
      `\`\`\`${process.platform === 'win32' ? 'powershell' : 'sh'}`, ...commands, '```', '',
      '3. npm ci が成功したら、通常どおりアプリを起動します。更新の復旧待ちとして実行が停止されたままになるのが正常です。',
      '4. 設定 → dsh のアップデート →「復旧を再試行」を実行します。残っているパッケージ・データの補償を完了し、安全に実行を再開します。', '',
      `状態記録: ${this.file}`,
      `データ復旧先: ${this.dshHome}`,
      '状態記録（dsh-update.json）を削除・編集して停止を解除しないでください。バックアップの dsh-home はデータ復旧完了まで保存してください。', '',
    ].join('\n')
  }

  /** Explicit user action; check/apply/cancel never clear a recovery barrier. */
  async retryRecovery() {
    if (this.state.phase !== 'recovery-required') throw new Error('再試行が必要な復旧はありません')
    if (this.isBusy()) throw new Error('作業中のタスクが終わってから復旧してください')
    // Validate again at the boundary; never interpret missing/truthy flags as
    // proof that compensation finished, even if an in-memory caller altered it.
    if (!validRecovery(this.state.recovery)) this.state.recovery = unknownRecovery(new Error('invalid recovery state'))
    this.#set({ phase: 'rolling-back' })
    const recovery = this.state.recovery
    try {
      await this.lock()
      // A damaged legacy journal can still recover from a complete backup.
      if (recovery.stage === 'unknown') {
        const backup = JSON.parse(await fs.readFile(path.join(this.backupDir, 'backup.json'), 'utf8'))
        if (!isRecord(backup) || !isVersion(backup.dshVersion)) throw new Error('バックアップのバージョンを確認できません')
        recovery.from = backup.dshVersion
      }
      delete recovery.errors.lock
      delete recovery.errors.retry
      await this.#save()
      await this.#compensate()
    } catch (error) {
      // Include compensation/unlock failures, not just preparation failures:
      // the user must always be able to retry instead of getting stuck mid-phase.
      if (!validRecovery(this.state.recovery)) this.state.recovery = unknownRecovery(error)
      this.state.recovery.errors.retry = firstLine(error)
      // unlock may have partially resumed the pool before throwing.
      try { await this.lock() } catch (cause) { this.state.recovery.errors.lock = firstLine(cause) }
      await this.#requireRecovery()
    }
    return this.snapshot()
  }

  /** Undoes what the update changed, with independent package/home compensation. */
  async #rollBack({ from, version, error, stage }) {
    const message = firstLine(error, 400)
    this.log(`dsh ${version} failed (${message}); rolling back to ${from}`)
    this.state.failed = { ...this.state.failed, [version]: message }
    this.#set({
      phase: 'rolling-back',
      lastResult: { ok: false, from, to: version, at: Date.now(), error: message, recovered: false },
    })
    this.state.recovery.stage = stage
    await this.#save().catch((cause) => this.log('could not journal rollback:', firstLine(cause)))
    await this.#compensate()
  }

  async #compensate() {
    const recovery = this.state.recovery
    // Do NOT put these in a shared try: a failed npm restore must never skip home.
    for (const [part, restore] of [
      ['packages', async () => {
        const errors = []
        for (const name of ['package.json', 'package-lock.json']) {
          await fs.copyFile(path.join(this.backupDir, name), path.join(this.root, name)).catch((error) => errors.push(error))
        }
        if (errors.length) throw new AggregateError(errors, errors.map((error) => firstLine(error)).join('; '))
        // ci installs the backed-up lock exactly instead of resolving new versions.
        await this.npm(['ci', '--no-audit', '--no-fund'], { cwd: this.root })
      }],
      ['home', () => this.restoreHome(path.join(this.backupDir, 'dsh-home'), this.dshHome)],
    ]) {
      if (!recovery[part]) continue
      try {
        await restore()
        recovery[part] = false
        delete recovery.errors[part]
      } catch (error) {
        recovery.errors[part] = firstLine(error)
        this.log(`${part} recovery failed:`, firstLine(error))
      }
      // Keeping an older journal is safe: retrying either compensation is idempotent.
      await this.#save().catch((error) => this.log('could not journal recovery:', firstLine(error)))
    }
    if (recovery.packages || recovery.home) return this.#requireRecovery()

    const { from, version, stage } = recovery
    const lastResult = this.state.lastResult
      ? { ...this.state.lastResult, ok: false, recovered: true }
      : { ok: false, from, to: version ?? from, at: Date.now(), recovered: true }
    const completed = {
      phase: this.state.available ? 'available' : 'idle', installed: from ?? this.state.installed,
      target: null, recovery: null, lastResult,
      error: `dsh ${version ?? ''} の${{ install: 'インストール', verify: '動作確認' }[stage] ?? '準備'}に失敗したため、${from ?? this.state.installed} のまま使います: ${lastResult.error ?? '中断した更新から復旧しました'}`,
    }
    try {
      // Never unlock or emit rolled-back until the cleared barrier is durable.
      await this.#save(completed)
    } catch (error) {
      recovery.errors.state = firstLine(error)
      return this.#requireRecovery()
    }
    this.unlock()
    this.#set(completed)
    this.emit('rolled-back', { from, version, error: lastResult.error })
  }

  async #requireRecovery() {
    const details = Object.entries(this.state.recovery.errors).map(([part, message]) => `${part}: ${message}`).join('; ')
    this.#set({
      phase: 'recovery-required',
      error: `dsh の復旧が完了していないため実行を停止しています。設定の「復旧を再試行」を実行してください。${details}`,
    })
    // The pre-mutation journal already blocks a restart even if this write fails.
    await this.#save().catch((error) => this.log('could not save recovery-required state:', firstLine(error)))
  }
}

function firstLine(error, max = 300) {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n').find((line) => line.trim())?.trim().slice(0, max) ?? ''
}

/**
 * Restores an exact backup, removing nested migration artifacts too. Keep the
 * watched root and the backup itself so a partial failure can be retried.
 */
async function restoreDir(source, target) {
  await fs.access(source)
  const entries = await fs.readdir(target).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const name of entries) await fs.rm(path.join(target, name), { recursive: true, force: true })
  await fs.cp(source, target, { recursive: true, force: true })
}
