// Claude Code without its terminal: `claude -p` writing its events as JSON
// lines (--output-format stream-json), one process per turn, each resuming the
// same session. A team's Claude children run this way. The end of a turn, its
// reply and every tool call come from Claude Code's own output, not from hooks
// or the screen, and a message is handed over on stdin, not typed into a box.
//
// It is the same `claude` the user signed in to, so it runs on their Claude
// subscription. The first event says where its credentials come from; a run
// that would use an API key is stopped before it asks the model anything.
import { spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { readJson, writeJson } from './json-file.js'
import { API_KEY_ENV, INHERITED_MARKERS, findClaude, launchCommand } from './terminals.js'

/** Turns kept per session (older ones drop off; Claude Code keeps the whole conversation itself). */
const TURNS_KEPT = 60
/** The longest tool output kept for the view. */
const OUTPUT_KEEP = 8000
const STDERR_TAIL = 4000
/** How long a stopped run may take to exit before it is killed outright. */
const KILL_WAIT_MS = 5000
/** Credentials a run may use: Claude Code's own sign-in, never an API key. */
const SUBSCRIPTION_SOURCES = new Set(['none', undefined])

const CUT_OFF = 'Agent Desk が終了したため、作業が途中で止まりました。'

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** A tool result's content (a string or text blocks) as text. */
function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content)
  return content.map((block) => (block?.type === 'text' ? block.text : block?.type === 'image' ? '[画像]' : JSON.stringify(block))).join('\n')
}

/**
 * Folds one stream-json event into a turn (the shape the UI's TurnView shows).
 * Returns true when the turn changed.
 */
export function applyEvent(turn, event, now = Date.now()) {
  if (event?.type === 'assistant') {
    let changed = false
    for (const [index, block] of (event.message?.content ?? []).entries()) {
      const id = `${event.message?.id ?? event.uuid}-${index}`
      if (block?.type === 'text' && block.text?.trim()) {
        turn.items.push({ type: 'agent', id, text: block.text })
        changed = true
      } else if (block?.type === 'thinking' && block.thinking?.trim()) {
        turn.items.push({ type: 'thought', id, text: block.thinking })
        changed = true
      } else if (block?.type === 'tool_use') {
        turn.items.push({
          type: 'tool', id: block.id, name: block.name, kind: 'other', status: 'in_progress',
          input: block.input && typeof block.input === 'object' ? block.input : {}, startedAt: now,
        })
        changed = true
      }
    }
    return changed
  }
  if (event?.type === 'user') {
    let changed = false
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block?.type !== 'tool_result') continue
      const item = turn.items.find((entry) => entry.type === 'tool' && entry.id === block.tool_use_id)
      if (!item) continue
      item.output = clip(resultText(block.content), OUTPUT_KEEP)
      item.status = block.is_error ? 'failed' : 'completed'
      item.endedAt = now
      changed = true
    }
    return changed
  }
  return false
}

export class ClaudeRunner extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.dir  one file per session: its settings and recent turns
   * @param {() => string|null} [options.findClaude]
   * @param {typeof spawnProcess} [options.spawn]
   */
  constructor({ dir, findClaude: find = () => findClaude(), spawn = spawnProcess, log = () => {}, now = Date.now, platform = process.platform }) {
    super()
    this.dir = dir
    this.findClaude = find
    this.spawn = spawn
    this.log = log
    this.now = now
    this.platform = platform
    /** @type {Map<string, object>} sessions by id */
    this.records = new Map()
    /** The running turn of a session: { proc, turn, stopping, apiKey, stderr, result, exited } */
    this.live = new Map()
    this.writes = new Map()
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true })
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.json')) continue
      const saved = await readJson(path.join(this.dir, name), null).catch(() => null)
      if (typeof saved?.id !== 'string' || typeof saved.sessionId !== 'string') continue
      const record = { turns: [], args: [], ...saved }
      // A turn the app's exit cut off.
      const last = record.turns.at(-1)
      if (last?.status === 'running') {
        last.status = 'error'
        last.endedAt = record.updatedAt
        last.error = { message: CUT_OFF }
      }
      this.records.set(record.id, record)
    }
    return this
  }

  #file(id) {
    return path.join(this.dir, `${id}.json`)
  }

  #save(record) {
    if (this.records.get(record.id) !== record) return Promise.resolve()
    const previous = this.writes.get(record.id) ?? Promise.resolve()
    const write = previous.then(() => writeJson(this.#file(record.id), record)).catch((error) => this.log('claude runner:', error.message))
    this.writes.set(record.id, write)
    return write
  }

  summary(record) {
    const live = this.live.get(record.id)
    return {
      id: record.id,
      workspace: record.workspace,
      sessionId: record.sessionId,
      model: record.model ?? null,
      effort: record.effort ?? null,
      modelInUse: record.modelInUse ?? null,
      state: live ? 'running' : 'idle',
      lastStatus: record.turns.at(-1)?.status ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  get(id) {
    const record = this.records.get(id)
    return record ? this.summary(record) : null
  }

  turns(id) {
    return this.records.get(id)?.turns ?? null
  }

  running(id) {
    return this.live.has(id)
  }

  get busy() {
    return this.live.size > 0
  }

  /**
   * A new session in a folder; it starts on its first `run`.
   * `args` are more flags for every turn (the system prompt, tools left out).
   */
  async create({ workspace, model = null, effort = null, args = [] }) {
    const now = this.now()
    const record = {
      id: randomUUID(), sessionId: randomUUID(), workspace: String(workspace), model, effort, args: [...args],
      started: false, modelInUse: null, createdAt: now, updatedAt: now, turns: [],
    }
    this.records.set(record.id, record)
    await this.#save(record)
    this.emit('session', this.summary(record))
    return this.summary(record)
  }

  /** Starts a turn on `text`. Throws when the session is working already. */
  run(id, text) {
    const record = this.records.get(id)
    if (!record) throw new Error('このセッションは見つかりません')
    if (this.live.has(id)) throw new Error('作業中です。終わってから送ってください')
    const claude = this.findClaude()
    if (!claude) throw new Error('Claude Code（claude コマンド）が見つかりません。インストールしてから使ってください')
    const now = this.now()
    const turn = {
      id: randomUUID(), startedAt: now, endedAt: null, status: 'running', stopReason: null, error: null,
      user: { text: String(text), images: [] }, items: [],
    }
    record.turns = [...record.turns, turn].slice(-TURNS_KEPT)
    record.updatedAt = now

    const args = [
      ...(record.started ? ['--resume', record.sessionId] : ['--session-id', record.sessionId]),
      '-p', '--output-format', 'stream-json', '--verbose',
      // Nobody is there to answer a permission prompt: what would ask is denied, and the report says so.
      '--permission-prompts', 'none',
      ...(record.model ? ['--model', record.model] : []),
      ...(record.effort ? ['--effort', record.effort] : []),
      ...record.args,
    ]
    const env = { ...process.env }
    for (const name of [...INHERITED_MARKERS, ...API_KEY_ENV]) delete env[name]
    const command = launchCommand(claude, args)
    let proc
    try {
      proc = this.spawn(command.file, command.args, { cwd: record.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      this.#finish(record, turn, { status: 'error', message: `Claude Code を起動できませんでした: ${error.message}` })
      throw error
    }
    const live = { proc, turn, stopping: false, apiKey: null, stderr: '', result: null }
    live.exited = new Promise((resolve) => { live.markExited = resolve })
    this.live.set(id, live)
    void this.#save(record)
    this.emit('session', this.summary(record))
    this.emit('turn', { id, turn })

    proc.stdin?.on('error', () => {})
    proc.stdin?.end(String(text))
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk) => {
      live.stderr = (live.stderr + chunk).slice(-STDERR_TAIL)
    })
    const lines = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.#onLine(record, live, line))
    let ended = false
    const end = (code, error) => {
      if (ended) return
      ended = true
      // The last lines may still be on their way.
      setImmediate(() => this.#onExit(record, live, code, error))
    }
    proc.on('error', (error) => end(null, error))
    proc.on('close', (code) => end(code))
    return this.summary(record)
  }

  #onLine(record, live, line) {
    if (!line.trim()) return
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (event.type === 'system' && event.subtype === 'init') {
      record.started = true
      record.modelInUse = event.model ?? record.modelInUse
      if (!SUBSCRIPTION_SOURCES.has(event.apiKeySource)) {
        // An API key (an apiKeyHelper, a key in the settings): never used by a team.
        live.apiKey = String(event.apiKeySource)
        this.#kill(live)
      }
      return
    }
    if (event.type === 'result') {
      live.result = event
      return
    }
    if (applyEvent(live.turn, event, this.now())) {
      record.updatedAt = this.now()
      this.emit('turn', { id: record.id, turn: live.turn })
    }
  }

  #onExit(record, live, code, error) {
    if (this.live.get(record.id) === live) this.live.delete(record.id)
    live.markExited()
    const { result } = live
    if (live.apiKey) {
      return this.#finish(record, live.turn, {
        status: 'error',
        message: `Claude Code が API キー（${live.apiKey}）で動こうとしたため止めました。チームはサブスクリプションでしか動かしません。Claude Code の設定から API キーを外してください。`,
      })
    }
    // The app is closing: the turn is saved as cut off, and nobody hears of it until the next start.
    if (this.closing) return this.#finish(record, live.turn, { status: 'error', message: CUT_OFF, quiet: true })
    if (live.stopping) return this.#finish(record, live.turn, { status: 'cancelled' })
    if (result && !result.is_error) {
      return this.#finish(record, live.turn, { status: 'done', text: String(result.result ?? ''), denials: result.permission_denials ?? [], stopReason: result.stop_reason })
    }
    const message = result
      ? String(result.result || result.subtype || 'Claude Code がエラーで止まりました')
      : error
        ? `Claude Code を起動できませんでした: ${error.message}`
        : `Claude Code が終了しました（終了コード ${code ?? '?'}）${live.stderr.trim() ? `\n${live.stderr.trim()}` : ''}`
    this.#finish(record, live.turn, { status: 'error', message, text: result ? '' : undefined })
  }

  #finish(record, turn, { status, message, text = '', denials = [], stopReason = null, quiet = false }) {
    for (const item of turn.items) {
      if (item.type === 'tool' && item.status === 'in_progress') item.status = status === 'done' ? 'completed' : 'failed'
    }
    turn.status = status
    turn.endedAt = this.now()
    turn.stopReason = stopReason
    if (status === 'error') turn.error = { message: message ?? 'エラーで止まりました' }
    record.updatedAt = turn.endedAt
    void this.#save(record)
    this.emit('turn', { id: record.id, turn })
    this.emit('session', this.summary(record))
    if (quiet) return
    const reply = text || turn.items.filter((item) => item.type === 'agent').at(-1)?.text || ''
    this.emit('finished', { id: record.id, status, text: reply, error: turn.error?.message ?? null, denials })
  }

  #kill(live) {
    const { proc } = live
    if (proc.exitCode !== null && proc.exitCode !== undefined) return
    if (this.platform === 'win32' && proc.pid) {
      // A .cmd shim runs under cmd.exe: end the whole tree.
      try {
        this.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        return
      } catch {}
    }
    try {
      proc.kill()
    } catch {}
    setTimeout(() => {
      try {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      } catch {}
    }, KILL_WAIT_MS).unref?.()
  }

  /** Stops the running turn (its conversation stays; the next `run` resumes it). */
  stop(id) {
    const live = this.live.get(id)
    if (!live) return false
    live.stopping = true
    this.#kill(live)
    return true
  }

  async remove(id) {
    const record = this.records.get(id)
    if (!record) return
    this.stop(id)
    this.records.delete(id)
    await this.writes.get(id)
    this.writes.delete(id)
    await fs.rm(this.#file(id), { force: true })
    this.emit('removed', { id })
  }

  /** Ends every running turn (the app is closing); each is saved as cut off. */
  async shutdown() {
    this.closing = true
    const exits = [...this.live.values()].map((live) => live.exited)
    for (const id of [...this.live.keys()]) this.stop(id)
    let timer
    await Promise.race([Promise.all(exits), new Promise((resolve) => { timer = setTimeout(resolve, KILL_WAIT_MS) })])
    clearTimeout(timer)
    await Promise.all([...this.writes.values()])
  }
}
