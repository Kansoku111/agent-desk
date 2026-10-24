// Claude Code without its terminal: `claude -p` writing its events as JSON
// lines (--output-format stream-json), one process per turn, each resuming the
// same session. A team's Claude children run this way. The end of a turn, its
// reply and every tool call come from Claude Code's own output, not from hooks
// or the screen, and a message is handed over on stdin, not typed into a box.
//
// Messages go in as stream-json lines and stdin stays open while the turn
// runs, so one can be added to it (`steer`): Claude Code reads it at the next
// step of the work, or, with no step left, as a turn of its own right after
// this one. --replay-user-messages gives each message back by its uuid when
// Claude Code takes it, which is how the turn knows it arrived.
//
// Before each turn, model-free auth inspection must match the team's explicit
// user consent. Credentials are inherited, not replaced or selected here.
// The init event is too late to prevent billing; authorization precedes spawn.
import { spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { normalizeClaudeLimits } from './claude-limits.js'
import { OutputSpeedMeter } from './output-speed.js'
import { readJson, writeJson } from './json-file.js'
import { INHERITED_MARKERS, findClaude, launchCommand } from './terminals.js'

/** Turns kept per session (older ones drop off; Claude Code keeps the whole conversation itself). */
const TURNS_KEPT = 60
/** The longest tool output kept for the view. */
const OUTPUT_KEEP = 8000
const STDERR_TAIL = 4000
/** How long a stopped run may take to exit before it is killed outright. */
const KILL_WAIT_MS = 5000
/** How long a turn that has answered waits for a message it was handed but has not taken yet. */
const STEER_GRACE_MS = 15_000
/**
 * A turn that answered while commands of its own still run in the background
 * (Bash run_in_background, Monitor) is not over: Claude Code starts a turn of
 * its own when they end, as long as its input stays open. It is waited for this
 * long after the answer at most...
 */
export const BACKGROUND_WAIT_MS = 2 * 60 * 60_000
/** ...and once nothing runs in the background, a turn of its own is waited for this long before the input closes. */
const WAKE_GRACE_MS = 30_000

const CUT_OFF = 'Agent Desk が終了したため、作業が途中で止まりました。'

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** A message for stdin: one stream-json line, with the uuid Claude Code gives back when it takes the message. */
const userLine = (text, uuid) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: String(text) }, parent_tool_use_id: null, session_id: '', ...(uuid ? { uuid } : {}) })}\n`

/** The token counts Claude Code reports at the end of a turn (cost is Claude Code's own estimate). */
function resultUsage(result) {
  const usage = result?.usage
  if (!usage || typeof usage !== 'object') return null
  const count = (value) => Number.isFinite(value) ? value : 0
  return {
    input: count(usage.input_tokens), output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens),
    ...(Number.isFinite(result.total_cost_usd) ? { costUsd: result.total_cost_usd } : {}),
  }
}

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
   * @param {(context: { claude: string, cwd: string, env: object }) => Promise<string|null>} [options.preflight]
   *   asked before each turn starts: a message when the run must not start, else null
   */
  constructor({
    dir, findClaude: find = () => findClaude(), spawn = spawnProcess, preflight = null, log = () => {}, now = Date.now, platform = process.platform,
    steerGraceMs = STEER_GRACE_MS, backgroundWaitMs = BACKGROUND_WAIT_MS, wakeGraceMs = WAKE_GRACE_MS,
  }) {
    super()
    this.dir = dir
    this.findClaude = find
    this.spawn = spawn
    this.preflight = preflight
    this.log = log
    this.now = now
    this.platform = platform
    this.steerGraceMs = steerGraceMs
    this.backgroundWaitMs = backgroundWaitMs
    this.wakeGraceMs = wakeGraceMs
    /** @type {Map<string, object>} sessions by id */
    this.records = new Map()
    /**
     * The running turn of a session: { proc, turn, stopping, refusal, stderr, result, exited, steers, early, denials, ended, grace }
     * (proc is null until the preflight is through; `steers` are the messages added to the turn by uuid, `ended` is true once stdin is closed)
     */
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
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--include-partial-messages',
      // Nobody is there to answer a permission prompt: what would ask is denied, and the report says so.
      '--permission-prompts', 'none',
      ...(record.model ? ['--model', record.model] : []),
      ...(record.effort ? ['--effort', record.effort] : []),
      ...record.args,
    ]
    const env = { ...process.env }
    for (const name of INHERITED_MARKERS) delete env[name]
    const command = launchCommand(claude, args)
    const spawnOptions = { cwd: record.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    const live = {
      proc: null, turn, stopping: false, apiKey: null, refusal: null, stderr: '', result: null,
      steers: new Map(), early: [], denials: [], ended: false, grace: null,
      // Its commands running in the background (task id → description), and the waits on them.
      background: new Map(), answered: false, wake: null, backgroundCap: null, cutBackground: null,
    }
    live.speed = new OutputSpeedMeter({ onChange: (speed) => {
      if (speed) turn.outputSpeed = speed
      else delete turn.outputSpeed
      if (this.live.get(id) !== live || this.closing) return
      this.emit('turn', { id, turn })
    } })
    live.exited = new Promise((resolve) => { live.markExited = resolve })

    if (this.preflight) {
      // The turn is working from now on; it starts once the sign-in has been checked.
      this.live.set(id, live)
      void this.#save(record)
      this.emit('session', this.summary(record))
      this.emit('turn', { id, turn })
      void this.#startChecked(record, live, { claude, command, spawnOptions, text })
      return this.summary(record)
    }

    let proc
    try {
      proc = this.spawn(command.file, command.args, spawnOptions)
    } catch (error) {
      this.#finish(record, turn, { status: 'error', message: `Claude Code を起動できませんでした: ${error.message}` })
      throw error
    }
    this.live.set(id, live)
    void this.#save(record)
    this.emit('session', this.summary(record))
    this.emit('turn', { id, turn })
    this.#attach(record, live, proc, text)
    return this.summary(record)
  }

  /** Checks which sign-in the run would use, then starts it (or ends the turn without starting it). */
  async #startChecked(record, live, { claude, command, spawnOptions, text }) {
    let refusal = null
    try {
      refusal = await this.preflight({ record, claude, cwd: spawnOptions.cwd, env: spawnOptions.env })
    } catch (error) {
      // Never start a billable run when inspection failed.
      refusal = 'Claude Code の認証確認に失敗しました。チームの設定で再確認してください。'
      this.log('claude runner: sign-in check failed')
    }
    if (live.stopping || this.closing) return this.#onExit(record, live, null, null)
    if (refusal) {
      live.refusal = String(refusal)
      return this.#onExit(record, live, null, null)
    }
    let proc
    try {
      proc = this.spawn(command.file, command.args, spawnOptions)
    } catch (error) {
      return this.#onExit(record, live, null, error)
    }
    this.#attach(record, live, proc, text)
  }

  /**
   * Adds a message to the turn that is running. Claude Code reads it at the next
   * step of the work, or as a turn of its own right after this one; either way it
   * shows in this turn once taken. False when no turn can take it (none runs, or
   * its input is closed already): the caller keeps the message for the next turn.
   */
  steer(id, text) {
    const live = this.live.get(id)
    const body = String(text ?? '')
    if (!live || live.ended || live.stopping || !body.trim()) return false
    const uuid = randomUUID()
    live.steers.set(uuid, { text: body, taken: false })
    const line = userLine(body, uuid)
    // Still being checked: it goes in behind the prompt once the run starts.
    if (live.proc) this.#write(live, line)
    else live.early.push(line)
    return true
  }

  #write(live, line) {
    try {
      live.proc.stdin?.write(line)
    } catch {}
  }

  /** Closes the run's input: Claude Code exits once it has nothing left to do. */
  #endInput(live) {
    clearTimeout(live.grace)
    clearTimeout(live.wake)
    clearTimeout(live.backgroundCap)
    if (live.ended) return
    live.ended = true
    try {
      live.proc?.stdin?.end()
    } catch {}
  }

  /** The turn answered: input closes now, unless a message was handed over that Claude Code has not taken (it follows as a turn of its own). */
  #answered(live) {
    clearTimeout(live.grace)
    live.answered = true
    if (live.background.size) return this.#awaitBackground(live)
    if ([...live.steers.values()].every((steer) => steer.taken)) return this.#endInput(live)
    live.grace = setTimeout(() => this.#endInput(live), this.steerGraceMs)
    live.grace.unref?.()
  }

  /**
   * The answer came with commands still running in the background: the input
   * stays open for Claude Code to go on when they end, BACKGROUND_WAIT_MS at most;
   * then it closes, and the turn's report says what was left running.
   */
  #awaitBackground(live) {
    clearTimeout(live.backgroundCap)
    live.backgroundCap = setTimeout(() => {
      live.cutBackground = [...live.background.values()]
      this.#endInput(live)
    }, this.backgroundWaitMs)
    live.backgroundCap.unref?.()
  }

  /** What runs in the background changed (`background_tasks_changed` lists all of it). */
  #onBackground(live, tasks) {
    live.background = new Map((Array.isArray(tasks) ? tasks : []).filter((task) => task && typeof task === 'object').map((task) => [task.task_id, String(task.description ?? task.task_type ?? '')]))
    if (live.background.size || !live.answered) return
    // The last one ended after the answer: Claude Code goes on by itself; if it does not, the turn is over.
    clearTimeout(live.backgroundCap)
    clearTimeout(live.wake)
    live.wake = setTimeout(() => this.#answered(live), this.wakeGraceMs)
    live.wake.unref?.()
  }

  /** Feeds the prompt to a started run and follows its output until it exits. */
  #attach(record, live, proc, text) {
    live.proc = proc
    proc.stdin?.on('error', () => {})
    this.#write(live, userLine(text))
    for (const line of live.early.splice(0)) this.#write(live, line)
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
  }

  #onLine(record, live, line) {
    if (!line.trim()) return
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (!event || typeof event !== 'object') return
    if (event.type === 'stream_event') {
      // Nested agents may stream concurrently; they are not this turn's model.
      if (event.parent_tool_use_id) return
      // Partial events are used only for timing. The final assistant message
      // still owns transcript content, avoiding duplicate text/tool calls.
      const part = event.event
      if (!live.stopping && !live.ended) {
        if (part?.type === 'content_block_delta') {
          if (part.delta?.type === 'text_delta') live.speed.push(part.delta.text)
          else if (part.delta?.type === 'thinking_delta') live.speed.push(part.delta.thinking)
          else if (part.delta?.type === 'input_json_delta') live.speed.pause()
        } else if (part?.type === 'message_stop'
          || (part?.type === 'content_block_start' && part.content_block?.type === 'tool_use')) live.speed.pause()
      }
      return
    }
    if (event.type === 'system' && event.subtype === 'init') {
      record.started = true
      record.modelInUse = event.model ?? record.modelInUse
      // A turn of its own started (a background command ended, or it took a message): its answer is awaited again.
      live.answered = false
      clearTimeout(live.grace)
      clearTimeout(live.wake)
      clearTimeout(live.backgroundCap)
      return
    }
    if (event.type === 'system' && event.subtype === 'background_tasks_changed') return this.#onBackground(live, event.tasks)
    if (event.type === 'result') {
      live.speed.pause()
      live.result = event
      live.denials.push(...(Array.isArray(event.permission_denials) ? event.permission_denials : []))
      this.#answered(live)
      return
    }
    // A message added to the turn, given back as Claude Code takes it.
    const steer = event.type === 'user' && event.isReplay ? live.steers.get(event.uuid) : undefined
    if (steer) {
      if (!steer.taken) {
        steer.taken = true
        live.turn.items.push({ type: 'steer', id: event.uuid, text: steer.text, images: [], at: this.now() })
        record.updatedAt = this.now()
        this.emit('turn', { id: record.id, turn: live.turn })
      }
      return
    }
    if (event.type === 'rate_limit_event') {
      const limits = normalizeClaudeLimits(event.rate_limit_info, this.now())
      if (limits) this.emit('rateLimits', limits)
      return
    }
    if (applyEvent(live.turn, event, this.now())) {
      record.updatedAt = this.now()
      this.emit('turn', { id: record.id, turn: live.turn })
    }
  }

  #onExit(record, live, code, error) {
    live.speed.finish()
    if (this.live.get(record.id) === live) this.live.delete(record.id)
    clearTimeout(live.grace)
    clearTimeout(live.wake)
    clearTimeout(live.backgroundCap)
    live.ended = true
    live.markExited()
    // A message Claude Code never took is said so in the turn, not dropped quietly.
    for (const [uuid, steer] of live.steers) {
      if (steer.taken) continue
      steer.taken = true
      live.turn.items.push({ type: 'notice', id: uuid, level: 'warning', text: `作業中に送ったメッセージは Claude Code に届きませんでした: ${clip(steer.text, 200)}` })
    }
    // An answer from before a later turn that then crashed is not what the run ended with.
    const result = live.answered || code === 0 ? live.result : null
    if (live.refusal) return this.#finish(record, live.turn, { status: 'error', message: live.refusal })
    // The app is closing: the turn is saved as cut off, and nobody hears of it until the next start.
    if (this.closing) return this.#finish(record, live.turn, { status: 'error', message: CUT_OFF, quiet: true })
    if (live.stopping) return this.#finish(record, live.turn, { status: 'cancelled' })
    if (result && !result.is_error) {
      const cut = live.cutBackground?.length
        ? `\n\n（バックグラウンドの作業が ${Math.round(this.backgroundWaitMs / 60_000)} 分たっても終わらなかったため、待つのをやめました。止まった作業: ${live.cutBackground.map((entry) => entry || '名前なし').join('、')}）`
        : ''
      return this.#finish(record, live.turn, { status: 'done', text: `${String(result.result ?? '')}${cut}`, denials: live.denials, stopReason: result.stop_reason, usage: resultUsage(result) })
    }
    const message = result
      ? String(result.result || result.subtype || 'Claude Code がエラーで止まりました')
      : error
        ? `Claude Code を起動できませんでした: ${error.message}`
        : `Claude Code が終了しました（終了コード ${code ?? '?'}）${live.stderr.trim() ? `\n${live.stderr.trim()}` : ''}`
    // What was denied stays in the report of a turn that failed as well: the leader decides on it either way.
    this.#finish(record, live.turn, { status: 'error', message, text: result ? '' : undefined, denials: live.denials, usage: result ? resultUsage(result) : null })
  }

  #finish(record, turn, { status, message, text = '', denials = [], stopReason = null, quiet = false, usage = null }) {
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
    this.emit('finished', { id: record.id, status, text: reply, error: turn.error?.message ?? null, denials, ...(usage ? { usage } : {}) })
  }

  #kill(live) {
    const { proc } = live
    // Still being checked: nothing runs yet, and the check's end sees `stopping`.
    if (!proc) return
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
    live.speed.pause()
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
