// Threads: Agent Desk's conversations. Each thread owns one ACP session in the
// dsh runtime for its permission mode, plus a transcript stored by Agent Desk
// (ACP resume restores the model context but does not replay history).
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileListText, isImageFile } from './attachments.js'
import { debouncedWriter, readJson } from './json-file.js'
import { workspacesOverlap } from './execution.js'
import { PERMISSION_MODES, runtimeKey } from './runtime.js'
import { applyUpdate, newTurn, parseConfigOptions, settleTurn, titleFrom, nearestEffort } from './transcript.js'
import { assertWorkflowEffort, assertWorkflowApplied } from '../shared/workflow-effort.js'
import {
  assertDirectory, carryoverText, describeError, isUndoable, normalizeMessage, receiptStatus, restoreNoteText,
  shortMessage, validateMessageId, PLAN_INSTRUCTION,
} from './thread-utils.js'
import { turnUsage } from './usage.js'
import { OUTPUT_SPEED_META } from './output-speed.js'
import { TOOL_MODE_CONFIG, assertToolMode, assertToolModeApplied, toolModeOption } from './ptc.js'
import { emptyScore, scoresUpTo } from '../shared/usage-score.js'
import { assertSessionPolicy } from './session-policy-plugin.js'
export { carryoverText, describeError, isUndoable, restoreNoteText } from './thread-utils.js'

const TURN_EMIT_MS = 60

/**
 * The last moment a turn is known to have been active: its start, a tool call,
 * or a message added while it ran. The crash that ended it is unobserved, so
 * the time the transcript is read must not stand in for it.
 */
function lastActivityAt(turn, fallback = Date.now()) {
  let last = Number.isFinite(turn.startedAt) ? turn.startedAt : null
  for (const item of turn.items ?? []) {
    for (const at of [item.startedAt, item.endedAt, item.at]) {
      if (!Number.isFinite(at)) continue
      last = last === null ? at : Math.max(last, at)
    }
  }
  return Math.min(last ?? fallback, Date.now())
}

export class ThreadManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {ReturnType<import('./paths.js').appPaths>} options.paths
   * @param {import('./runtime.js').RuntimePool} options.pool
   * @param {import('./catalog.js').Catalog} options.catalog
   * @param {() => Promise<object>} options.getAccounts  current account status
   */
  /**
   * @param options.getMcpServers - the MCP servers (ACP form) a task's session mounts.
   * @param options.checkpoints - workspace snapshots for undoing a turn's file changes.
   * @param options.checkpointsEnabled - whether turns take snapshots now.
   * @param options.getTurnUsage - reads the finished turn's usage from its session log.
   */
  constructor({ paths, pool, catalog, getAccounts, getMcpServers = () => [], checkpoints = null, checkpointsEnabled = () => true, getTurnUsage = turnUsage }) {
    super()
    this.paths = paths
    this.pool = pool
    this.catalog = catalog
    this.getAccounts = getAccounts
    this.getMcpServers = getMcpServers
    this.checkpoints = checkpoints
    this.checkpointsEnabled = checkpointsEnabled
    this.getTurnUsage = getTurnUsage
    this.threads = new Map()
    this.turns = new Map()
    this.turnLoads = new Map()
    this.pendingUsageRefresh = new Set()
    this.receipts = new Map()
    this.createReceipts = new Map()
    this.createFlights = new Map()
    this.requests = new Map()
    this.removing = new Map()
    this.indexRemovals = new Set()
    this.restoring = new Set()
    this.stopping = false
    this.shutdownTask = null
    this.turnWriters = new Map()
    this.sessionIndex = new Map()
    this.liveOptions = new Map()
    this.active = new Map()
    this.permissions = new Map()
    this.emitTimers = new Map()
    this.indexWriter = debouncedWriter(paths.threadsIndex)
    pool.on('exit', (info) => this.#onRuntimeExit(info))
  }

  // ---------------------------------------------------------------- storage

  async load() {
    const index = await readJson(this.paths.threadsIndex, { version: 1, threads: [] })
    for (const thread of index.threads ?? []) {
      thread.status = 'idle'
      thread.pendingApproval = false
      thread.toolMode ??= 'native'
      this.threads.set(thread.id, thread)
      if (thread.sessionId) this.sessionIndex.set(thread.sessionId, thread.id)
    }
    const createReceipts = index.createReceipts ?? []
    if (!Array.isArray(createReceipts)) throw new Error('初回作成の受領記録が壊れています')
    for (const entry of createReceipts) {
      if (!entry || !validateMessageId(entry.createId) || typeof entry.payloadHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.payloadHash) || typeof entry.threadId !== 'string'
        || typeof entry.deleted !== 'boolean' || this.createReceipts.has(entry.createId)) {
        throw new Error('初回作成の受領記録が壊れています')
      }
      if (!entry.deleted && !this.threads.has(entry.threadId)) throw new Error('初回作成の受領先タスクが見つかりません')
      this.createReceipts.set(entry.createId, entry)
    }
  }

  #saveIndex() {
    const threads = [...this.threads.values()]
      .filter((thread) => !this.indexRemovals.has(thread.id))
      .map(({ status, pendingApproval, ...stored }) => stored)
    const createReceipts = [...this.createReceipts.values()]
    this.indexWriter.schedule({ version: 1, threads, ...(createReceipts.length ? { createReceipts } : {}) })
  }

  #turnFile(threadId) {
    return path.join(this.paths.threadsDir, `${threadId}.json`)
  }

  async #loadTurns(threadId) {
    if (this.turns.has(threadId)) return this.turns.get(threadId)
    if (this.turnLoads.has(threadId)) return this.turnLoads.get(threadId)
    const loading = this.#readTurns(threadId)
    this.turnLoads.set(threadId, loading)
    try {
      return await loading
    } finally {
      this.turnLoads.delete(threadId)
    }
  }

  async #readTurns(threadId) {
    const thread = this.#available(threadId)
    // Losing receipts on a corrupt document could execute an accepted message
    // twice. Fail closed rather than treating a broken transcript as empty.
    const doc = await readJson(this.#turnFile(threadId), { version: 1, turns: [] }, { recoverCorrupt: false })
    this.#available(threadId, thread)
    const turns = doc.turns ?? []
    let interrupted = false
    for (const turn of turns) {
      if (turn.status === 'running' && !this.active.has(threadId)) {
        if (turn.outputSpeed) delete turn.outputSpeed
        settleTurn(turn, {
          status: 'error',
          error: { message: 'アプリの終了により中断されました。' },
          now: lastActivityAt(turn),
        })
        interrupted = true
      }
    }
    const repaired = await this.#recoverUsage(threadId, thread, turns)
    this.#available(threadId, thread)
    const receipts = new Map((doc.receipts ?? []).map((entry) => [entry.messageId, entry]))
    this.receipts.set(threadId, receipts)
    this.turns.set(threadId, turns)
    thread.score = scoresUpTo(turns).at(-1) ?? emptyScore()
    this.#saveIndex()
    // Settled interrupted turns are transcript changes too: the file must say what
    // the UI was shown (failed tools included), not that work is still running.
    if (interrupted || repaired.length) this.#saveTurns(threadId)
    if (repaired.length) this.emit('usage-priced', this.summary(thread))
    return turns
  }

  // Recover wholly unpriced turns and old DeepSeek bills only from matching
  // log intervals. Never change a known score or a cumulative snapshot.
  async #recoverUsage(threadId, thread, turns) {
    const repaired = []
    const canRecoverScores = !turns.some((turn) => turn.totalScore)
    for (const turn of turns) {
      const prior = turn.usage
      const deepSeek = prior?.cost === null && prior.models?.some((model) => model.startsWith('deepseek-official/'))
      const unpriced = canRecoverScores && prior?.models?.length > 0 && prior.requests > 0
        && (!prior.score || (prior.score.points === 0 && prior.score.priced === 0 && prior.score.unpriced === prior.requests))
      if ((!deepSeek && !unpriced) || !Number.isFinite(turn.endedAt) || !thread.sessionId) continue
      try {
        const usage = await this.getTurnUsage({ dshHome: this.paths.dshHome, sessionId: thread.sessionId,
          since: turn.startedAt, until: turn.endedAt, waitMs: 0 })
        this.#available(threadId, thread)
        if (!usage) continue
        if (['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].some((key) => prior[key] !== usage[key])) continue
        if (!isDeepStrictEqual([...prior.models].sort(), [...usage.models].sort())) continue
        const recoverCost = deepSeek && usage.cost != null
        const recoverScore = unpriced && usage.score?.priced > 0 && usage.score.priced + usage.score.unpriced === prior.requests
        if (!recoverCost && !recoverScore) continue
        turn.usage = { ...prior, ...(recoverCost ? { cost: usage.cost } : {}),
          ...((recoverScore || (recoverCost && !prior.score && usage.score)) ? { score: usage.score } : {}) }
        repaired.push(turn)
      } catch {}
    }
    return repaired
  }

  #turnWriter(threadId) {
    let writer = this.turnWriters.get(threadId)
    if (!writer) {
      writer = debouncedWriter(this.#turnFile(threadId), 400)
      this.turnWriters.set(threadId, writer)
    }
    return writer
  }

  #turnDocument(threadId) {
    return { version: 1, turns: this.turns.get(threadId) ?? [], receipts: [...(this.receipts.get(threadId)?.values() ?? [])] }
  }

  #saveTurns(threadId) {
    this.#turnWriter(threadId).schedule(this.#turnDocument(threadId))
  }

  #persistTurns(threadId) {
    return this.#turnWriter(threadId).write(this.#turnDocument(threadId))
  }

  // Serialize admission/status, not model execution. A status lookup cannot
  // expose an in-memory receipt before its durable write has completed.
  #request(threadId, action) {
    const previous = this.requests.get(threadId) ?? Promise.resolve()
    const request = previous.catch(() => {}).then(action)
    this.requests.set(threadId, request)
    void request.finally(() => {
      if (this.requests.get(threadId) === request) this.requests.delete(threadId)
    }).catch(() => {})
    return request
  }

  #available(threadId, expected) {
    const thread = this.#require(threadId)
    if (this.stopping) throw new Error('アプリを終了しています')
    if (this.removing.has(threadId) || (expected && thread !== expected)) throw new Error('タスクを削除しています')
    return thread
  }

  #receipt(threadId, { messageId, text, images, plan }) {
    if (!messageId) return null
    const receipt = this.receipts.get(threadId)?.get(messageId)
    if (!receipt) return null
    if (!isDeepStrictEqual(receipt.payload, { text, images, ...(plan ? { plan: true } : {}) })) throw new Error('同じ messageId に異なるメッセージは送信できません')
    return receiptStatus(receipt)
  }

  /** Durable receipt only; pending runtime delivery is deliberately not replayable. */
  messageStatus(threadId, messageId) {
    const id = validateMessageId(messageId)
    if (!id) throw new Error('messageId が必要です')
    return this.#request(threadId, async () => {
      const thread = this.#available(threadId)
      await this.#loadTurns(threadId)
      this.#available(threadId, thread)
      return receiptStatus(this.receipts.get(threadId)?.get(id))
    })
  }

  /** Apply newly available prices to already open, wholly unpriced turns. */
  async refreshUnpricedUsage() {
    await Promise.allSettled([...this.turnLoads.values()])
    const ids = new Set(this.active.keys())
    for (const [id, turns] of this.turns) {
      if (turns.some((turn) => {
        const usage = turn.usage
        return usage?.models?.length > 0 && usage.requests > 0 && (!usage.score
          || (usage.score.points === 0 && usage.score.priced === 0 && usage.score.unpriced === usage.requests))
      })) ids.add(id)
    }
    await Promise.allSettled([...ids].map((id) => this.#refreshLoadedUsage(id)))
  }

  #refreshLoadedUsage(threadId) {
    return this.#request(threadId, async () => {
      const thread = this.threads.get(threadId)
      const turns = this.turns.get(threadId)
      if (!thread || !turns || this.stopping || this.removing.has(threadId)) return
      if (this.active.has(threadId)) {
        this.pendingUsageRefresh.add(threadId)
        return
      }
      const repaired = await this.#recoverUsage(threadId, thread, turns)
      this.#available(threadId, thread)
      if (!repaired.length) return
      thread.score = scoresUpTo(turns).at(-1) ?? emptyScore()
      this.#saveIndex()
      this.#saveTurns(threadId)
      for (const turn of repaired) this.#emitTurn(threadId, turn, true)
      this.emit('usage-priced', this.summary(thread))
    })
  }

  // ---------------------------------------------------------------- views

  summary(thread) {
    return { ...thread, pinned: Boolean(thread.pinned), toolMode: this.teamToolMode?.(thread) ?? thread.toolMode ?? 'native' }
  }

  list() {
    return [...this.threads.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((thread) => this.summary(thread))
  }

  async get(threadId) {
    const thread = this.#available(threadId)
    const turns = await this.#loadTurns(threadId)
    this.#available(threadId, thread)
    return { thread: this.summary(thread), turns }
  }

  #require(threadId) {
    const thread = this.threads.get(threadId)
    if (!thread) throw new Error('タスクが見つかりません')
    return thread
  }

  #emitThread(thread) {
    this.emit('thread', this.summary(thread))
  }

  #emitTurn(threadId, turn, immediate = false) {
    const key = `${threadId}:${turn.id}`
    const fire = () => {
      this.emitTimers.delete(key)
      this.emit('turn', { threadId, turn })
    }
    if (immediate) {
      clearTimeout(this.emitTimers.get(key))
      fire()
      return
    }
    if (!this.emitTimers.has(key)) this.emitTimers.set(key, setTimeout(fire, TURN_EMIT_MS))
  }

  /**
   * A speed change is not a transcript change: while it is still moving it goes
   * to the UI as a tiny event and is never written to disk. Only the settled
   * average (state 'done') is saved and sent with the whole turn.
   */
  #publishSpeed(threadId, turn) {
    if (turn.outputSpeed?.state === 'done') {
      this.#saveTurns(threadId)
      this.#emitTurn(threadId, turn)
      return
    }
    this.emit('turn-speed', { threadId, turnId: turn.id, speed: turn.outputSpeed ?? null })
  }

  // ---------------------------------------------------------------- commands

  /**
   * Creates and sends a new-thread message once per durable createId. The
   * promise covers reservation, admission and failure cleanup so a parallel
   * handler can never remove another handler's accepted thread.
   */
  createWithFirstMessage({ createId, payloadHash, options, message }) {
    const id = validateMessageId(createId)
    if (!id) return Promise.reject(new Error('createId が必要です'))
    if (typeof payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(payloadHash)) return Promise.reject(new Error('初回作成のfingerprintが不正です'))
    const pending = this.createFlights.get(id)
    if (pending) {
      if (pending.payloadHash !== payloadHash) return Promise.reject(new Error('同じ初回作成キーに異なる内容は使えません'))
      return pending.promise
    }
    const promise = Promise.resolve().then(() => this.#createWithFirstMessage(id, payloadHash, options, message))
    this.createFlights.set(id, { payloadHash, promise })
    void promise.finally(() => {
      if (this.createFlights.get(id)?.promise === promise) this.createFlights.delete(id)
    }).catch(() => {})
    return promise
  }

  async #createWithFirstMessage(createId, payloadHash, options, message) {
    let thread
    const known = this.createReceipts.get(createId)
    if (known) {
      if (known.payloadHash !== payloadHash) throw new Error('同じ初回作成キーに異なる内容は使えません')
      if (known.deleted) throw new Error('作成済みタスクは削除済みです')
      thread = this.threads.get(known.threadId)
      if (!thread) throw new Error('作成済みタスクは削除済みです')
    } else {
      const created = await this.create({ ...options, createReceipt: { createId, payloadHash } })
      thread = this.threads.get(created.id)
    }
    return this.#sendFirstMessage(thread, createId, message)
  }

  async #sendFirstMessage(thread, createId, message) {
    try {
      const receipt = await this.send(thread.id, { ...message, messageId: createId })
      if (receipt?.status !== 'accepted') throw new Error('初回メッセージの受領結果を確認できません')
      return { thread: this.summary(this.threads.get(thread.id)), receipt }
    } catch (error) {
      let receipt
      try {
        receipt = await this.messageStatus(thread.id, createId)
      } catch {
        // Never discard the reservation or retry under a new key when its
        // durable delivery state cannot be read.
        throw error
      }
      if (receipt.status === 'accepted') return { thread: this.summary(this.threads.get(thread.id)), receipt }
      if (receipt.status === 'missing') {
        try {
          await this.remove(thread.id, { forgetCreateReceipt: true })
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `${error.message}（作成タスクのcleanupにも失敗しました: ${cleanupError.message}）`)
        }
      }
      throw error
    }
  }

  /** `team`: the agent team (teams.js) this task works for as a child, as { id, childId }. */
  async create({ workspace, model, effort = '', permissionMode = 'workspace-write', toolMode = 'native', team = null, ab = null, createReceipt = null }) {
    if (this.stopping) throw new Error('アプリを終了しています')
    await assertDirectory(workspace)
    if (this.stopping) throw new Error('アプリを終了しています')
    if (!PERMISSION_MODES.includes(permissionMode)) throw new Error('不明な権限モードです')
    assertToolMode(toolMode)
    if (createReceipt) {
      const { createId, payloadHash } = createReceipt
      if (!validateMessageId(createId) || typeof payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(payloadHash)) {
        throw new Error('初回作成の受領キーが不正です')
      }
      if (this.createReceipts.has(createId)) throw new Error('初回作成の受領キーはすでに使われています')
    }
    const now = Date.now()
    const thread = {
      id: randomUUID(),
      title: '新しいタスク',
      workspace: path.resolve(workspace),
      model: model ?? null,
      effort: effort ?? '',
      permissionMode,
      toolMode,
      sessionId: null,
      createdAt: now,
      updatedAt: now,
      archived: false,
      usage: null,
      score: emptyScore(),
      status: 'idle',
      pendingApproval: false,
      ...(team ? { team } : {}),
      ...(ab ? { ab } : {}),
    }
    this.threads.set(thread.id, thread)
    this.turns.set(thread.id, [])
    this.receipts.set(thread.id, new Map())
    if (createReceipt) this.createReceipts.set(createReceipt.createId, { ...createReceipt, threadId: thread.id, deleted: false })
    this.#saveIndex()
    if (createReceipt) {
      try {
        // The durable key-to-thread mapping must exist before the first send.
        await this.indexWriter.flush()
      } catch (error) {
        this.threads.delete(thread.id)
        this.turns.delete(thread.id)
        this.receipts.delete(thread.id)
        this.createReceipts.delete(createReceipt.createId)
        this.#saveIndex()
        try {
          await this.indexWriter.flush()
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `${error.message}（初回作成記録の復元にも失敗しました: ${rollbackError.message}）`)
        }
        throw error
      }
    }
    this.#emitThread(thread)
    return this.summary(thread)
  }

  update(threadId, patch) {
    return this.#request(threadId, () => this.#update(threadId, patch))
  }

  async #update(threadId, patch) {
    const thread = this.#available(threadId)
    const running = this.active.has(threadId)
    if (patch.toolMode !== undefined) {
      assertToolMode(patch.toolMode)
      if ((thread.ab || thread.team) && patch.toolMode !== this.summary(thread).toolMode) throw new Error('PTCはAB・チームの設定から変更してください')
      if (running && patch.toolMode !== thread.toolMode) throw new Error('実行中はPTCを変更できません')
      // Persist the choice now; apply and verify it immediately before the next prompt.
    }
    if (thread.ab && (patch.permissionMode !== undefined || patch.model !== undefined)) throw new Error('ABの担当モデルと権限は変更できません')
    if (patch.toolMode !== undefined) thread.toolMode = patch.toolMode
    if (typeof patch.title === 'string' && patch.title.trim()) thread.title = patch.title.trim().slice(0, 120)
    if (typeof patch.archived === 'boolean') thread.archived = patch.archived
    if (typeof patch.pinned === 'boolean') thread.pinned = patch.pinned
    if (patch.permissionMode !== undefined && patch.permissionMode !== thread.permissionMode) {
      if (thread.team?.executionMode === 'research') throw new Error('EXの調査専用タスクは読み取り専用です')
      if (!PERMISSION_MODES.includes(patch.permissionMode)) throw new Error('不明な権限モードです')
      if (running) throw new Error('実行中は権限モードを変更できません')
      thread.permissionMode = patch.permissionMode
      // dsh records the sandbox mode in the session itself, and a resumed
      // session keeps it. A new mode therefore needs a new session in that
      // mode's runtime; the conversation is carried over as a summary.
      if (thread.sessionId) {
        const holder = this.pool.holderOf(thread.sessionId)
        if (holder) await holder.closeSession(thread.sessionId).catch(() => {})
        this.#available(threadId, thread)
        this.liveOptions.delete(thread.sessionId)
        this.sessionIndex.delete(thread.sessionId)
        thread.sessionId = null
        thread.carryover = 'permission'
      }
    }
    if (patch.model !== undefined && patch.model !== thread.model) {
      thread.model = patch.model
      await this.#applyLive(thread, 'model', patch.model)
      this.#available(threadId, thread)
    }
    if (patch.effort !== undefined && patch.effort !== thread.effort) {
      thread.effort = patch.effort
      await this.#applyLive(thread, 'reasoning_effort', patch.effort)
      this.#available(threadId, thread)
    }
    this.#saveIndex()
    this.#emitThread(thread)
    return this.summary(thread)
  }

  /** Scheduling control, not a model-visible goal phase mutation. */
  async setGoalWaiting(threadId, waiting) {
    const thread = this.#available(threadId)
    if (!thread.sessionId) return // Recomputed before its first/recreated prompt.
    const runtime = this.pool.holderOf(thread.sessionId)
    if (!runtime) return
    await runtime.setGoalWaiting(thread.sessionId, waiting)
  }

  /** Team-manager only: move accepted research to its writer runtime without summarizing history. */
  implementResearch(threadId) {
    return this.#request(threadId, async () => {
      const thread = this.#available(threadId)
      if (thread.team?.childId && thread.team.executionMode === 'write' && thread.permissionMode === 'danger-full-access') return this.summary(thread)
      if (!thread.team?.childId || thread.team.executionMode !== 'research' || thread.permissionMode !== 'read-only') throw new Error('ecoの調査専用タスクだけ実装へ切り替えられます')
      if (this.active.has(threadId) || thread.pendingApproval) throw new Error('調査が終わってから実装へ切り替えてください')
      if (!thread.sessionId) throw new Error('調査のセッションがありません。別の実装の子を起動してください')
      const runtime = await this.pool.get('team:danger-full-access')
      this.#available(threadId, thread)
      const holder = this.pool.holderOf(thread.sessionId)
      if (holder) await holder.closeSession(thread.sessionId)
      this.#available(threadId, thread)
      this.liveOptions.delete(thread.sessionId)
      const previousTeam = thread.team
      let resumed = false
      try {
        // No newSession fallback here: a missing log must not silently lose the investigation.
        const result = await runtime.resumeSession(thread.sessionId, thread.workspace, this.getMcpServers(thread))
        resumed = true
        this.#available(threadId, thread)
        thread.team = { ...thread.team, executionMode: 'write' }
        thread.permissionMode = 'danger-full-access'
        this.#learnOptions(thread, result?.configOptions)
        this.#saveIndex()
        await this.indexWriter.flush()
      } catch (error) {
        thread.team = previousTeam
        thread.permissionMode = 'read-only'
        this.liveOptions.delete(thread.sessionId)
        if (resumed) await runtime.closeSession(thread.sessionId).catch(() => {})
        this.#saveIndex()
        throw error
      }
      this.#emitThread(thread)
      return this.summary(thread)
    })
  }

  /** Applies an option to a live, idle session right away; otherwise on the next prompt. */
  async #applyLive(thread, configId, value) {
    if (!thread.sessionId || this.active.has(thread.id)) return
    const holder = this.pool.holderOf(thread.sessionId)
    if (!holder) return
    let options
    try {
      options = await holder.setOption(thread.sessionId, configId, value)
    } catch {
      // Applied again, with error reporting, when the next prompt starts.
      return
    }
    this.#available(thread.id, thread)
    this.#learnOptions(thread, options)
  }

  remove(threadId, { forgetCreateReceipt = false } = {}) {
    if (this.removing.has(threadId)) return this.removing.get(threadId)
    const thread = this.#require(threadId)
    // Install the fence synchronously, before any admission can resume.
    const removal = Promise.resolve().then(() => this.#remove(thread, { forgetCreateReceipt }))
    this.removing.set(threadId, removal)
    void removal.finally(() => this.removing.delete(threadId)).catch(() => {})
    return removal
  }

  async #remove(thread, { forgetCreateReceipt = false } = {}) {
    const threadId = thread.id
    const active = this.active.get(threadId)
    await this.cancel(threadId)
    await this.requests.get(threadId)?.catch(() => {})
    await active?.done
    await this.turnLoads.get(threadId)?.catch(() => {})
    const holder = thread.sessionId ? this.pool.holderOf(thread.sessionId) : null
    if (holder) await holder.closeSession(thread.sessionId).catch(() => {})
    // Drain all writes before unlinking, but do not require a successful save
    // of a transcript being discarded. flush() can retain an earlier failure
    // even after the transient filesystem problem has gone away.
    await this.turnWriters.get(threadId)?.flush().catch(() => {})
    // Stage the durable index without hiding the task from list()/hello yet.
    // A failed commit must never look like a deletion followed by resurrection.
    const createReceipts = [...this.createReceipts.values()].filter((entry) => entry.threadId === threadId)
    for (const entry of createReceipts) {
      if (forgetCreateReceipt) this.createReceipts.delete(entry.createId)
      else this.createReceipts.set(entry.createId, { ...entry, deleted: true })
    }
    this.indexRemovals.add(threadId)
    try {
      this.#saveIndex()
      await this.indexWriter.flush()
    } catch (error) {
      this.indexRemovals.delete(threadId)
      for (const entry of createReceipts) this.createReceipts.set(entry.createId, entry)
      this.#saveIndex()
      try {
        await this.indexWriter.flush()
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `${error.message}（タスク一覧の復元にも失敗しました: ${rollbackError.message}）`)
      }
      throw error
    }
    this.threads.delete(threadId)
    this.indexRemovals.delete(threadId)
    // The index is the source of truth. Windows may temporarily lock a
    // transcript; cleanup failure must not undo an already committed deletion.
    await fs.rm(this.#turnFile(threadId), { force: true }).catch((error) => {
      console.warn(`[agent-desk] deleted task ${threadId}; transcript cleanup failed:`, error.message)
    })
    if (thread.sessionId) {
      this.sessionIndex.delete(thread.sessionId)
      this.liveOptions.delete(thread.sessionId)
    }
    for (const [key, timer] of this.emitTimers) {
      if (key.startsWith(`${threadId}:`)) {
        clearTimeout(timer)
        this.emitTimers.delete(key)
      }
    }
    this.turns.delete(threadId)
    this.pendingUsageRefresh.delete(threadId)
    this.receipts.delete(threadId)
    this.turnWriters.delete(threadId)
    // Garbage collection can queue behind another task's snapshots and take
    // minutes. Notify the UI once deletion commits, not after optional cleanup.
    this.emit('removed', { threadId })
    // Optional GC must not hold the removal RPC (or the next bulk removal)
    // behind a long snapshot/git-gc queue after deletion has already committed.
    if (this.checkpoints) void this.checkpoints.forget(thread.workspace, threadId).catch(() => {})
  }

  /**
   * Starts a turn. Resolves once the turn is durably recorded; the agent keeps
   * working in the background and reports through `turn` events. An optional
   * UUID messageId deduplicates across send/steer and application restarts.
   */
  async send(threadId, input, { userInitiated = false, guard } = {}) {
    const message = normalizeMessage(input)
    return this.#request(threadId, () => this.#send(threadId, message, userInitiated, guard))
  }

  async #send(threadId, message, userInitiated, guard) {
    const { text, images, messageId, plan } = message
    const thread = this.#available(threadId)
    if (plan && thread.ab) throw new Error('ABではPlanを使えません')
    const turns = await this.#loadTurns(threadId)
    this.#available(threadId, thread)
    const known = this.#receipt(threadId, message)
    if (known) return known
    this.#assertNotRestoring(thread)
    if (this.active.has(threadId)) throw new Error('このタスクはまだ作業中です')
    if (!thread.model) throw new Error('モデルを選択してください')
    await this.#assertModelUsable(thread.model)
    this.#available(threadId, thread)
    this.#assertNotRestoring(thread)
    if (this.active.has(threadId)) throw new Error('このタスクはまだ作業中です')
    this.executionGuard?.(thread)
    guard?.()

    const turn = newTurn({ id: randomUUID(), text, images })
    if (messageId) turn.user.messageId = messageId
    if (plan) turn.user.plan = true
    const previous = { title: thread.title, updatedAt: thread.updatedAt, status: thread.status }
    turns.push(turn)
    if (turns.length === 1) thread.title = titleFrom(text || (images.every((image) => isImageFile(image.file)) ? '画像' : images[0].name || '添付ファイル'))
    thread.updatedAt = Date.now()
    thread.status = 'running'
    let resolveDone
    const active = {
      turn, runtime: null, cancelled: false, phase: 'starting', steers: new Set(),
      done: new Promise((resolve) => { resolveDone = resolve }),
    }
    this.active.set(threadId, active)
    if (messageId) this.receipts.get(threadId).set(messageId, {
      messageId, payload: { text, images, ...(plan ? { plan: true } : {}) }, status: 'accepted', kind: 'send', turnId: turn.id,
    })
    try {
      // The index must name the thread before a receipt can be acknowledged.
      // No model/session operation starts until both durable writes succeed.
      this.#saveIndex()
      await this.indexWriter.flush()
      await this.#persistTurns(threadId)
    } catch (error) {
      turns.splice(turns.indexOf(turn), 1)
      if (messageId) this.receipts.get(threadId).delete(messageId)
      Object.assign(thread, previous)
      this.active.delete(threadId)
      this.#saveIndex()
      this.#saveTurns(threadId)
      resolveDone()
      throw error
    }
    if (userInitiated) this.userMessageAccepted?.(threadId)
    this.#emitThread(thread)
    this.#emitTurn(threadId, turn, true)
    void this.#run(thread, active).finally(resolveDone).catch((error) => {
      console.error('[agent-desk] turn finalization failed:', error)
    })
    return { status: 'accepted', turnId: turn.id, kind: 'send' }
  }

  async #assertModelUsable(model) {
    let provider = null
    try {
      provider = JSON.parse(model)[0]
    } catch {}
    const accounts = await this.getAccounts()
    if (provider === 'openai-codex' && !accounts.chatgpt.signedIn) {
      throw new Error('ChatGPT のモデルを使うには、設定から ChatGPT にサインインしてください。')
    }
    if (provider === 'anthropic' && !accounts.claude.configured) {
      throw new Error('Claude のモデルを使うには、設定で Anthropic の API キーを登録してください。')
    }
    if (provider === 'deepseek-official' && !accounts.deepseek.configured) {
      throw new Error('DeepSeek のモデルを使うには、設定で DeepSeek の API キーを登録してください。')
    }
    if (provider === 'opencode-go' && !accounts.opencodeGo?.configured) {
      throw new Error('OpenCode Go のモデルを使うには、設定で OpenCode Go の API キーを登録してください。')
    }
    if (provider === 'local-llm' && !accounts.localLlm?.configured) {
      throw new Error('ローカル LLM を使うには、設定 → アカウントでサーバーの URL を登録してください。')
    }
  }

  async #run(thread, active) {
    const { turn } = active
    let outcome
    // The snapshot is taken while the session starts, and must finish before the agent acts.
    const snapshot = active.cancelled || this.stopping || this.removing.has(thread.id)
      ? Promise.resolve() : this.#capture(thread, turn, 'before')
    try {
      this.#checkRun(thread, active)
      const runtime = await this.#ensureSession(thread, active)
      this.#checkRun(thread, active)
      await snapshot
      this.#checkRun(thread, active)
      const prompt = await this.#promptBlocks(turn)
      this.#checkRun(thread, active)
      const { carryover, restoreNote } = thread
      if (carryover) {
        const turns = this.turns.get(thread.id) ?? []
        const summary = carryoverText(turns.filter((entry) => entry !== turn))
        if (summary) prompt.unshift({ type: 'text', text: summary })
      }
      if (restoreNote) prompt.unshift({ type: 'text', text: restoreNoteText(restoreNote) })
      active.phase = 'prompting'
      const result = await runtime.prompt(thread.sessionId, prompt)
      // Only a prompt the runtime took counts as telling the agent; a failed one keeps both for the next turn.
      if (carryover) delete thread.carryover
      if (restoreNote) delete thread.restoreNote
      if (carryover || restoreNote) this.#saveIndex()
      const stopReason = result?.stopReason ?? 'end_turn'
      outcome = stopReason === 'cancelled' || active.cancelled
        ? { status: 'cancelled', stopReason: 'cancelled' }
        : { status: 'done', stopReason }
    } catch (error) {
      outcome = active.cancelled
        ? { status: 'cancelled', stopReason: 'cancelled' }
        : { status: 'error', error: describeError(error, thread, active.runtime) }
    }
    active.phase = 'finishing'
    // Only the stream-side bridge can supply an active-interval average. If it
    // disappeared on failure, don't relabel a stale rolling rate as an average.
    if (turn.outputSpeed?.state !== 'done') delete turn.outputSpeed
    await snapshot
    // A steer may have reached the runtime just before prompt settled. Include
    // its receipt and all after-work in done, before admitting the next turn.
    await Promise.allSettled([...active.steers])
    this.#resolvePermissions(thread.id, null)
    await Promise.allSettled([this.#attachUsage(thread.id, turn, thread.sessionId), this.#finishCheckpoint(thread, turn)])
    settleTurn(turn, outcome)
    thread.score = scoresUpTo(this.turns.get(thread.id) ?? []).at(-1) ?? emptyScore()
    thread.status = outcome.status === 'error' ? 'error' : 'idle'
    thread.pendingApproval = false
    thread.updatedAt = Date.now()
    this.#saveIndex()
    this.#saveTurns(thread.id)
    this.active.delete(thread.id)
    if (this.pendingUsageRefresh.delete(thread.id)) void this.#refreshLoadedUsage(thread.id).catch(() => {})
    this.#emitTurn(thread.id, turn, true)
    this.#emitThread(thread)
    this.emit('turn-finished', { threadId: thread.id, title: thread.title, status: outcome.status })
  }

  #checkRun(thread, active) {
    if (active.cancelled || this.stopping || this.removing.has(thread.id)
      || this.threads.get(thread.id) !== thread || this.active.get(thread.id) !== active) {
      active.cancelled = true
      throw new Error('リクエストはキャンセルされました')
    }
  }

  // ---------------------------------------------------------------- checkpoints

  /** Snapshots the workspace into `turn.checkpoint[which]`; a failure only adds a warning. */
  async #capture(thread, turn, which) {
    try {
      // A team's children never undo turns; their snapshots would only slow them down.
      if (!this.checkpoints || !this.checkpointsEnabled() || thread.team) return null
      const { commit } = await this.checkpoints.snapshot(thread.workspace, `${thread.id}/${turn.id}/${which}`)
      turn.checkpoint = { ...turn.checkpoint, [which]: commit }
      return commit
    } catch (error) {
      const reason = shortMessage(error)
      turn.checkpoint = { ...turn.checkpoint, error: reason }
      // Warned once per task (and again if the reason changes), not on every turn.
      if (which === 'before' && thread.checkpointWarning !== reason) {
        thread.checkpointWarning = reason
        this.#saveIndex()
        turn.items.unshift({
          type: 'notice',
          id: `notice-checkpoint-${Date.now()}`,
          level: 'warning',
          text: `このタスクでは、ファイルの変更を戻せない場合があります（${reason}）`,
        })
        this.#saveTurns(thread.id)
        this.#emitTurn(thread.id, turn, true)
      }
      return null
    }
  }

  /** Snapshots the result of a turn and counts the files it changed. */
  async #finishCheckpoint(thread, turn) {
    if (!turn.checkpoint?.before) return
    const after = await this.#capture(thread, turn, 'after')
    if (!after || !this.threads.has(thread.id)) return
    try {
      turn.checkpoint.changed = (await this.checkpoints.changes(thread.workspace, turn.checkpoint.before, after)).length
    } catch {
      return
    }
    if (thread.checkpointWarning) {
      delete thread.checkpointWarning
      this.#saveIndex()
    }
    this.#saveTurns(thread.id)
    this.#emitTurn(thread.id, turn, true)
    await this.checkpoints.tidy(thread.workspace).catch(() => {})
  }

  async #checkpointTurn(threadId, turnId) {
    const thread = this.#available(threadId)
    if (!this.checkpoints) throw new Error('変更を戻す機能は使えません')
    const turns = await this.#loadTurns(threadId)
    this.#available(threadId, thread)
    const turn = turns.find((entry) => entry.id === turnId)
    if (!turn?.checkpoint?.before) throw new Error('このリクエストの前の状態は保存されていません')
    return { thread, turns, turn }
  }

  #assertNotRestoring(thread) {
    if ([...this.restoring].some((other) => workspacesOverlap(other.workspace, thread.workspace))) {
      throw new Error('同じフォルダのファイルを復元中です。完了を待ってください。')
    }
  }

  #assertWorkspaceIdle(thread) {
    this.#assertNotRestoring(thread)
    for (const other of this.threads.values()) {
      if (this.active.has(other.id) && workspacesOverlap(other.workspace, thread.workspace)) {
        throw new Error(other.id === thread.id
          ? '作業中は戻せません。停止するか、完了を待ってください。'
          : `同じフォルダで作業中のタスク（${other.title}）があります。完了を待ってから戻してください。`)
      }
    }
  }

  /** What restoring the files to before a turn would change now. */
  checkpointPreview(threadId, turnId) {
    return this.#request(threadId, async () => {
      const { thread, turns, turn } = await this.#checkpointTurn(threadId, turnId)
      this.#available(threadId, thread)
      const files = await this.checkpoints.preview(thread.workspace, turn.checkpoint.before)
      this.#available(threadId, thread)
      return { files, later: turns.length - turns.indexOf(turn) - 1 }
    })
  }

  #restoreRequest(threadId, action) {
    return this.#request(threadId, async () => {
      const thread = this.#available(threadId)
      this.#assertWorkspaceIdle(thread)
      // Acquire before even loading the transcript. A sibling thread's send
      // must not slip in while this operation waits for disk or checkpoints.
      this.restoring.add(thread)
      try {
        return await action()
      } finally {
        this.restoring.delete(thread)
      }
    })
  }

  /** Puts the workspace files back to how they were before a turn. */
  restoreCheckpoint(threadId, turnId) {
    return this.#restoreRequest(threadId, () => this.#restoreCheckpoint(threadId, turnId))
  }

  async #restoreCheckpoint(threadId, turnId) {
    const { thread, turns, turn } = await this.#checkpointTurn(threadId, turnId)
    this.#available(threadId, thread)
    this.executionGuard?.(thread)
    const result = await this.checkpoints.restore(thread.workspace, turn.checkpoint.before, `${thread.id}/${turn.id}/undo`)
    const files = result.restored.length + result.removed.length
    // `turns`: how many turns there were, so a message sent afterwards ends the chance to undo.
    turn.restore = { at: Date.now(), undo: result.undo, files, turns: turns.length }
    for (const later of turns.slice(turns.indexOf(turn))) later.revertedBy ??= turn.id
    // The agent remembers its edits; the next message tells it they are gone.
    // An unsent earlier note is kept underneath, so undoing this restore brings it back.
    if (files) {
      const previous = thread.restoreNote
      thread.restoreNote = { turnId: turn.id, request: turn.user.text ?? '', first: turns[0] === turn, ...(previous && { previous }) }
    }
    thread.updatedAt = Date.now()
    this.#saveIndex()
    this.#saveTurns(threadId)
    // Once the files changed, finish recording the restore even during close.
    // remove/shutdown wait for this request, but no closing UI needs an event.
    if (!this.stopping && !this.removing.has(threadId)) {
      for (const entry of turns) this.#emitTurn(threadId, entry, true)
      this.#emitThread(thread)
    }
    return { files, error: result.error }
  }

  /** Undoes the latest restore, as long as no message was sent after it. */
  undoRestore(threadId, turnId) {
    return this.#restoreRequest(threadId, () => this.#undoRestore(threadId, turnId))
  }

  async #undoRestore(threadId, turnId) {
    const { thread, turns, turn } = await this.#checkpointTurn(threadId, turnId)
    this.#available(threadId, thread)
    if (!turn.restore) throw new Error('このリクエストの前には戻していません')
    if (!isUndoable(turns, turn)) {
      throw new Error('このあとに新しいメッセージを送ったか、別の時点に戻したため、取り消せません')
    }
    this.executionGuard?.(thread)
    const result = await this.checkpoints.restore(thread.workspace, turn.restore.undo)
    // A partial undo keeps its record, so it can be tried again.
    if (result.error) return { files: result.restored.length + result.removed.length, error: result.error }
    delete turn.restore
    for (const entry of turns) if (entry.revertedBy === turn.id) delete entry.revertedBy
    if (thread.restoreNote?.turnId === turn.id) {
      const { previous } = thread.restoreNote
      if (previous) thread.restoreNote = previous
      else delete thread.restoreNote
    }
    this.#saveIndex()
    this.#saveTurns(threadId)
    // Once the files changed, finish recording the restore even during close.
    // remove/shutdown wait for this request, but no closing UI needs an event.
    if (!this.stopping && !this.removing.has(threadId)) {
      for (const entry of turns) this.#emitTurn(threadId, entry, true)
      this.#emitThread(thread)
    }
    return { files: result.restored.length + result.removed.length, error: result.error }
  }

  /** Adds the tokens (and, for per-token billing, the estimated cost) the turn consumed. */
  async #attachUsage(threadId, turn, sessionId) {
    try {
      const usage = await this.getTurnUsage({ dshHome: this.paths.dshHome, sessionId, since: turn.startedAt, until: turn.endedAt ?? Infinity })
      if (!usage || !this.threads.has(threadId)) return
      turn.usage = usage
      this.#saveTurns(threadId)
      this.#emitTurn(threadId, turn, true)
    } catch {}
  }

  async #ensureSession(thread, active) {
    const { turn } = active
    const runtime = await this.pool.get(runtimeKey(thread))
    this.#checkRun(thread, active)
    // Old strict Plan sessions may still carry a read-only override. Restore them
    // once in the ordinary runtime, preserving history and failing closed on errors.
    const legacyPlan = thread.sessionPlan !== undefined
    active.runtime = runtime
    const holder = thread.sessionId ? this.pool.holderOf(thread.sessionId) : null
    if (holder && (holder !== runtime || legacyPlan)) {
      this.liveOptions.delete(thread.sessionId)
      if (legacyPlan) await holder.closeSession(thread.sessionId)
      else await holder.closeSession(thread.sessionId).catch(() => {})
      this.#checkRun(thread, active)
    }
    let options = null
    if (thread.sessionId && runtime.liveSessions.has(thread.sessionId)) {
      options = this.liveOptions.get(thread.sessionId) ?? null
    } else if (thread.sessionId) {
      try {
        const resumed = await runtime.resumeSession(thread.sessionId, thread.workspace, this.getMcpServers(thread))
        this.#checkRun(thread, active)
        options = resumed?.configOptions ?? null
      } catch (error) {
        this.#checkRun(thread, active)
        if (legacyPlan) throw error
        turn.items.push({
          type: 'notice',
          id: `notice-${Date.now()}`,
          level: 'warning',
          text: `以前のセッションを再開できなかったため、新しいセッションで続けます。これまでのやり取りは要約して引き継ぎます（${shortMessage(error)}）。`,
        })
        this.sessionIndex.delete(thread.sessionId)
        thread.sessionId = null
        thread.carryover = 'resume-failed'
      }
    }
    if (!thread.sessionId) {
      const created = await runtime.newSession(thread.workspace, this.getMcpServers(thread))
      try {
        this.#checkRun(thread, active)
      } catch (error) {
        await runtime.closeSession(created.sessionId).catch(() => {})
        throw error
      }
      thread.sessionId = created.sessionId
      options = created.configOptions ?? null
      if (thread.carryover === 'permission') {
        turn.items.push({
          type: 'notice',
          id: `notice-${Date.now()}`,
          level: 'info',
          text: '権限モードの変更により、新しいセッションで続けます。これまでのやり取りは要約して引き継ぎます。',
        })
      }
      this.#saveIndex()
    }
    this.sessionIndex.set(thread.sessionId, thread.id)
    if (options) this.#learnOptions(thread, options)
    if (legacyPlan) {
      try {
        assertSessionPolicy(this.liveOptions.get(thread.sessionId), thread.permissionMode)
      } catch (error) {
        this.liveOptions.delete(thread.sessionId)
        await runtime.closeSession(thread.sessionId).catch(() => {})
        throw error
      }
      delete thread.sessionPlan
      this.#saveIndex()
      await this.indexWriter.flush()
      this.#checkRun(thread, active)
    }

    const waiting = this.teamGoalWaiting?.(thread)
    if (waiting !== undefined) {
      await runtime.setGoalWaiting(thread.sessionId, waiting)
      this.#checkRun(thread, active)
    }
    const toolMode = this.summary(thread).toolMode
    assertToolMode(toolMode)
    const modeOption = toolModeOption(this.liveOptions.get(thread.sessionId))
    // Older/unpatched runtimes remain usable in native mode only. Never send
    // a PTC request without an explicit acknowledgement of the selection.
    if (toolMode === 'ptc' || modeOption) {
      if (modeOption?.currentValue !== toolMode) {
        const changed = await runtime.setOption(thread.sessionId, TOOL_MODE_CONFIG, toolMode)
        this.#checkRun(thread, active)
        this.#learnOptions(thread, changed)
      }
      assertToolModeApplied(this.liveOptions.get(thread.sessionId), toolMode)
    }

    // Model first: the effort choices depend on the model.
    let parsed = parseConfigOptions(this.liveOptions.get(thread.sessionId) ?? [])
    if (thread.model && parsed.currentModel !== thread.model) {
      const changed = await runtime.setOption(thread.sessionId, 'model', thread.model)
      this.#checkRun(thread, active)
      this.#learnOptions(thread, changed)
      parsed = parseConfigOptions(this.liveOptions.get(thread.sessionId) ?? [])
    }
    const wanted = thread.effort ?? ''
    const strict = (thread.ab && (wanted || thread.ab.strictEffort)) || thread.team?.strictEffort
    const label = thread.ab ? 'AB' : 'eco'
    if (strict) assertWorkflowEffort(wanted, parsed, label)
    const target = strict ? wanted : nearestEffort(wanted, parsed.efforts)
    if (target !== wanted) {
      thread.effort = target
      this.#saveIndex()
      this.#emitThread(thread)
    }
    if (parsed.efforts.length && parsed.currentEffort !== target) {
      const changed = await runtime.setOption(thread.sessionId, 'reasoning_effort', target)
      this.#checkRun(thread, active)
      this.#learnOptions(thread, changed)
      if (strict) assertWorkflowApplied(wanted, parseConfigOptions(this.liveOptions.get(thread.sessionId) ?? []), label)
    }
    return runtime
  }

  #learnOptions(thread, options) {
    if (!Array.isArray(options) || !thread.sessionId) return
    this.liveOptions.set(thread.sessionId, options)
    if (this.catalog.learn(options)) this.emit('catalog', this.catalog.snapshot())
  }

  /**
   * Adds a message to the running turn: the agent reads it at its next step
   * instead of after the turn ends. The turn shows it where it arrived.
   * @returns `steered: false` when the turn cannot take it (it is ending, or
   *   this dsh has no steering), so the caller can send it after the turn.
   *   `status: uncertain` must NOT be automatically retried or sent instead.
   */
  async steer(threadId, input, { userInitiated = false, guard } = {}) {
    const message = normalizeMessage(input)
    return this.#request(threadId, async () => {
      const thread = this.#available(threadId)
      await this.#loadTurns(threadId)
      this.#available(threadId, thread)
      const known = this.#receipt(threadId, message)
      if (known) return known.status === 'accepted' ? { ...known, steered: true } : known
      const active = this.active.get(threadId)
      if (!this.#canSteer(thread, active)) return { steered: false }
      const delivery = this.#deliverSteer(thread, active, message, userInitiated, guard)
      active.steers.add(delivery)
      try {
        return await delivery
      } finally {
        active.steers.delete(delivery)
      }
    })
  }

  #canSteer(thread, active) {
    return active && this.active.get(thread.id) === active && this.threads.get(thread.id) === thread
      && active.phase === 'prompting' && !active.cancelled && !this.stopping
      && !this.removing.has(thread.id) && active.runtime && thread.sessionId
  }

  async #deliverSteer(thread, active, { text, images, messageId, plan }, userInitiated, guard) {
    const threadId = thread.id
    const blocks = await this.#promptBlocks({ user: { text, images, plan } })
    if (!this.#canSteer(thread, active)) return { steered: false }
    const receipts = this.receipts.get(threadId)
    const receipt = { messageId, payload: { text, images, ...(plan ? { plan: true } : {}) }, status: 'pending', kind: 'steer', turnId: active.turn.id }
    if (messageId) {
      receipts.set(messageId, receipt)
      try {
        // A crash after runtime acceptance but before the final write leaves
        // pending on disk. Neither send nor steer may automatically replay it.
        await this.#persistTurns(threadId)
      } catch (error) {
        receipts.delete(messageId)
        this.#saveTurns(threadId)
        throw error
      }
    }
    let steered = false
    try {
      if (this.#canSteer(thread, active)) {
        guard?.()
        const waiting = userInitiated ? this.teamGoalWaiting?.(thread, { userInput: true }) : undefined
        steered = waiting === undefined ? await active.runtime.steer(thread.sessionId, blocks)
          : await active.runtime.steer(thread.sessionId, blocks, waiting)
      }
    } catch (error) {
      if (!/steer-unavailable|already in flight/.test(shortMessage(error))) {
        if (messageId) return { status: 'uncertain' }
        throw error
      }
    }
    if (!steered) {
      if (messageId) {
        receipts.delete(messageId)
        try {
          await this.#persistTurns(threadId)
        } catch {
          receipts.set(messageId, receipt)
          this.#saveTurns(threadId)
          return { status: 'uncertain' }
        }
      }
      return { steered: false }
    }
    if (userInitiated) this.userMessageAccepted?.(threadId)
    const turn = active.turn
    const item = { type: 'steer', id: `steer-${randomUUID()}`, text, images, at: Date.now(), ...(plan ? { plan: true } : {}) }
    if (messageId) item.messageId = messageId
    turn.items.push(item)
    receipt.status = 'accepted'
    try {
      await this.#persistTurns(threadId)
    } catch {
      // The runtime already took the steer, so it reached the agent; only its record is uncertain.
      receipt.status = 'pending'
      item.delivery = 'uncertain'
      this.#saveTurns(threadId)
      return { status: 'uncertain', steered: true }
    }
    this.#emitTurn(threadId, turn, true)
    return { status: 'accepted', turnId: turn.id, kind: 'steer', steered: true }
  }

  async #promptBlocks(turn) {
    const blocks = []
    const attached = turn.user.images ?? []
    const files = fileListText(this.paths.attachmentsDir, attached.filter((entry) => !isImageFile(entry.file)))
    const text = [turn.user.text, files, turn.user.plan ? PLAN_INSTRUCTION : ''].filter(Boolean).join('\n\n')
    if (text) blocks.push({ type: 'text', text })
    for (const image of attached.filter((entry) => isImageFile(entry.file))) {
      const data = await fs.readFile(path.join(this.paths.attachmentsDir, image.file))
      blocks.push({ type: 'image', mimeType: image.mimeType, data: data.toString('base64') })
    }
    return blocks
  }

  async cancel(threadId) {
    const active = this.active.get(threadId)
    if (!active) {
      const thread = this.threads.get(threadId)
      if (thread?.sessionId && this.teamGoalWaiting?.(thread) !== undefined) {
        await this.pool.holderOf(thread.sessionId)?.cancel(thread.sessionId, true)
      }
      return
    }
    active.cancelled = true
    if (active.turn.outputSpeed?.state === 'streaming') {
      active.turn.outputSpeed = { ...active.turn.outputSpeed, state: 'paused' }
      if (!this.stopping && !this.removing.has(threadId)) this.#publishSpeed(threadId, active.turn)
    }
    this.#resolvePermissions(threadId, null)
    const thread = this.threads.get(threadId)
    const controlled = thread && this.teamGoalWaiting?.(thread) !== undefined
    const runtime = active.runtime ?? (controlled && thread.sessionId ? this.pool.holderOf(thread.sessionId) : null)
    if (runtime && thread?.sessionId && (controlled || active.phase === 'prompting')) {
      active.cancelTask ??= (controlled ? runtime.cancel(thread.sessionId, true) : runtime.cancel(thread.sessionId)).catch(() => {})
      await active.cancelTask
    }
  }

  // ---------------------------------------------------------------- runtime callbacks

  onUpdate(sessionId, update) {
    const threadId = this.sessionIndex.get(sessionId)
    const thread = threadId && this.threads.get(threadId)
    if (!thread || this.removing.has(threadId) || this.stopping) return
    const active = this.active.get(threadId)
    if (active?.phase === 'starting') return
    const turn = active?.turn ?? this.turns.get(threadId)?.at(-1)
    if (!turn) return
    if (Object.hasOwn(update._meta ?? {}, OUTPUT_SPEED_META)) {
      // Standard ACP chunks are committed whole messages. Only the extension
      // produced at the real stream boundary is authoritative for live speed.
      if (!active || active.phase !== 'prompting') return
      const speed = update._meta[OUTPUT_SPEED_META]
      if (speed === null) delete turn.outputSpeed
      else {
        if (!Number.isFinite(speed?.tokensPerSecond) || speed.tokensPerSecond <= 0
          || speed.estimated !== true || !['streaming', 'paused', 'done'].includes(speed.state)) return
        if (active.cancelled && speed.state === 'streaming') return
        turn.outputSpeed = { tokensPerSecond: speed.tokensPerSecond, state: speed.state, estimated: true }
      }
      this.#publishSpeed(threadId, turn)
      return // Empty carrier updates must never create transcript items.
    }
    const side = applyUpdate(turn, update)
    if (side.usage) {
      thread.usage = side.usage
      this.#emitThread(thread)
    }
    if (side.configOptions) this.#learnOptions(thread, side.configOptions)
    this.#saveTurns(threadId)
    this.#emitTurn(threadId, turn)
  }

  onPermission(params) {
    const threadId = this.sessionIndex.get(params.sessionId)
    const thread = threadId && this.threads.get(threadId)
    const active = threadId && this.active.get(threadId)
    if (!thread || !active || active.cancelled) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }
    if (active.turn.outputSpeed?.state === 'streaming') {
      active.turn.outputSpeed = { ...active.turn.outputSpeed, state: 'paused' }
      this.#publishSpeed(threadId, active.turn)
    }
    const requestId = randomUUID()
    const turn = active.turn
    const toolCallId = params.toolCall?.toolCallId
    let item = turn.items.find((entry) => entry.type === 'tool' && entry.id === toolCallId)
    if (!item) {
      item = {
        type: 'tool',
        id: toolCallId ?? requestId,
        name: params.toolCall?.title ?? 'tool',
        kind: 'other',
        status: 'pending',
        output: '',
        input: params.toolCall?.rawInput,
      }
      turn.items.push(item)
    }
    item.permission = { requestId, options: params.options ?? [] }
    thread.pendingApproval = true
    // Event listeners (including the team's approval relay) inspect and may
    // answer the request synchronously, so register it before publishing it.
    const response = new Promise((resolve) => {
      this.permissions.set(requestId, { resolve, threadId, item, options: params.options ?? [] })
    })
    this.#emitThread(thread)
    this.#emitTurn(threadId, turn, true)
    this.emit('approval-needed', { threadId, title: thread.title, tool: item.name })
    return response
  }

  /** The approvals a task waits for now (a team relays them to its leader). */
  pendingPermissions(threadId) {
    return [...this.permissions].filter(([, entry]) => entry.threadId === threadId).map(([requestId, entry]) => ({
      requestId, name: entry.item.name, input: entry.item.input ?? null, options: entry.options,
    }))
  }

  respondPermission(requestId, optionId) {
    const entry = this.permissions.get(requestId)
    if (!entry) throw new Error('この承認リクエストはすでに終了しています')
    this.#settlePermission(requestId, entry, optionId)
    const thread = this.threads.get(entry.threadId)
    if (thread) {
      thread.pendingApproval = [...this.permissions.values()].some((other) => other.threadId === entry.threadId)
      this.#emitThread(thread)
    }
    const active = this.active.get(entry.threadId)
    if (active) {
      this.#saveTurns(entry.threadId)
      this.#emitTurn(entry.threadId, active.turn, true)
    }
  }

  #settlePermission(requestId, entry, optionId) {
    this.permissions.delete(requestId)
    const option = entry.options.find((candidate) => candidate.optionId === optionId)
    delete entry.item.permission
    entry.item.decision = option ? (option.kind.startsWith('allow') ? 'allowed' : 'rejected') : 'cancelled'
    entry.resolve(option ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
  }

  #resolvePermissions(threadId, optionId) {
    for (const [requestId, entry] of this.permissions) {
      if (entry.threadId === threadId) this.#settlePermission(requestId, entry, optionId)
    }
  }

  #onRuntimeExit({ key }) {
    for (const sessionId of [...this.liveOptions.keys()]) {
      const threadId = this.sessionIndex.get(sessionId)
      const thread = threadId && this.threads.get(threadId)
      if (!thread || runtimeKey(thread) === key) this.liveOptions.delete(sessionId)
    }
    this.emit('runtime', this.pool.status())
  }

  /** Learns the model catalog once, so the composer has models before the first thread. */
  async warmCatalog() {
    if (!this.catalog.stale) return
    const runtime = await this.pool.get('workspace-write')
    await fs.mkdir(this.paths.runtimeCwd, { recursive: true })
    const created = await runtime.newSession(this.paths.runtimeCwd)
    let changed = this.catalog.learn(created.configOptions ?? [])
    // The reasoning levels differ per model and are reported for the selected
    // one only, so select each model once to learn them all.
    for (const model of this.catalog.data.models) {
      try {
        changed = this.catalog.learn(await runtime.setOption(created.sessionId, 'model', model.value)) || changed
      } catch {}
    }
    if (changed) this.emit('catalog', this.catalog.snapshot())
    await runtime.closeSession(created.sessionId).catch(() => {})
  }

  get busy() {
    return this.active.size > 0 || this.restoring.size > 0
  }

  shutdown() {
    if (this.shutdownTask) return this.shutdownTask
    this.stopping = true
    this.shutdownTask = this.#shutdown()
    return this.shutdownTask
  }

  async #shutdown() {
    const active = [...this.active.values()]
    await Promise.all([...this.active.keys()].map((threadId) => this.cancel(threadId)))
    await Promise.allSettled([...this.requests.values(), ...this.removing.values(), ...this.turnLoads.values()])
    await Promise.all(active.map((entry) => entry.done))
    // One failing file must not keep the others from being written.
    const flushes = await Promise.allSettled([this.indexWriter.flush(), ...[...this.turnWriters.values()].map((writer) => writer.flush())])
    for (const timer of this.emitTimers.values()) clearTimeout(timer)
    this.emitTimers.clear()
    const failed = flushes.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}
