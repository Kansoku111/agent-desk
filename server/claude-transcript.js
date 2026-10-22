// Reads the file Claude Code keeps of a conversation (its "transcript", one JSON
// object per line) and folds it into the same turns the thread view shows, so a
// phone can read a CL task as a chat instead of a terminal screen. The file can
// be hundreds of MB (it holds every request Claude Code sent), so it is read in
// pieces, lines that are not messages are skipped unparsed, and later reads
// continue from where the last one stopped.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { clip } from './transcript.js'

/** Turns kept in memory and sent; the conversation before them is only counted. */
export const MAX_TURNS = 80
const CHUNK = 4 * 1024 * 1024
/** A line longer than this is a request body or a pasted file, never a message worth showing. */
const MAX_LINE = 8 * 1024 * 1024
const MAX_CACHED = 6
const IDLE_MS = 10 * 60_000

/** Lines that hold messages start with one of these (the others are requests, snapshots and bookkeeping). */
const WANTED = [Buffer.from('{"parentUuid"'), Buffer.from('{"type":"system"')]

const NOISE = /^<(local-command-|task-notification|system-reminder>\s*$)/
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const INTERRUPT = /^\[Request interrupted by user/

const time = (entry) => {
  const value = Date.parse(entry?.timestamp)
  return Number.isFinite(value) ? value : Date.now()
}

/** The text a user entry shows: slash commands as typed, system reminders and command output left out. */
export function userText(content) {
  const parts = []
  if (typeof content === 'string') parts.push(content)
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block?.type === 'image') parts.push('[画像]')
    }
  }
  const shown = []
  for (const part of parts) {
    const command = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(part)
    if (command) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(part)?.[1]?.trim()
      shown.push(args ? `${command[1]} ${args}` : command[1])
      continue
    }
    const text = part.replace(REMINDER, '').trim()
    if (text && !NOISE.test(text)) shown.push(text)
  }
  return shown.join('\n\n')
}

/** A tool call's arguments, with a very long text (a file being written) cut short. */
function clipInput(input) {
  if (!input || typeof input !== 'object') return {}
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? clip(value) : value]))
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block?.type === 'text' ? block.text : block?.type === 'image' ? '[画像]' : '')).filter(Boolean).join('\n')
}

/** The conversation of one transcript file, kept up to date as the file grows. */
export class ClaudeConversation {
  constructor() {
    this.epoch = randomBytes(6).toString('hex')
    this.reset()
  }

  reset() {
    this.offset = 0
    this.rest = Buffer.alloc(0)
    this.skipping = false
    this.turns = []
    this.tools = new Map()
    this.omitted = 0
    this.rev = 0
    this.epoch = randomBytes(6).toString('hex')
  }

  #touch(turn) {
    this.rev += 1
    turn.rev = this.rev
  }

  get #current() {
    return this.turns.at(-1)
  }

  #finish(turn, status, at) {
    if (turn.status !== 'running') return
    turn.status = status
    turn.endedAt = at
    this.#touch(turn)
  }

  #startTurn(entry, text) {
    const last = this.#current
    if (last) this.#finish(last, 'done', time(entry))
    const turn = {
      id: String(entry.uuid ?? `turn-${this.rev + 1}`),
      startedAt: time(entry),
      endedAt: null,
      status: 'running',
      stopReason: null,
      error: null,
      user: { text, images: [] },
      items: [],
    }
    this.turns.push(turn)
    this.#touch(turn)
    while (this.turns.length > MAX_TURNS) {
      const dropped = this.turns.shift()
      this.omitted += 1
      for (const item of dropped.items) if (item.type === 'tool') this.tools.delete(item.id)
    }
  }

  /** Folds one parsed line in. */
  add(entry) {
    if (!entry || typeof entry !== 'object' || entry.isSidechain) return
    if (entry.type === 'system') {
      const turn = this.#current
      if (!turn) return
      if (entry.subtype === 'turn_duration') this.#finish(turn, 'done', time(entry))
      else if (entry.subtype === 'compact_boundary') {
        turn.items.push({ type: 'notice', id: String(entry.uuid), level: 'info', text: '会話を要約して続けています' })
        this.#touch(turn)
      }
      return
    }
    // What the user typed while Claude Code worked: it read it at its next step (the other queued commands are notifications, not the user).
    if (entry.type === 'attachment') {
      const queued = entry.attachment
      const turn = this.#current
      const text = queued?.type === 'queued_command' && queued.commandMode === 'prompt' && queued.origin?.kind === 'human' ? userText(queued.prompt) : ''
      if (turn && text) {
        turn.items.push({ type: 'steer', id: String(entry.uuid), text, images: [], at: time(entry) })
        this.#touch(turn)
      }
      return
    }
    const content = entry.message?.content
    if (entry.type === 'user') {
      if (entry.isMeta || entry.isCompactSummary) return
      const results = Array.isArray(content) ? content.filter((block) => block?.type === 'tool_result') : []
      for (const result of results) {
        const tool = this.tools.get(result.tool_use_id)
        if (!tool) continue
        tool.output = clip(resultText(result.content))
        tool.status = result.is_error ? 'failed' : 'completed'
        tool.endedAt = time(entry)
        this.#touch(this.#ownerOf(tool.id))
      }
      if (results.length) return
      const text = userText(content)
      if (!text) return
      if (INTERRUPT.test(text)) {
        const turn = this.#current
        if (turn) this.#finish(turn, 'cancelled', time(entry))
        return
      }
      this.#startTurn(entry, text)
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      const turn = this.#current ?? (this.#startTurn(entry, ''), this.#current)
      content.forEach((block, index) => {
        if (block?.type === 'text' && block.text?.trim()) {
          turn.items.push({ type: 'agent', id: `${entry.uuid}:${index}`, text: block.text })
        } else if (block?.type === 'thinking' && block.thinking?.trim()) {
          turn.items.push({ type: 'thought', id: `${entry.uuid}:${index}`, text: block.thinking })
        } else if (block?.type === 'tool_use' && block.id) {
          const tool = {
            type: 'tool', id: block.id, name: String(block.name ?? 'tool'), kind: 'other', status: 'in_progress',
            input: clipInput(block.input), startedAt: time(entry),
          }
          turn.items.push(tool)
          this.tools.set(block.id, tool)
        }
      })
      this.#touch(turn)
    }
  }

  #ownerOf(toolId) {
    return this.turns.findLast((turn) => turn.items.some((item) => item.type === 'tool' && item.id === toolId)) ?? this.#current
  }

  /** Takes more of the file's bytes, from the offset where the last ones ended. */
  feed(chunk) {
    this.offset += chunk.length
    let data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk
    let start = 0
    for (;;) {
      const end = data.indexOf(0x0a, start)
      if (end === -1) break
      if (!this.skipping) this.#line(data.subarray(start, end))
      this.skipping = false
      start = end + 1
    }
    let rest = data.subarray(start)
    // A line that is already too long is dropped as it arrives, not held.
    if (rest.length > MAX_LINE) {
      this.skipping = true
      rest = Buffer.alloc(0)
    }
    this.rest = rest.length ? Buffer.from(rest) : rest
  }

  #line(line) {
    if (!WANTED.some((prefix) => line.length > prefix.length && line.subarray(0, prefix.length).equals(prefix))) return
    try {
      this.add(JSON.parse(line.toString('utf8')))
    } catch {
      // A half-written or odd line is skipped.
    }
  }

  /** What changed after revision `since` (all of it when `since` is 0). */
  snapshot(since) {
    return {
      epoch: this.epoch,
      rev: this.rev,
      omitted: this.omitted,
      reset: since === 0,
      turns: this.turns.filter((turn) => turn.rev > since),
      ids: this.turns.map((turn) => turn.id),
    }
  }
}

/** Keeps the conversations of the transcript files in use, each read once and then followed. */
export class ClaudeTranscripts {
  constructor() {
    this.files = new Map()
  }

  async #catchUp(entry, file) {
    const handle = await fs.open(file, 'r')
    try {
      const { size } = await handle.stat()
      if (size < entry.conversation.offset) entry.conversation.reset()
      const buffer = Buffer.allocUnsafe(CHUNK)
      while (entry.conversation.offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - entry.conversation.offset), entry.conversation.offset)
        if (!bytesRead) break
        entry.conversation.feed(Buffer.from(buffer.subarray(0, bytesRead)))
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * The conversation in `file`, as the turns changed since the viewer's last
   * read (`epoch` and `since` are what its last read returned).
   */
  async read(file, { epoch = null, since = 0 } = {}) {
    let entry = this.files.get(file)
    if (!entry) {
      entry = { conversation: new ClaudeConversation(), busy: null, used: 0 }
      this.files.set(file, entry)
    }
    entry.used = Date.now()
    // One read at a time per file; a second caller waits for the first and then only adds what is new.
    const previous = entry.busy
    const work = (async () => {
      await previous?.catch(() => {})
      await this.#catchUp(entry, file)
    })()
    entry.busy = work
    try {
      await work
    } finally {
      if (entry.busy === work) entry.busy = null
    }
    this.#prune()
    const conversation = entry.conversation
    const known = epoch === conversation.epoch && since <= conversation.rev
    const snapshot = conversation.snapshot(known ? since : 0)
    return snapshot
  }

  #prune() {
    const now = Date.now()
    for (const [file, entry] of this.files) if (now - entry.used > IDLE_MS) this.files.delete(file)
    while (this.files.size > MAX_CACHED) {
      const oldest = [...this.files].sort((a, b) => a[1].used - b[1].used)[0]
      this.files.delete(oldest[0])
    }
  }
}
