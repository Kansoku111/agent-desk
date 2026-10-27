// One `dsh --profile acp` process per deployment permission mode. Ordinary
// permission changes start a new session with carryover; eco's explicit research
// transition resumes the same session in the writer process. The child plugin
// applies that process's policy to the resumed session before it can act.
// Agent teams' children have processes of their own, with an extra layer that
// takes their subagent tools away (dsh-config.js teamChildPatch).
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { dshEnv } from './dsh-env.js'
import { dshBin } from './paths.js'
import { STEERED_META, STEER_META } from './steer-patch.js'
import { GOAL_WAIT_CONFIG, GOAL_WAIT_AFTER_STEER } from './goal-wait.js'

// Runtime and update validation must compose the same hooks in the same order.
import { runtimeHookArgs } from './dsh-compatibility.js'

export { dshEnv }

export const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/** The runtime a thread's session runs in: its mode's, or the team children's of that mode. */
export const runtimeKey = (thread) => thread.ab ? (thread.ab.writable ? 'ab:write' : thread.ab.lean ? 'ab:lean' : 'ab:research') : (thread.team?.childId ? `team:${thread.permissionMode}` : thread.permissionMode)

const STDERR_TAIL = 16_000

export class AcpRuntime extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.mode           one of PERMISSION_MODES
   * @param {ReturnType<import('./paths.js').appPaths>} options.paths
   * @param {string[]} [options.patches]   extra layers (`dsh --patch`)
   * @param {(sessionId: string, update: object) => void} options.onUpdate
   * @param {(params: object) => Promise<object>} options.onPermission
   * @param {number} [options.startTimeoutMs]  how long dsh may take to start (tests shorten it)
   */
  constructor({ mode, paths, patches = [], onUpdate, onPermission, startTimeoutMs = 90_000 }) {
    super()
    this.mode = mode
    this.paths = paths
    this.patches = patches
    this.onUpdate = onUpdate
    this.onPermission = onPermission
    this.startTimeoutMs = startTimeoutMs
    this.state = 'stopped'
    this.child = null
    this.conn = null
    this.stderr = ''
    this.liveSessions = new Set()
    this.waitingSessions = new Set()
    this.goalWaitWrites = new Map()
    this.startPromise = null
    this.stopPromise = null
    this.stopTimedOut = false
  }

  start() {
    // A queued team report can arrive just as a deferred settings restart
    // closes stdin. Never hand it the still-resolved start of the old process.
    if (this.stopPromise) return this.stopPromise.then(() => this.start())
    this.startPromise ??= this.#start().catch((error) => {
      this.startPromise = null
      this.state = 'failed'
      this.#kill()
      throw error
    })
    return this.startPromise
  }

  async #start() {
    this.state = 'starting'
    await fs.mkdir(this.paths.runtimeCwd, { recursive: true })
    // The stop deadline can expire before the asynchronous directory creation.
    if (this.stopTimedOut) throw new Error('dsh stopped during startup')
    const env = dshEnv(this.paths, this.mode)
    const layers = this.patches.flatMap((file) => ['--patch', file])
    const child = spawn(process.execPath, [...runtimeHookArgs(), dshBin, '--profile', 'acp', ...layers], {
      cwd: this.paths.runtimeCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL)
    })
    child.on('exit', (code, signal) => {
      // A child killed after a stalled start can exit after the next start spawned: the state is the new child's.
      if (this.child !== child) return
      const wasReady = this.state === 'ready'
      this.state = 'stopped'
      this.conn = null
      this.child = null
      this.startPromise = null
      this.liveSessions.clear()
      this.waitingSessions.clear()
      this.goalWaitWrites.clear()
      this.emit('exit', { code, signal, wasReady, stderr: this.stderr })
    })
    child.on('error', (error) => {
      this.stderr += `\n${error.message}`
    })

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    this.conn = new ClientSideConnection(() => ({
      sessionUpdate: async (notification) => {
        this.onUpdate(notification.sessionId, notification.update)
      },
      requestPermission: (params) => this.onPermission(params),
    }), stream)

    const exited = new Promise((_, reject) => {
      child.once('exit', (code) => reject(new Error(`dsh exited during startup (code ${code})\n${this.stderr.slice(-2000)}`)))
    })
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`dsh did not finish starting within ${Math.round(this.startTimeoutMs / 1000)}s\n${this.stderr.slice(-2000)}`)), this.startTimeoutMs).unref()
    })
    const init = await Promise.race([
      this.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      exited,
      timeout,
    ])
    this.agentInfo = init.agentInfo
    this.capabilities = init.agentCapabilities
    this.state = 'ready'
    return this
  }

  #requireConn() {
    if (!this.conn || this.state !== 'ready') throw new Error('エージェントの実行環境が起動していません')
    return this.conn
  }

  async newSession(cwd, mcpServers = []) {
    const result = await this.#requireConn().newSession({ cwd, mcpServers })
    this.liveSessions.add(result.sessionId)
    return result
  }

  async resumeSession(sessionId, cwd, mcpServers = []) {
    const result = await this.#requireConn().resumeSession({ sessionId, cwd, mcpServers })
    this.liveSessions.add(sessionId)
    return result
  }

  async setOption(sessionId, configId, value) {
    const result = await this.#requireConn().setSessionConfigOption({ sessionId, configId, value })
    return result.configOptions
  }

  /** Set a session-local automatic-round gate; explicit prompts remain admissible. */
  async setGoalWaiting(sessionId, waiting) {
    await this.#goalWaitOption(sessionId, waiting ? 'waiting' : 'ready')
  }

  #goalWaitSerial(sessionId, write) {
    const previous = this.goalWaitWrites.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(write)
    this.goalWaitWrites.set(sessionId, current)
    return current.finally(() => {
      if (this.goalWaitWrites.get(sessionId) === current) this.goalWaitWrites.delete(sessionId)
    })
  }

  #goalWaitOption(sessionId, value) {
    return this.#goalWaitSerial(sessionId, () => this.#applyGoalWaitOption(sessionId, value))
  }

  async #applyGoalWaitOption(sessionId, value) {
    const options = await this.setOption(sessionId, GOAL_WAIT_CONFIG, value)
    if (options?.find((option) => option.id === GOAL_WAIT_CONFIG)?.currentValue !== value) throw new Error('team goal-wait was not applied; restart Agent Desk')
    if (value === 'ready') this.waitingSessions.delete(sessionId)
    else this.waitingSessions.add(sessionId)
  }

  prompt(sessionId, prompt) {
    return this.#requireConn().prompt({ sessionId, prompt })
  }

  /**
   * Adds a message to the session's running turn (see steer-hook.js).
   * @returns whether dsh took it; false when it has no steering support
   */
  async steer(sessionId, prompt, goalWaiting) {
    const write = async () => {
      const meta = { [STEER_META]: true }
      if (typeof goalWaiting === 'boolean') meta[GOAL_WAIT_AFTER_STEER] = goalWaiting
      const result = await this.#requireConn().prompt({ sessionId, prompt, _meta: meta })
      const accepted = result?._meta?.[STEERED_META] === true
      if (accepted && typeof goalWaiting === 'boolean') {
        if (goalWaiting) this.waitingSessions.add(sessionId)
        else this.waitingSessions.delete(sessionId)
      }
      return accepted
    }
    return typeof goalWaiting === 'boolean' ? this.#goalWaitSerial(sessionId, write) : write()
  }

  async cancel(sessionId, controlled = false) {
    if (!this.conn) return
    await this.#goalWaitSerial(sessionId, async () => {
      if (!this.conn) return
      if (controlled || this.waitingSessions.has(sessionId)) await this.#applyGoalWaitOption(sessionId, 'cancelled')
      else await this.conn.cancel({ sessionId })
    })
  }

  async closeSession(sessionId) {
    if (!this.liveSessions.has(sessionId)) return
    await this.goalWaitWrites.get(sessionId)?.catch(() => {})
    this.liveSessions.delete(sessionId)
    this.waitingSessions.delete(sessionId)
    if (this.conn) await this.conn.closeSession({ sessionId })
  }

  #kill(child = this.child) {
    try {
      child?.kill()
    } catch {}
  }

  /** Graceful stop: stdin EOF lets dsh drain sessions and flush persistence. */
  stop(graceMs = 5000) {
    this.stopPromise ??= this.#stop(graceMs).finally(() => { this.stopPromise = null })
    return this.stopPromise
  }

  async #stop(graceMs) {
    // The grace period also covers startup: a stalled initialization must not
    // postpone shutdown until the much longer startup timeout.
    const timer = setTimeout(() => { this.stopTimedOut = true; this.#kill() }, graceMs)
    try {
      await this.startPromise?.catch(() => {})
      const child = this.child
      this.state = 'stopped'
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((resolve) => child.once('exit', resolve))
      try {
        child.stdin.end()
      } catch {}
      await exited
    } finally {
      clearTimeout(timer)
      this.stopTimedOut = false
    }
  }
}

/**
 * Lazily started runtimes, one per permission mode, and one per mode for
 * agent teams' children (`team:<mode>`, see {@link runtimeKey}).
 */
export class RuntimePool extends EventEmitter {
  constructor({ paths, onUpdate, onPermission }) {
    super()
    this.runtimes = new Map()
    for (const mode of PERMISSION_MODES) {
      for (const [key, patches] of [[mode, []], [`team:${mode}`, [paths.teamChildPatch]]]) {
        const runtime = new AcpRuntime({ mode, paths, patches, onUpdate, onPermission })
        runtime.on('exit', (info) => this.emit('exit', { mode, key, ...info }))
        this.runtimes.set(key, runtime)
      }
    }
    for (const [key, mode, patch] of [['ab:lean', 'read-only', paths.abLeanPatch], ['ab:research', 'read-only', paths.abResearchPatch], ['ab:write', 'danger-full-access', paths.abWritePatch], ['plan', 'read-only', paths.planPatch]]) {
      if (!patch) continue
      const runtime = new AcpRuntime({ mode, paths, patches: [patch], onUpdate, onPermission })
      runtime.on('exit', (info) => this.emit('exit', { mode, key, ...info }))
      this.runtimes.set(key, runtime)
    }
    this.paused = false
  }

  /** @param {string} key  a permission mode, or `team:<mode>` ({@link runtimeKey}) */
  async get(key) {
    const runtime = this.runtimes.get(key)
    if (!runtime) throw new Error(`unknown permission mode: ${key}`)
    while (true) {
      if (this.paused) throw new Error('dsh を更新しています。完了してからもう一度送信してください。')
      // Do not start a replacement if the pool was paused while this get waited.
      if (runtime.stopPromise) {
        await runtime.stopPromise
        continue
      }
      await runtime.start()
      if (this.paused) throw new Error('dsh を更新しています。完了してからもう一度送信してください。')
      // A recycle can begin while awaiting an already-ready start.
      if (!runtime.stopPromise) return runtime
    }
  }

  /** Stops every runtime and keeps them stopped (while dsh itself is replaced). */
  async pause() {
    this.paused = true
    await this.stopAll()
  }

  resume() {
    this.paused = false
  }

  /** The runtime that currently holds a live session, if any. */
  holderOf(sessionId) {
    for (const runtime of this.runtimes.values()) {
      if (runtime.liveSessions.has(sessionId)) return runtime
    }
    return null
  }

  /** Each permission mode's runtime (the children's are not shown). */
  status() {
    return Object.fromEntries(PERMISSION_MODES.map((mode) => [mode, this.runtimes.get(mode).state]))
  }

  async stopAll() {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.stop()))
  }
}
