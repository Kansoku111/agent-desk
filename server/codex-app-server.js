// OpenAI's bundled, version-pinned official app-server; never PATH codex or ~/.codex.
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
const require = createRequire(import.meta.url)
export const CODEX_VERSION = '0.164.0'
const APP_VERSION = require('../package.json').version
export function bundledCodex() {
  const pkg = require('@openai/codex/package.json')
  if (pkg.version !== CODEX_VERSION) throw new Error(`Agent Desk requires bundled Codex ${CODEX_VERSION}`)
  const triple = {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin'
  }[`${process.platform}-${process.arch}`]
  if (!triple) throw new Error('Bundled Codex does not support this platform')
  const root = path.dirname(require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`))
  return path.join(root, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
}
export const DISABLED_CODEX_FEATURES = [
  'apps', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser',
  'multi_agent', 'plugins', 'remote_plugin', 'skill_search', 'tool_suggest',
  'goals', 'hooks', 'realtime_conversation', 'workspace_dependencies',
  'worktrees', 'sleep_tool', 'shell_tool', 'unified_exec', 'view_image',
]
export function leanCodexConfig(home) {
  return `# Managed by Agent Desk; isolated image-generation runtime.
model_reasoning_effort = "low"
project_doc_max_bytes = 0
sandbox_mode = "read-only"
approval_policy = "never"
cli_auth_credentials_store = "file"
model_instructions_file = ${JSON.stringify(path.join(home, 'image-instructions.txt'))}
[features]
${DISABLED_CODEX_FEATURES.map(feature => `${feature} = false`).join('\n')}
code_mode_host = true
image_generation = true
`
}
export function codexEnvironment(home, source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => !/^(CODEX_|OPENAI_|CHATGPT_)/i.test(name)))
  return {
    ...env,
    CODEX_HOME: home,
    CODEX_MANAGED_BY_NPM: '1'
  }
}
export const CODEX_SIGNIN_HINT = '画像生成と利用上限を使うには、設定 → アカウント → 画像生成と利用上限（Codex）でサインインしてください。'
export class CodexAppServer extends EventEmitter {
  constructor({
    home,
    spawn: spawnImpl = spawn,
    command,
    args,
    idleMs = 300000,
    turnTimeoutMs = 300000,
    openUrl = () => {}
  }) {
    super()
    this.home = path.resolve(home)
    this.cwd = path.join(this.home, 'empty-cwd')
    this.runtimeHome = path.join(this.home, 'runtime-state', randomUUID())
    this.spawnImpl = spawnImpl
    this.command = command
    this.args = args
    this.idleMs = idleMs
    this.turnTimeoutMs = turnTimeoutMs
    this.openUrl = openUrl
    this.child = null
    this.starting = null
    this.startGeneration = 0
    this.pending = new Map()
    this.nextId = 0
    this.busy = 0
    this.login = {
      phase: 'idle'
    }
    this.accountState = {
      signedIn: false
    }
    this.queue = Promise.resolve()
  }
  async prepare() {
    await fs.mkdir(this.cwd, {
      recursive: true,
      mode: 0o700
    })
    await writeFileAtomic(path.join(this.home, 'config.toml'), leanCodexConfig(this.home), {
      mode: 0o600
    })
    const instructions = 'You create images.\n'
      + 'When asked, call the image generation tool exactly once with a detailed prompt, '
      + 'then reply with only: done\n'
    await writeFileAtomic(path.join(this.home, 'image-instructions.txt'), instructions, {
      mode: 0o600,
    })
  }
  start() {
    if (this.stopping) return this.stopping.then(() => this.start())
    if (this.starting) return this.starting
    const generation = this.startGeneration
    this.starting = this.startProcess(generation).catch(async error => {
      if (generation === this.startGeneration) await this.stop()
      throw error
    })
    return this.starting
  }
  async startProcess(generation) {
    await this.prepare()
    if (generation !== this.startGeneration) throw new Error('Codex app-server stopped during startup')
    await fs.mkdir(this.runtimeHome, { recursive: true, mode: 0o700 })
    if (generation !== this.startGeneration) throw new Error('Codex app-server stopped during startup')
    // Image threads are ephemeral; keep their diagnostic DB/logs ephemeral too.
    const args = this.args ?? [
      '-c', `sqlite_home=${JSON.stringify(this.runtimeHome)}`,
      '-c', `log_dir=${JSON.stringify(path.join(this.runtimeHome, 'log'))}`,
      'app-server', '--listen', 'stdio://',
    ]
    const child = this.spawnImpl(this.command ?? bundledCodex(), args, {
      cwd: this.cwd,
      env: codexEnvironment(this.home),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    child.stdin.on('error', () => this.fail(new Error('Codex transport closed')))
    // stderr may include service diagnostics; never forward raw auth/config/token material to logs/UI.
    child.stderr?.on('data', () => {})
    child.once('error', error => this.fail(new Error(`Bundled Codex could not start: ${error.code ?? 'spawn_error'}`)))
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null
        this.starting = null
        this.fail(new Error('Codex app-server stopped'))
      }
    })
    readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    }).on('line', line => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.method && message.id !== undefined) {
        // This image-only runtime never grants shell/file/network escalation or arbitrary client tools.
        child.stdin.write(JSON.stringify({
          id: message.id,
          error: {
            code: -32601,
            message: 'Agent Desk image runtime does not allow this operation'
          }
        }) + '\n')
      } else if (message.id !== undefined) {
        const request = this.pending.get(message.id)
        if (!request) return
        this.pending.delete(message.id)
        clearTimeout(request.timer)
        if (message.error) request.reject(new Error(`Codex ${request.method}: ${message.error.message ?? message.error.code}`))
        else request.resolve(message.result)
      } else if (message.method) this.notification(message.method, message.params ?? {})
    })
    await this.rawRequest('initialize', {
      clientInfo: {
        name: 'agent_desk',
        title: 'Agent Desk',
        version: APP_VERSION
      }
    })
    this.notify('initialized', {})
    this.scheduleIdle()
  }
  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }

    this.pending.clear()
    this.emit('stopped', error)
  }
  notify(method, params) {
    this.child?.stdin.write(JSON.stringify({
      method,
      params
    }) + '\n')
  }
  rawRequest(method, params = {}) {
    const child = this.child
    if (!child?.stdin) return Promise.reject(new Error('Codex transport closed'))
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out`))
      }, 30000)
      const cleanup = () => {
        clearTimeout(timer)
        this.pending.delete(id)
      }
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method
      })
      try {
        child.stdin.write(JSON.stringify({
          id,
          method,
          params
        }) + '\n', error => {
          if (error) {
            cleanup()
            reject(new Error('Codex transport write failed'))
          }
        })
      } catch {
        cleanup()
        reject(new Error('Codex transport write failed'))
      }
    })
  }
  async use(work) {
    clearTimeout(this.idleTimer)
    this.busy++
    try {
      await this.start()
      return await work()
    } finally {
      this.busy--
      this.scheduleIdle()
    }
  }
  scheduleIdle() {
    clearTimeout(this.idleTimer)
    if (this.busy || ['starting', 'browser', 'device'].includes(this.login.phase)) return
    this.idleTimer = setTimeout(() => {
      void this.stop().catch(error => console.error('[agent-desk] Codex idle shutdown failed:', error.message))
    }, this.idleMs)
    this.idleTimer.unref?.()
  }
  notification(method, params) {
    if (method === 'account/login/completed') {
      this.loginId = null
      clearTimeout(this.loginTimer)
      this.login = params.success ? {
        phase: 'done'
      } : {
        phase: 'error',
        message: 'Codex sign-in did not complete; retry sign-in.'
      }
      this.emit('login', this.login)
      void this.account().catch(() => {})
      this.scheduleIdle()
    }
    if (method === 'account/updated') void this.account().catch(() => {})
    if (method === 'account/rateLimits/updated') this.emit('rateLimits', params)
    this.emit('notification', method, params)
  }
  async account() {
    return this.use(async () => {
      const {
        account
      } = await this.rawRequest('account/read', {
        refreshToken: false
      })
      this.accountState = {
        signedIn: account?.type === 'chatgpt',
        email: account?.type === 'chatgpt' ? account.email ?? null : null,
        plan: account?.planType ?? null
      }
      this.emit('account', this.accountState)
      return this.accountState
    })
  }
  async loginStart(method = 'browser') {
    return this.use(async () => {
      await this.cancelLogin()
      this.login = {
        phase: 'starting'
      }
      this.emit('login', this.login)
      try {
        const result = await this.rawRequest('account/login/start', {
          type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt'
        })
        this.loginId = result.loginId
        this.login = result.type === 'chatgptDeviceCode' ? {
          phase: 'device',
          userCode: result.userCode,
          verificationUri: result.verificationUrl
        } : {
          phase: 'browser'
        }
        this.emit('login', this.login)
        await this.openUrl(result.authUrl ?? result.verificationUrl)
        this.loginTimer = setTimeout(() => void this.cancelLogin().catch(() => {}), 600000)
        this.loginTimer.unref?.()
        return this.login
      } catch (error) {
        this.login = {
          phase: 'error',
          message: 'Codex sign-in failed; try the device-code fallback.'
        }
        this.emit('login', this.login)
        throw error
      }
    })
  }
  async cancelLogin() {
    clearTimeout(this.loginTimer)
    if (this.loginId && this.child) await this.rawRequest('account/login/cancel', {
      loginId: this.loginId
    })
    this.loginId = null
    this.login = {
      phase: 'idle'
    }
    this.emit('login', this.login)
    this.scheduleIdle()
  }
  async logout() {
    return this.use(async () => {
      await this.cancelLogin()
      await this.rawRequest('account/logout')
      return this.account()
    })
  }
  async rateLimits() {
    return this.use(async () => {
      if (!(await this.account()).signedIn) return null
      return this.rawRequest('account/rateLimits/read')
    })
  }
  generate(options) {
    const task = this.queue.then(() => this.use(() => this.generateTurn(options)))
    this.queue = task.catch(() => {})
    return task
  }
  async generateTurn({
    prompt,
    references = [],
    size = 'auto',
    quality = 'auto',
    background = 'auto',
    format = 'png'
  }) {
    if (!(await this.account()).signedIn) throw new Error(CODEX_SIGNIN_HINT)
    const started = Date.now()
    const list = await this.rawRequest('model/list', {
      includeHidden: false
    })
    const models = list.data ?? []
    // Luna is economical for image orchestration; unavailable models use the account default.
    const model = models.find(entry => entry.model === 'gpt-6-luna')?.model
      ?? models.find(entry => entry.isDefault)?.model
      ?? models[0]?.model
    if (!model) throw new Error('Codex has no available image model')
    const {
      thread
    } = await this.rawRequest('thread/start', {
      model,
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      serviceName: 'agent_desk_images'
    })
    const threadId = thread.id
    if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new Error('Unexpected Codex image thread ID')
    const items = []
    let tokenUsage = null,
      timer,
      turnId
    let finish, fail
    const done = new Promise((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    done.catch(() => {})
    const listener = (method, params) => {
      if (params.threadId !== threadId) return
      if (method === 'item/completed') items.push(params.item)
      if (method === 'thread/tokenUsage/updated') tokenUsage = params.tokenUsage
      if (method === 'turn/completed') {
        if (params.turn?.status === 'completed') finish(params.turn)
        else fail(new Error(
          `Codex image turn ${params.turn?.status}: `
          + `${params.turn?.error?.message ?? 'no image completed'}`,
        ))
      }
    }
    const stopped = () => fail(new Error('Codex app-server stopped during image generation'))
    this.on('notification', listener)
    this.on('stopped', stopped)
    try {
      timer = setTimeout(() => fail(new Error('Codex image generation timed out')), this.turnTimeoutMs)
      const text = `Create one image with the image generation tool.
Prompt: ${prompt}
Requested size: ${size}; quality: ${quality}; background: ${background}; format: ${format}.
For references, edit/follow the attached local images. Call the tool exactly once, then reply only done.`
      const result = await this.rawRequest('turn/start', {
        threadId,
        effort: 'low',
        input: [{
          type: 'text',
          text
        }, ...references.map(file => ({
          type: 'localImage',
          path: path.resolve(file)
        }))]
      })
      turnId = result.turn?.id
      const turn = await done
      items.push(...(turn.items ?? []))
      const image = await this.imageResult(threadId, items)
      return {
        ...image,
        threadId,
        tokenUsage,
        elapsedMs: Date.now() - started,
        model
      }
    } catch (error) {
      if (turnId) await this.rawRequest('turn/interrupt', {
        threadId,
        turnId
      }).catch(() => {})
      throw error
    } finally {
      clearTimeout(timer)
      this.off('notification', listener)
      this.off('stopped', stopped)
      await this.rawRequest('thread/unsubscribe', {
        threadId
      }).catch(() => {})
      // Bytes are in memory now; workspace copying must not retain a second Codex copy.
      await this.cleanupImageThread(threadId).catch(error => console.warn('[agent-desk] Codex image cleanup failed:', error.message))
    }
  }
  /** Remove only this validated thread's generated output, never account/config files. */
  async cleanupImageThread(threadId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new Error('Invalid image cleanup thread ID')
    const parent = path.resolve(this.home, 'generated_images')
    const target = path.resolve(parent, threadId)
    if (path.dirname(target) !== parent) throw new Error('Invalid image cleanup target')
    const stat = await fs.lstat(target).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!stat) return
    if (stat.isSymbolicLink()) throw new Error('Refusing symlink image cleanup target')
    const realParent = await fs.realpath(parent)
    const realTarget = await fs.realpath(target)
    if (path.dirname(realTarget) !== realParent) throw new Error('Image cleanup escaped generated output')
    await fs.rm(realTarget, {
      recursive: true,
      force: true
    })
  }
  async imageResult(threadId, items) {
    const images = items.filter(item => item?.type === 'imageGeneration' && !item.failure && item.status === 'completed')
    const root = path.join(this.home, 'generated_images', threadId)
    const readImage = async file => {
      const real = await fs.realpath(file)
      const generatedRoot = await fs.realpath(root)
      if (!real.startsWith(generatedRoot + path.sep)) {
        throw new Error('Codex image path is outside this thread generated-images directory')
      }
      return fs.readFile(real)
    }
    let bytes = null,
      source = null
    const item = images.at(-1)
    if (item?.savedPath) {
      bytes = await readImage(item.savedPath)
      source = 'item.savedPath'
    } else if (item?.result && /^(?:data:image\/\w+;base64,)?[A-Za-z0-9+/=\r\n]+$/.test(item.result) && item.result.length > 64) {
      bytes = Buffer.from(item.result.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      source = 'item.result'
    }
    if (!bytes) {
      const files = (await fs.readdir(root).catch(() => [])).filter(file => /\.(png|jpe?g|webp)$/i.test(file)).sort()
      if (files.length) {
        bytes = await readImage(path.join(root, files.at(-1)))
        source = 'generated_images/threadId'
      }
    }
    if (!bytes?.length) throw new Error('Codex completed without an image result')
    const format = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      ? 'png'
      : bytes[0] === 255 && bytes[1] === 216
        ? 'jpeg'
        : bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null
    if (!format) throw new Error('Codex returned an unrecognized image format')
    return {
      bytes,
      format,
      source,
      revisedPrompt: item?.revisedPrompt ?? null,
      size: null
    }
  }
  /** Discard process-local diagnostics after exit; never prune auth or shared account DBs. */
  async cleanupRuntime() {
    const parent = path.resolve(this.home, 'runtime-state')
    const target = path.resolve(this.runtimeHome)
    if (path.dirname(target) !== parent) throw new Error('Invalid Codex runtime cleanup target')
    const stat = await fs.lstat(target).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error('Refusing Codex runtime cleanup symlink')
      const realParent = await fs.realpath(parent)
      const realTarget = await fs.realpath(target)
      if (path.dirname(realTarget) !== realParent) throw new Error('Invalid runtime cleanup location')
      await fs.rm(realTarget, { recursive: true, force: true }).catch(error => {
        if (!['EBUSY', 'EPERM', 'ENOENT'].includes(error.code)) throw error
        if (error.code !== 'ENOENT') console.warn('[agent-desk] Codex runtime cleanup deferred:', error.message)
      })
    }
    const sandboxLogs = path.join(this.home, '.sandbox')
    for (const name of await fs.readdir(sandboxLogs).catch(() => [])) {
      if (!/^sandbox\.\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
      const file = path.resolve(sandboxLogs, name)
      if (path.dirname(file) !== sandboxLogs) throw new Error('Invalid sandbox log cleanup target')
      if ((await fs.lstat(file)).isFile()) {
        await fs.rm(file, { force: true }).catch(error => {
          // Another app-owned Codex process may still have this diagnostic log open.
          if (!['EBUSY', 'EPERM', 'ENOENT'].includes(error.code)) throw error
          if (error.code !== 'ENOENT') console.warn('[agent-desk] Codex sandbox log cleanup deferred:', error.message)
        })
      }
    }
  }

  stop() {
    this.startGeneration++
    this.stopping ??= this.stopProcess().finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  async stopProcess() {
    clearTimeout(this.idleTimer)
    clearTimeout(this.loginTimer)
    const child = this.child
    this.child = null
    this.starting = null
    if (!child) {
      await this.cleanupRuntime()
      return
    }
    this.fail(new Error('Codex app-server stopped'))
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 1500)
      await exited
      clearTimeout(timer)
    }
    await this.cleanupRuntime()
  }
}
