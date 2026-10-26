// Live view of the subagents a task starts.
//
// ACP only reports the task's own session: dsh-acp drops the events of child
// sessions. dsh does log every child to disk, in the parent's folder
// (`<DSH_HOME>/sessions/<cwd>/<childId>/session.v4.jsonl.zstd`), batching
// writes every 200 ms, and the parent's log names each child it starts
// (`subagent/catalog`). While a task runs, Agent Desk tails those logs and
// folds each child's events into the same item shapes a turn uses, so the UI
// can show what every subagent is doing, on which model.
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { clip } from './transcript.js'
import { findSessionLog, loadPricing, priceResponse } from './usage.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_NAME = 'session.v4.jsonl.zstd'
/** Pieces joined at most when a magic number inside compressed data splits a frame. */
const MAX_JOIN = 4
/** Shown per tool result; the panel needs the gist, not whole files. */
const MAX_OUTPUT = 4000
/** Items kept per subagent; older ones drop off a very long run. */
const MAX_ITEMS = 400
/** How long a log keeps being read after its task stops, for the last writes. */
const GRACE_MS = 30_000
/** Unwatched tasks whose logs are dropped from memory after this long. */
const IDLE_EVICT_MS = 15 * 60_000

const decompress = promisify(zlib.zstdDecompress)
/** Frames decompressed at once (on the thread pool) while a log is read. */
const PREFETCH = 16

/** The decompressed text of a piece, or null when it does not decode. */
const pieceText = (piece) => decompress(piece).then((text) => text.toString('utf8'), () => null)

/**
 * The events on every complete line of a frame's text, or null when the piece is
 * not one whole frame. Lines `keep` turns down are not parsed.
 */
function frameEvents(text, keep) {
  if (text === null) return null
  // A frame cut short decodes without an error but stops mid-line.
  if (!text.endsWith('\n')) return null
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim() || (keep && !keep(line))) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      return null
    }
  }
  return events
}

/** The complete lines decoded so far from a frame that may still be written. */
function partialEvents(text, keep) {
  text ??= ''
  const events = []
  for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
    if (!line.trim() || (keep && !keep(line))) continue
    try {
      events.push(JSON.parse(line))
    } catch {}
  }
  return events
}

/**
 * Decodes the frames of a log read from a frame start. The last frame may
 * still be growing, so `consumed` stops at its start and the next read
 * decodes it again (callers drop events they have seen by `seq`). Frames are
 * decompressed on the thread pool, a batch at a time, so a long log does not
 * hold up the event loop.
 * @param {Buffer} buffer
 * @param {{ keep?: ((line: string) => boolean) | null }} [options] `keep` tests a raw line;
 *   only lines it accepts are parsed and returned.
 * @returns {Promise<{ events: object[], consumed: number }>}
 */
export async function decodeFrames(buffer, { keep = null } = {}) {
  const starts = []
  for (let index = buffer.indexOf(ZSTD_MAGIC); index !== -1; index = buffer.indexOf(ZSTD_MAGIC, index + 4)) starts.push(index)
  const events = []
  const single = new Map()
  // The text of the piece from one start to the next, ready before it is asked for.
  const singleText = async (index) => {
    if (!single.has(index)) {
      const upto = Math.min(starts.length, index + PREFETCH)
      const batch = []
      for (let at = index; at < upto; at += 1) {
        single.set(at, pieceText(buffer.subarray(starts[at], starts[at + 1] ?? buffer.length)))
        batch.push(single.get(at))
      }
      await Promise.all(batch)
    }
    return single.get(index)
  }
  let consumed = starts[0] ?? 0
  let from = 0
  while (from < starts.length) {
    const previous = from
    let next = -1
    for (let to = from + 1; to < starts.length && to <= from + MAX_JOIN; to += 1) {
      const text = to === from + 1 ? await singleText(from) : await pieceText(buffer.subarray(starts[from], starts[to]))
      const decoded = frameEvents(text, keep)
      if (decoded) {
        events.push(...decoded)
        next = to
        break
      }
    }
    if (next !== -1) {
      from = next
      consumed = starts[from]
      for (let index = previous; index < from; index += 1) single.delete(index)
      continue
    }
    if (starts.length - from <= MAX_JOIN) {
      // The frame being written (maybe with a magic number inside it).
      events.push(...partialEvents(await pieceText(buffer.subarray(starts[from])), keep))
      consumed = starts[from]
      break
    }
    // A piece no join can decode: skip it rather than stall on it.
    from += 1
    consumed = starts[from]
    single.delete(previous)
  }
  return { events, consumed }
}

/**
 * The lines of a task's own log that {@link SubagentTracker} uses: the calls
 * that may start a subagent, the catalog entries naming one, and the header.
 */
const ROOT_LINE = (line) => line.includes('tool/call') || line.includes('tool/ptc-dispatch-start') || line.includes('subagent/catalog') || line.includes('"session"')

/** Reads one session log as it grows, returning each event once. */
export class LogTail {
  /**
   * @param {string} file
   * @param {{ keep?: ((line: string) => boolean) | null }} [options] only lines `keep` accepts are parsed
   *   (the rest never reach the caller, so they do not move the `seq` that tells what was seen).
   */
  constructor(file, { keep = null } = {}) {
    this.file = file
    this.keep = keep
    this.#reset()
  }

  #reset() {
    this.offset = 0
    this.size = -1
    this.lastSeq = -1
    this.header = null
    this.ino = null
    this.mtimeMs = null
  }

  /** Events added since the last read; [] while the file is missing or unchanged. */
  async read() {
    let stat
    try {
      stat = await fs.stat(this.file)
    } catch {
      return []
    }
    const sameSizeRewrite = stat.size === this.size && this.size >= 0
      && (stat.ino !== this.ino || stat.mtimeMs !== this.mtimeMs)
    if (stat.size === this.size && !sameSizeRewrite) return []
    // dsh rewrote the log (recovery); read it again from the start.
    if (stat.size < this.size || sameSizeRewrite) this.#reset()
    let buffer
    const handle = await fs.open(this.file, 'r')
    try {
      buffer = Buffer.alloc(stat.size - this.offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset)
      buffer = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    this.size = this.offset + buffer.length
    this.ino = stat.ino
    this.mtimeMs = stat.mtimeMs
    const { events, consumed } = await decodeFrames(buffer, { keep: this.keep })
    this.offset += consumed
    const fresh = []
    for (const event of events) {
      if (event?.type === 'session' && event.seq === undefined) {
        this.header ??= event
        continue
      }
      if (!Number.isInteger(event?.seq) || event.seq <= this.lastSeq) continue
      this.lastSeq = event.seq
      fresh.push(event)
    }
    return fresh
  }
}

const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text)

function parseArguments(value) {
  try {
    return JSON.parse(value)
  } catch {
    return value === undefined ? undefined : { arguments: value }
  }
}

/** dsh adds this to a child's task so it can message its parent; not part of the task itself. */
const PARENT_NOTE = /^Your parent agent id is /
/** The line dsh puts before a relayed agent message. */
const SENDER_NOTE = /^Agent \S+ sent a message: ?$/

/**
 * A subagent's view, before any of its own events.
 * @param header - the log's first line (`type: 'session'`).
 */
export function newChild(header, { parentId = header.parentSession ?? null, depth = header.delegationDepth ?? 1, callId = null, label = null } = {}) {
  return {
    id: header.id,
    parentId,
    depth,
    callId,
    label,
    mode: null,
    title: null,
    provider: null,
    model: null,
    effort: null,
    status: 'starting',
    startedAt: header.createdAt ?? null,
    updatedAt: header.createdAt ?? null,
    endedAt: null,
    prompt: '',
    items: [],
    usage: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null },
    // A fork starts from a copy of its parent's history; that part is not its own work.
    seeding: header.isSeeded === true,
  }
}

const END_STATUS = { completed: 'done', 'max-tokens': 'done', interrupted: 'cancelled', aborted: 'cancelled', error: 'error', blocked: 'error' }

function pushItem(child, item) {
  child.items.push(item)
  if (child.items.length > MAX_ITEMS) child.items.splice(0, child.items.length - MAX_ITEMS)
}

/**
 * Applies one logged event to a subagent's view.
 * @param pricing - catalog rates ({@link loadPricing}); null skips the cost.
 */
export function foldChild(child, event, pricing = null) {
  if (Number.isFinite(event.time)) child.updatedAt = event.time
  const data = event.data ?? {}
  switch (event.type) {
    case 'subagent/descriptor':
      child.label = data.label ?? child.label
      child.mode = data.mode ?? child.mode
      child.provider = data.agentProvider ?? child.provider
      child.model = data.agentModel ?? child.model
      child.effort = data.agentReasoningEffort ?? child.effort
      return
    case 'request/header': {
      // The route the child really calls, which descriptors leave out when it inherits the parent's.
      const config = data.header?.config
      if (config?.provider) child.provider = config.provider
      if (config?.model) child.model = config.model
      if (config?.reasoningEffort) child.effort = config.reasoningEffort
      return
    }
    case 'session/end-seed':
      child.seeding = false
      return
    default:
  }
  if (child.seeding) return
  switch (event.type) {
    case 'session/title':
      if (typeof data.title === 'string') child.title = data.title
      return
    case 'turn/start':
      child.status = 'running'
      child.endedAt = null
      return
    case 'turn/end': {
      const kind = data.reason?.kind
      child.status = END_STATUS[kind] ?? 'done'
      child.endedAt = event.time ?? null
      const failure = data.reason?.error?.message ?? data.reason?.failure?.message
      if (child.status === 'error') pushItem(child, { type: 'notice', id: `end-${event.seq}`, level: 'warning', text: failure ? `エラーで終了しました: ${failure}` : 'エラーで終了しました' })
      return
    }
    case 'user/message': {
      const kind = data.source?.kind
      if (kind === 'user') {
        const text = textOf(data.content).filter((part) => !PARENT_NOTE.test(part)).join('\n\n').trim()
        if (text && !child.prompt) child.prompt = text
        else if (text) pushItem(child, { type: 'steer', id: data.id ?? `user-${event.seq}`, text, images: [], at: event.time ?? 0 })
      } else if (kind === 'agent-message') {
        // A message from another agent (send_message), usually the parent, while the child works.
        const text = textOf(data.content).filter((part) => !SENDER_NOTE.test(part)).join('').trim()
        if (text) pushItem(child, { type: 'steer', id: data.id ?? `message-${event.seq}`, text, images: [], at: event.time ?? 0, from: 'agent' })
      }
      return
    }
    case 'assistant/message': {
      const message = data.message ?? {}
      let thought = null
      for (const [index, block] of (message.content ?? []).entries()) {
        if (block?.type === 'reasoning') {
          if (!block.text) continue
          // A model may stream many reasoning blocks; they read as one thought.
          if (thought) thought.text += `\n\n${block.text}`
          else {
            thought = { type: 'thought', id: `${message.id}-r${index}`, text: block.text }
            pushItem(child, thought)
          }
        } else if (block?.type === 'text' && block.text) {
          thought = null
          pushItem(child, { type: 'agent', id: `${message.id}-t${index}`, text: block.text })
        }
      }
      const usage = data.usage
      if (usage) {
        child.usage.requests += 1
        child.usage.input += usage.inputTokens ?? 0
        child.usage.output += usage.outputTokens ?? 0
        child.usage.cacheRead += usage.cacheReadTokens ?? 0
        child.usage.cacheWrite += usage.cacheWriteTokens ?? 0
        const source = message.source ?? {}
        const price = pricing && source.provider && source.model ? priceResponse(pricing, `${source.provider}/${source.model}`, usage, event.time) : null
        if (price !== null) child.usage.cost = (child.usage.cost ?? 0) + price
      }
      return
    }
    case 'tool/call':
      pushItem(child, {
        type: 'tool',
        id: data.callId,
        name: data.name ?? 'tool',
        kind: 'other',
        status: 'in_progress',
        input: parseArguments(data.arguments),
        output: '',
        startedAt: event.time,
      })
      return
    case 'tool/result': {
      const message = data.message ?? {}
      const item = child.items.find((entry) => entry.type === 'tool' && entry.id === message.toolCallId)
      if (!item) return
      item.status = message.isError === true ? 'failed' : 'completed'
      item.output = clip(textOf(message.content).join('\n'), MAX_OUTPUT)
      item.endedAt = event.time
      return
    }
    case 'assistant/attempt': {
      // A failed model request; dsh retries it, so this is a note, not the end.
      const finish = (data.stream ?? []).map((entry) => entry?.chunk).find((chunk) => chunk?.type === 'finish')
      const failure = finish?.reason?.kind === 'error' ? finish.reason.failure?.message : null
      if (failure) pushItem(child, { type: 'notice', id: `attempt-${event.seq}`, level: 'warning', text: `モデルの呼び出しに失敗しました: ${failure}` })
      return
    }
    default:
  }
}

/** Tools that start a subagent; their calls are matched to the children they start. */
const DELEGATING_TOOL = /^subagent/

/**
 * Watches the subagents of running tasks and reports each change.
 * Emits `change` with `{ threadId, subagent }`.
 */
export class SubagentTracker extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.dshHome
   * @param {(provider: string, model: string) => string | null} [options.modelName] - display name of a model.
   * @param {(sessionId: string) => boolean} [options.isLive] - whether a runtime still holds the task's session.
   */
  constructor({ dshHome, modelName = () => null, isLive = () => true, pollMs = 1000 }) {
    super()
    this.dshHome = dshHome
    this.modelName = modelName
    this.isLive = isLive
    this.pollMs = pollMs
    this.trees = new Map()
    this.timer = null
    this.pricing = null
  }

  #tree(threadId, sessionId) {
    let tree = this.trees.get(threadId)
    if (!tree || tree.sessionId !== sessionId) {
      tree = { threadId, sessionId, file: null, root: null, nodes: new Map(), calls: new Map(), watchUntil: 0, polling: null, usedAt: Date.now() }
      this.trees.set(threadId, tree)
    }
    return tree
  }

  /** The subagents a task's session started, read from disk as needed. */
  async list(threadId, sessionId) {
    if (!sessionId) return []
    const tree = this.#tree(threadId, sessionId)
    tree.usedAt = Date.now()
    await this.#poll(tree, false)
    this.#evict()
    return [...tree.nodes.values()].filter((node) => node.child).map((node) => this.#view(tree, node))
  }

  /** Follows a task: its logs are read every second while it runs, and for a while after. */
  follow(threadId, sessionId, running) {
    if (!sessionId) return
    const tree = this.#tree(threadId, sessionId)
    tree.usedAt = Date.now()
    if (running) {
      if (tree.watchUntil !== Infinity) {
        tree.watchUntil = Infinity
        void this.#poll(tree, true)
      }
    } else if (tree.watchUntil === Infinity) {
      tree.watchUntil = Date.now() + GRACE_MS
    }
    this.#arm()
  }

  forget(threadId) {
    this.trees.delete(threadId)
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }

  #arm() {
    if (this.timer) return
    this.timer = setInterval(() => this.#tick(), this.pollMs)
    this.timer.unref?.()
  }

  async #tick() {
    const now = Date.now()
    let watching = false
    for (const tree of this.trees.values()) {
      if (tree.watchUntil <= now) continue
      watching = true
      await this.#poll(tree, true)
      // A child left running in the background keeps its task watched.
      const busy = [...tree.nodes.values()].some((node) => node.child && ['starting', 'running'].includes(node.child.status))
      if (busy && tree.watchUntil !== Infinity && this.isLive(tree.sessionId)) tree.watchUntil = now + GRACE_MS
    }
    this.#evict()
    if (!watching && !this.trees.size) this.stop()
  }

  #evict() {
    const now = Date.now()
    for (const [threadId, tree] of this.trees) {
      if (tree.watchUntil <= now && now - tree.usedAt > IDLE_EVICT_MS) this.trees.delete(threadId)
    }
  }

  /** One read of a task's logs; reads of one task never overlap. */
  #poll(tree, emit) {
    tree.polling = (tree.polling ?? Promise.resolve()).then(() => this.#read(tree, emit)).catch((error) => {
      console.error('[agent-desk] subagents:', error.message)
    })
    return tree.polling
  }

  async #read(tree, emit) {
    this.pricing ??= await loadPricing().catch(() => null)
    if (!tree.file) {
      tree.file = await findSessionLog(this.dshHome, tree.sessionId)
      if (!tree.file) return
      tree.root = new LogTail(tree.file, { keep: ROOT_LINE })
    }
    this.#scan(tree, tree.sessionId, 1, await tree.root.read())
    const folder = path.dirname(path.dirname(tree.file))
    // Children found while reading are read in the same pass (Map iteration includes them).
    for (const node of tree.nodes.values()) {
      node.tail ??= new LogTail(path.join(folder, node.id, LOG_NAME))
      const events = await node.tail.read()
      if (!node.child) {
        if (!node.tail.header) continue
        node.child = newChild(node.tail.header, { parentId: node.parentId, depth: node.depth, callId: node.callId, label: node.label })
        node.dirty = true
      }
      for (const event of events) {
        const seeded = node.child.seeding
        foldChild(node.child, event, this.pricing)
        if (!seeded) this.#scan(tree, node.id, node.depth + 1, [event])
        node.dirty = true
      }
      if (node.dirty && emit) this.emit('change', { threadId: tree.threadId, subagent: this.#view(tree, node) })
      node.dirty = false
    }
  }

  /** Finds the children a session's events start, and the tool calls that started them. */
  #scan(tree, parentId, depth, events) {
    for (const event of events) {
      if (['tool/call', 'tool/ptc-dispatch-start'].includes(event.type) && DELEGATING_TOOL.test(event.data?.name ?? '')) {
        const calls = tree.calls.get(parentId) ?? []
        calls.push({ callId: event.data.subCallId ?? event.data.callId, description: parseArguments(event.data.arguments)?.description ?? null })
        tree.calls.set(parentId, calls)
      } else if (event.type === 'subagent/catalog' && event.data?.childId && !tree.nodes.has(event.data.childId)) {
        const label = event.data.label ?? null
        const calls = tree.calls.get(parentId) ?? []
        let index = calls.findIndex((call) => label !== null && call.description === label)
        if (index === -1 && calls.length) index = 0
        const [call] = index === -1 ? [] : calls.splice(index, 1)
        tree.nodes.set(event.data.childId, { id: event.data.childId, parentId, depth, callId: call?.callId ?? null, label, tail: null, child: null, dirty: false })
      }
    }
  }

  #view(tree, node) {
    const { seeding, ...child } = node.child
    // A child cut off by a runtime exit stays "running" in its log.
    const stopped = ['starting', 'running'].includes(child.status) && !this.isLive(tree.sessionId)
    return {
      ...child,
      status: stopped ? 'stopped' : child.status,
      modelName: child.provider && child.model ? this.modelName(child.provider, child.model) : null,
    }
  }
}
