// Claude Code tasks ("CL"): each runs the user's own `claude` CLI in a
// pseudo-terminal on this PC. A headless xterm mirrors the screen, so a window
// or phone that opens the task later (or reconnects) first gets the current
// screen, then the live output. Hooks passed with --settings tell the session
// id (to resume after a restart) and whether Claude is working, waiting for an
// approval, or done.
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ClaudeTranscripts } from './claude-transcript.js'
import { readJson, writeJson } from './json-file.js'
import { sameToken } from './remote.js'
import {
  API_KEY_ENV, DEFAULT_TITLE, DIALOG_RULE, EFFORTS, INHERITED_MARKERS, READY_DELAY_MS, READY_FALLBACK_MS, isFile,
  REDRAW_DELAY_MS, clampSize, cleanTitle, findClaude, hookEffect, hookSettings, launchCommand, parseDialog,
  teamHookSettings,
} from './terminal-helpers.js'
export {
  API_KEY_ENV, DEFAULT_TITLE, EFFORTS, INHERITED_MARKERS, READY_DELAY_MS, READY_FALLBACK_MS, REDRAW_DELAY_MS,
  cleanTitle, findClaude, hookEffect, hookSettings, launchCommand, parseDialog, teamHookSettings,
} from './terminal-helpers.js'

const require = createRequire(import.meta.url)
const SCROLLBACK = 3000
/** A model alias (opus, sonnet[1m]) or full name (claude-opus-5-5) for `claude --model`. */
const MODEL_NAME = /^[a-z0-9][a-z0-9.\-[\]]{0,79}$/i
/** How long a start with a prompt counts as working before its turn is seen. */
const PROMPT_START_LIMIT_MS = 90_000
/** A typed message: the pause before Enter (longer for long text, up to the cap), and the Enter retries while Claude Code stays idle. */
const SEND_ENTER_MS = 150
const SEND_ENTER_MAX_MS = 1500
const SEND_RETRY_MS = 1500
const SEND_RETRIES = 2

/** DEC private modes the serialized screen leaves out: mouse encodings, cursor visibility, focus reports. */
const TRACKED_MODES = [25, 1004, 1005, 1006, 1015]
export class TerminalManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.file  the task list
   * @param {string} options.settingsFile  the hook settings passed to `claude --settings`
   * @param {() => string} options.hookUrl  where claude-hook.js reports
   * @param {(client, frame) => void} options.send  output for one attached window or phone
   * @param {object} [options.pty]  node-pty (tests pass a fake)
   * @param {() => string|null} [options.findClaude]
   * @param {string} [options.claudeHome]  Claude Code's own data folder (resumable transcripts)
   * @param {(record: object) => ({ args?: string[] } | null)} [options.launch]  more flags for a team's leader or child
   */
  constructor({
    file, settingsFile, hookUrl, send, pty = null, findClaude: find = () => findClaude(), log = () => {},
    claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), launch = () => null,
  }) {
    super()
    this.file = file
    this.settingsFile = settingsFile
    // A team's leader gets its own hook settings (teamHookSettings).
    this.teamSettingsFile = path.join(path.dirname(settingsFile), 'claude-team-leader-settings.json')
    this.launch = launch
    this.hookUrl = hookUrl
    this.send = send
    this.pty = pty
    this.findClaude = find
    this.log = log
    this.claudeHome = claudeHome
    this.transcripts = new ClaudeTranscripts()
    /** @type {Map<string, object>} saved tasks */
    this.records = new Map()
    /** Running (or exited, with their last screen) processes by task id. */
    this.live = new Map()
    /** Windows and phones showing each task. */
    this.subscribers = new Map()
    /** The model and level a new task starts with: the last ones chosen (null: Claude Code's own default). */
    this.defaults = { model: null, effort: null }
    this.writes = Promise.resolve()
  }

  async load() {
    const saved = await readJson(this.file, { terminals: [] })
    for (const record of Array.isArray(saved?.terminals) ? saved.terminals : []) {
      if (typeof record?.id === 'string' && typeof record.workspace === 'string') this.records.set(record.id, record)
    }
    this.defaults = {
      model: MODEL_NAME.test(saved?.defaults?.model ?? '') ? saved.defaults.model : null,
      effort: EFFORTS.includes(saved?.defaults?.effort) ? saved.defaults.effort : null,
    }
    await writeJson(this.settingsFile, hookSettings())
    await writeJson(this.teamSettingsFile, teamHookSettings())
    return this
  }

  #save() {
    const snapshot = { defaults: { ...this.defaults }, terminals: [...this.records.values()].map((record) => ({ ...record })) }
    this.writes = this.writes.then(() => writeJson(this.file, snapshot)).catch((error) => this.log('terminals:', error.message))
    return this.writes
  }

  #record(id) {
    const record = this.records.get(id)
    if (!record) throw new Error('Claude Code のタスクが見つかりません')
    return record
  }

  summary(record) {
    const live = this.live.get(record.id)
    return {
      id: record.id,
      workspace: record.workspace,
      title: record.title,
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archived: Boolean(record.archived),
      // 'running': the process is up; 'exited': it ended (its last screen stays); 'stopped': none since the app started.
      state: live ? (live.alive ? 'running' : 'exited') : 'stopped',
      activity: live?.alive ? live.activity : 'idle',
      exitCode: live?.exitCode ?? null,
      // Chosen in Agent Desk (null: Claude Code's default), and what Claude Code reports using.
      model: record.model ?? null,
      effort: record.effort ?? null,
      modelInUse: live?.model ?? null,
      effortInUse: live?.effort ?? null,
      // A team's leader or child (teams.js); null for a task of its own.
      team: record.team ?? null,
    }
  }

  list() {
    return [...this.records.values()].map((record) => this.summary(record)).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Whether Claude is working in any task (the app must not exit or be replaced then). */
  get busy() {
    return [...this.live.values()].some((live) => live.alive && live.activity === 'running')
  }

  #changed(record) {
    this.emit('terminal', this.summary(record))
  }

  /**
   * Starts Claude Code in a folder. A team (teams.js) also gives its role, the
   * model and level, a fixed title, and the first prompt (Claude Code starts on it).
   */
  async create({ workspace, size, team = null, model, effort, title, prompt = null }) {
    const dir = String(workspace ?? '')
    if (!path.isAbsolute(dir) || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`フォルダが見つかりません: ${dir}`)
    if (model != null && !MODEL_NAME.test(String(model))) throw new Error('このモデルは指定できません')
    if (effort != null && !EFFORTS.includes(effort)) throw new Error('この推論レベルは指定できません')
    const now = Date.now()
    const named = typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : null
    const record = {
      id: randomUUID(), workspace: dir, title: named ?? DEFAULT_TITLE, renamed: Boolean(named), sessionId: randomUUID(), transcriptPath: null,
      createdAt: now, updatedAt: now, archived: false,
      model: model === undefined ? this.defaults.model : model, effort: effort === undefined ? this.defaults.effort : effort,
      ...(team ? { team } : {}),
    }
    this.records.set(record.id, record)
    try {
      this.#start(record, clampSize(size), prompt)
    } catch (error) {
      this.records.delete(record.id)
      throw error
    }
    await this.#save()
    this.#changed(record)
    return this.summary(record)
  }

  /** The file Claude Code keeps this task's conversation in, or null before it has written one. */
  #transcriptFile(record) {
    if (record.transcriptPath && isFile(record.transcriptPath)) return record.transcriptPath
    try {
      const projects = path.join(this.claudeHome, 'projects')
      for (const dir of fs.readdirSync(projects)) {
        const file = path.join(projects, dir, `${record.sessionId}.jsonl`)
        if (isFile(file)) return file
      }
    } catch {}
    return null
  }

  /**
   * The conversation as chat turns (see claude-transcript.js): all of it for a
   * viewer's first read, then what changed after the `epoch` and `since` of its
   * last one.
   */
  async conversation(id, { epoch, since } = {}) {
    const record = this.#record(id)
    const file = this.#transcriptFile(record)
    if (!file) return { epoch: null, rev: 0, omitted: 0, reset: true, turns: [], ids: [] }
    return this.transcripts.read(file, { epoch: typeof epoch === 'string' ? epoch : null, since: Number(since) > 0 ? Number(since) : 0 })
  }

  /**
   * A backup for a turn whose Stop hook never came (a hook that failed to
   * run): when the conversation file has been still for `quietMs` and says the
   * last turn ended, the task is marked idle. True when it is idle now.
   */
  async settle(id, { quietMs = 30_000 } = {}) {
    const record = this.records.get(id)
    const live = this.live.get(id)
    if (!record || !live?.alive) return false
    if (live.activity !== 'running') return live.activity === 'idle'
    const file = this.#transcriptFile(record)
    if (!file || (quietMs > 0 && Date.now() - fs.statSync(file).mtimeMs < quietMs)) return false
    const last = (await this.transcripts.read(file)).turns.at(-1)
    if (!last || last.status === 'running' || live.activity !== 'running' || !live.alive) return false
    live.activity = 'idle'
    live.promptPending = false
    this.log(`terminal ${id}: its turn ended without a Stop hook; marked idle from the conversation file`)
    this.#changed(record)
    return true
  }

  /** Whether Claude Code saved the session, so `--resume` can open it. */
  #resumable(record) {
    if (record.transcriptPath && isFile(record.transcriptPath)) return true
    try {
      const projects = path.join(this.claudeHome, 'projects')
      return fs.readdirSync(projects).some((dir) => isFile(path.join(projects, dir, `${record.sessionId}.jsonl`)))
    } catch {
      return false
    }
  }

  #loadPty() {
    if (this.pty) return this.pty
    try {
      this.pty = require('node-pty')
    } catch (error) {
      throw new Error(`ターミナルを開けません（node-pty を読み込めませんでした: ${error.message}）。npm install をやり直してください。`)
    }
    return this.pty
  }

  /** `prompt`: a first message Claude Code starts working on (a team's task or report). */
  #start(record, size, prompt = null) {
    const pty = this.#loadPty()
    const claude = this.findClaude()
    if (!claude) throw new Error('Claude Code（claude コマンド）が見つかりません。Claude Code をインストールしてから開き直してください。')
    if (!fs.statSync(record.workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`作業フォルダが見つかりません: ${record.workspace}`)
    const resume = this.#resumable(record)
    const extra = (record.team && this.launch(record)) || null
    const command = launchCommand(claude, [
      ...(resume ? ['--resume', record.sessionId] : ['--session-id', record.sessionId]),
      // Flags apply to this session only; `/model` typed in Claude Code would change the user's default everywhere.
      ...(record.model ? ['--model', record.model] : []),
      ...(record.effort ? ['--effort', record.effort] : []),
      // Some of these flags take a list (--mcp-config, --allowedTools), so the
      // single-value --settings comes last: the prompt after it stays the prompt.
      ...(extra?.args ?? []),
      '--settings', extra ? this.teamSettingsFile : this.settingsFile,
      ...(prompt ? [prompt] : []),
    ])
    const secret = randomBytes(18).toString('hex')
    const env = { ...process.env }
    for (const name of INHERITED_MARKERS) delete env[name]
    if (record.team) for (const name of API_KEY_ENV) delete env[name]
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      AGENT_DESK_TERMINAL_HOOK: this.hookUrl(),
      AGENT_DESK_TERMINAL_ID: record.id,
      AGENT_DESK_TERMINAL_SECRET: secret,
    })

    const { Terminal } = require('@xterm/headless')
    const { SerializeAddon } = require('@xterm/addon-serialize')
    const { Unicode11Addon } = require('@xterm/addon-unicode11')
    const term = new Terminal({ ...size, scrollback: SCROLLBACK, allowProposedApi: true })
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    const serialize = new SerializeAddon()
    term.loadAddon(serialize)
    const modes = new Map()
    for (const final of ['h', 'l']) {
      term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        for (const mode of params) if (TRACKED_MODES.includes(mode)) modes.set(mode, final)
        return false
      })
    }
    term.onTitleChange((raw) => {
      const title = cleanTitle(raw)
      if (!title || record.renamed || title === record.title) return
      record.title = title
      void this.#save()
      this.#changed(record)
    })

    let proc
    try {
      proc = pty.spawn(command.file, command.args, { name: 'xterm-256color', ...size, cwd: record.workspace, env })
    } catch (error) {
      term.dispose()
      throw new Error(`Claude Code を起動できませんでした: ${error.message}`)
    }
    const previous = this.live.get(record.id)
    previous?.term.dispose()
    const live = {
      proc, term, serialize, modes, secret, size, alive: true, activity: prompt ? 'running' : 'idle', exitCode: null, controller: null, sizes: new Map(),
      model: record.model, effort: record.effort, exited: null,
      // When it started, when Claude Code said its session started, and when someone last typed in it.
      startedAt: Date.now(), sessionAt: null, inputAt: 0,
      // Started on a prompt: working from the start, until its turn is seen.
      promptPending: Boolean(prompt),
    }
    this.live.set(record.id, live)
    // Output goes out once the mirror has parsed it, so a new viewer's screen and the stream line up.
    proc.onData((data) => term.write(data, () => this.#broadcast(record.id, { event: 'termData', terminalId: record.id, data })))
    proc.onExit(({ exitCode }) => {
      if (this.live.get(record.id) !== live) return
      live.alive = false
      live.exitCode = exitCode
      live.exited?.()
      // Restarted for a new model: the task is not shown as ended in between.
      if (!live.replacing) term.write('', () => this.#changed(record))
    })
    if (prompt) {
      // A prompt that never turned into a turn (no hooks) must not keep the task "working" for good.
      setTimeout(() => {
        if (this.live.get(record.id) !== live || !live.promptPending) return
        live.promptPending = false
        if (live.alive && live.activity === 'running') {
          live.activity = 'idle'
          this.#changed(record)
        }
      }, PROMPT_START_LIMIT_MS).unref?.()
    }
    this.log(`claude ${resume ? 'resumed' : 'started'} in ${record.workspace} (${record.id})`)
  }

  #broadcast(id, frame) {
    for (const client of this.subscribers.get(id) ?? []) this.send(client, frame)
  }

  /**
   * Shows the task to one window or phone: starts (resumes) Claude Code when
   * it is not running since the app started, and returns the current screen.
   * From here on the client gets the output (`termData`).
   */
  async attach(id, client, size) {
    const record = this.#record(id)
    if (!this.live.has(id)) {
      this.#start(record, clampSize(size))
      this.#changed(record)
    }
    const live = this.live.get(id)
    live.sizes.set(client, clampSize(size))
    this.#control(id, live, client)
    // Wait for output already received to be parsed.
    await new Promise((resolve) => live.term.write('', resolve))
    const current = this.live.get(id)
    let snapshot = current.serialize.serialize({ scrollback: SCROLLBACK })
    for (const [mode, final] of current.modes) snapshot += `\x1b[?${mode}${final}`
    let set = this.subscribers.get(id)
    if (!set) this.subscribers.set(id, (set = new Set()))
    set.add(client)
    return { snapshot, terminal: this.summary(record), size: current.size }
  }

  detach(id, client) {
    this.subscribers.get(id)?.delete(client)
  }

  /** A window or phone went away. */
  dropClient(client) {
    for (const set of this.subscribers.values()) set.delete(client)
    for (const live of this.live.values()) {
      live.sizes.delete(client)
      if (live.controller === client) live.controller = null
    }
  }

  /**
   * The terminal takes the size of the window or phone that used it last. A
   * phone and the PC can show one task at once; each typing makes it fit itself.
   */
  #control(id, live, client) {
    live.controller = client
    const size = live.sizes.get(client)
    if (!size || !live.alive || (size.cols === live.size.cols && size.rows === live.size.rows)) return
    live.size = size
    try {
      live.proc.resize(size.cols, size.rows)
    } catch {}
    live.term.resize(size.cols, size.rows)
    this.#broadcast(id, { event: 'termSize', terminalId: id, size })
    // Windows' console rewraps its old screen on a resize and leaves stray
    // lines in Claude Code's view; Ctrl+L makes it draw the screen again.
    clearTimeout(live.redraw)
    live.redraw = setTimeout(() => {
      if (!live.alive) return
      try {
        live.proc.write('\x0c')
      } catch {}
    }, REDRAW_DELAY_MS)
  }

  /**
   * Keys and pastes from one viewer. `reply` marks the viewer's terminal
   * answering a query from Claude Code (cursor position, device attributes);
   * only the viewer in control answers, or Claude would get every answer twice.
   */
  input(id, client, data, reply = false) {
    const live = this.live.get(id)
    if (!live?.alive || typeof data !== 'string' || !data) return false
    if (reply) {
      if (live.controller && live.controller !== client) return false
    } else {
      live.inputAt = Date.now()
      if (live.controller !== client) this.#control(id, live, client)
    }
    live.proc.write(data)
    return true
  }

  /**
   * Stops what Claude Code is doing (Esc). Claude Code runs no Stop hook for an
   * interruption, so the task is marked idle once the conversation file shows it.
   */
  interrupt(id, client) {
    if (!this.input(id, client, '\x1b')) return false
    const live = this.live.get(id)
    void (async () => {
      for (let tries = 0; tries < 12 && this.live.get(id) === live && live.alive; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (await this.settle(id, { quietMs: 0 }).catch(() => false)) return
      }
    })()
    return true
  }

  /**
   * The size that fits one viewer. `claim` makes the terminal take it; without,
   * it is kept for when that viewer types next (another screen is in control).
   */
  resize(id, client, size, claim = true) {
    const live = this.live.get(id)
    if (!live) return
    live.sizes.set(client, clampSize(size))
    if (claim || live.controller === client) this.#control(id, live, client)
  }

  /** A message typed outside the terminal screen: pasted (keeping its line breaks) and sent with Enter. */
  sendMessage(id, text) {
    const live = this.live.get(id)
    if (!live?.alive) throw new Error('Claude Code が動いていません')
    if (typeof text !== 'string') return
    if (text) live.proc.write(live.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text)
    // Enter right after a paste can be taken as part of it; Claude Code needs longer for a long paste or an image path.
    const wait = SEND_ENTER_MS + Math.min(text.length / 10, SEND_ENTER_MAX_MS)
    const enter = (retries) => {
      if (!live.alive) return
      try {
        live.proc.write('\r')
      } catch {
        return
      }
      // The prompt hook turns the task to working once the message is taken; if not, press Enter again (on an empty box it does nothing).
      if (retries > 0) {
        setTimeout(() => {
          if (live.alive && live.activity === 'idle') enter(retries - 1)
        }, SEND_RETRY_MS)
      }
    }
    setTimeout(() => enter(SEND_RETRIES), wait)
  }

  /**
   * What a team needs to know before it types into the task: whether Claude
   * Code runs, is idle, has its input box up (`ready`), and when someone typed.
   */
  status(id) {
    const record = this.records.get(id)
    if (!record) return null
    const live = this.live.get(id)
    const now = Date.now()
    const ready = Boolean(live?.alive)
      && (live.sessionAt !== null ? now - live.sessionAt >= READY_DELAY_MS : now - live.startedAt >= READY_FALLBACK_MS)
    return {
      state: live ? (live.alive ? 'running' : 'exited') : 'stopped',
      activity: live?.alive ? live.activity : 'idle',
      ready,
      inputAt: live?.inputAt ?? 0,
    }
  }

  /** Presses Enter, for a pasted message Claude Code did not take. */
  pressEnter(id) {
    const live = this.live.get(id)
    if (live?.alive) live.proc.write('\r')
  }

  /** The screen as lines of text, a line Claude Code's width wrapped joined back up. */
  #screenLines(live) {
    const buffer = live.term.buffer.active
    const lines = []
    for (let y = buffer.baseY; y < buffer.baseY + live.term.rows; y++) {
      const line = buffer.getLine(y)
      if (!line) continue
      const text = line.translateToString(true)
      // A rule as wide as the screen leaves the next line marked as its wrap.
      if (line.isWrapped && lines.length && !DIALOG_RULE.test(lines.at(-1))) lines[lines.length - 1] += text
      else lines.push(text)
    }
    return lines
  }

  /**
   * The approval (or question) Claude Code waits on, read off its screen so it
   * can be answered from the chat view; null when it waits on none.
   */
  async dialog(id) {
    const live = this.live.get(id)
    if (!live?.alive || live.activity !== 'approval') return null
    await new Promise((resolve) => live.term.write('', resolve))
    return parseDialog(this.#screenLines(live))
  }

  /**
   * Picks an entry of that choice by its number, as typing it does. `label` is
   * the entry the user saw: when the screen has moved on, nothing is picked.
   */
  async choose(id, key, label) {
    const live = this.live.get(id)
    const dialog = await this.dialog(id)
    const option = dialog?.options.find((entry) => entry.key === String(key))
    if (!option || option.label !== label) throw new Error('Claude Code の画面が変わりました。もう一度確かめてください')
    live.inputAt = Date.now()
    live.proc.write(option.key)
    return { chosen: option.key }
  }

  /** Types a file's path into Claude Code (an image from a phone, or pasted in the window). */
  insertPath(id, file) {
    const live = this.live.get(id)
    if (!live?.alive) throw new Error('Claude Code が動いていません')
    const text = /\s/.test(file) ? `"${file}"` : file
    live.proc.write(live.term.modes.bracketedPasteMode ? `\x1b[200~${text} \x1b[201~` : `${text} `)
  }

  /** Starts Claude Code again after it ended, resuming its conversation; `prompt` is sent as it starts. */
  restart(id, client, size, { prompt = null } = {}) {
    const record = this.#record(id)
    const current = this.live.get(id)
    if (current?.alive && !current.replacing) return this.summary(record)
    this.#broadcast(id, { event: 'termReset', terminalId: id })
    this.#start(record, clampSize(size ?? current?.size), prompt)
    if (client) this.live.get(id).sizes.set(client, clampSize(size))
    this.#changed(record)
    return this.summary(record)
  }

  /**
   * Switches the model or reasoning level. Claude Code takes them only at
   * start (as session-only flags), so a running Claude Code that is idle is
   * started again on the same conversation; one that is working is left alone.
   */
  async configure(id, client, { model, effort }) {
    const record = this.#record(id)
    const next = {
      model: model === undefined ? record.model ?? null : model,
      effort: effort === undefined ? record.effort ?? null : effort,
    }
    if (next.model !== null && !MODEL_NAME.test(String(next.model))) throw new Error('このモデルは指定できません')
    if (next.effort !== null && !EFFORTS.includes(next.effort)) throw new Error('この推論レベルは指定できません')
    const live = this.live.get(id)
    if (live?.alive && live.activity !== 'idle') throw new Error('Claude Code が作業中です。終わってから変更してください')
    record.model = next.model
    record.effort = next.effort
    this.defaults = { ...next }
    await this.#save()
    if (live?.alive) {
      live.replacing = true
      await new Promise((resolve) => {
        live.exited = resolve
        live.proc.kill()
        setTimeout(resolve, 5000)
      })
      this.restart(id, client, live.size)
    } else {
      this.#changed(record)
    }
    return this.summary(record)
  }

  stop(id) {
    const live = this.live.get(id)
    if (live?.alive) live.proc.kill()
    return this.summary(this.#record(id))
  }

  async update(id, { title, archived }) {
    const record = this.#record(id)
    if (typeof title === 'string' && title.trim()) {
      record.title = title.trim().slice(0, 120)
      record.renamed = true
    }
    if (typeof archived === 'boolean') record.archived = archived
    await this.#save()
    this.#changed(record)
    return this.summary(record)
  }

  async remove(id) {
    if (!this.records.has(id)) return { removed: false }
    const live = this.live.get(id)
    this.live.delete(id)
    if (live?.alive) live.proc.kill()
    live?.term.dispose()
    this.records.delete(id)
    this.subscribers.delete(id)
    await this.#save()
    this.emit('removed', { terminalId: id })
    return { removed: true }
  }

  /** A report from claude-hook.js; false when it does not come from a task's current process. */
  hook(id, secret, input) {
    const record = this.records.get(id)
    const live = this.live.get(id)
    if (!record || !live?.alive || !sameToken(secret, live.secret) || !input || typeof input !== 'object') return false
    const effect = hookEffect(input, live.activity)
    const event = input.hook_event_name
    // Claude Code reports its session before it takes the prompt it started with.
    if (live.promptPending && event === 'SessionStart') effect.activity = live.activity
    if (['UserPromptSubmit', 'Stop', 'StopFailure'].includes(event)) live.promptPending = false
    let save = false
    if (typeof effect.session === 'string' && /^[0-9a-f-]{36}$/i.test(effect.session) && effect.session !== record.sessionId) {
      record.sessionId = effect.session
      save = true
    }
    if (typeof effect.transcript === 'string' && effect.transcript !== record.transcriptPath) {
      record.transcriptPath = effect.transcript
      save = true
    }
    if (effect.touched) {
      record.updatedAt = Date.now()
      save = true
    }
    const reported = (effect.model && effect.model !== live.model) || (effect.effort && effect.effort !== live.effort)
    if (effect.model) live.model = effect.model
    if (effect.effort) live.effort = effect.effort
    if (input.hook_event_name === 'SessionStart') live.sessionAt = Date.now()
    const before = live.activity
    live.activity = effect.activity
    if (save) void this.#save()
    if (save || reported || before !== live.activity) this.#changed(record)
    if (live.activity === 'approval' && before !== 'approval') this.emit('approval-needed', { terminalId: id, title: record.title })
    if (effect.finished && before !== 'idle') this.emit('turn-finished', { terminalId: id, title: record.title, failed: Boolean(effect.failed) })
    // A team reads the reply a turn ended with (Stop's last_assistant_message) and its errors.
    this.emit('hook', { terminalId: id, input })
    return true
  }

  /** Ends every Claude Code process (the app is quitting); their tasks resume on the next start. */
  async shutdown() {
    for (const live of this.live.values()) {
      if (!live.alive) continue
      try {
        live.proc.kill()
      } catch {}
    }
    await this.writes
  }
}
