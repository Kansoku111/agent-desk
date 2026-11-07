// Codex owns execution and conversation state; Agent Desk keeps the view and task ownership.
import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJson, debouncedWriter } from './json-file.js'
import { abImages } from './ab-images.js'
import { applyCodexEvent } from './codex-events.js'
import { CodexOutputSpeedMeter } from './codex-output-speed.js'
import { loadPricing, scoreResponse } from './usage.js'
import { addScores, emptyScore } from '../shared/usage-score.js'

const MODES = ['read-only', 'workspace-write', 'danger-full-access']
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const clip = (text, limit = 120) => text.length > limit ? text.slice(0, limit) + '…' : text
const accountKey = account => account?.email ? createHash('sha256').update(JSON.stringify([account.email, account.workspaceName ?? null])).digest('hex') : null

export function codexSandbox(mode, workspace) {
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: true }
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  return { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
}

export class CodexRunner extends EventEmitter {
  constructor({ home, server, attachmentsDir, instructions = () => '', now = Date.now, speedNow, stopTimeoutMs = 10000 }) {
    super()
    this.home = path.resolve(home)
    this.dir = path.join(this.home, 'codex-tasks')
    this.indexFile = path.join(this.home, 'codex-tasks.json')
    this.server = server
    this.attachmentsDir = attachmentsDir
    this.instructions = instructions
    this.now = now
    this.speedNow = speedNow
    this.stopTimeoutMs = stopTimeoutMs
    this.records = new Map()
    this.writers = new Map()
    this.live = new Map()
    this.sessions = new Map()
    this.permissions = new Map()
    this.modelCache = []
    this.modelKeys = new WeakMap()
    this.indexWriter = debouncedWriter(this.indexFile)
    server.on('notification', (method, params) => this.#notification(method, params))
    server.on('request', request => this.#request(request))
    server.on('stopped', error => {
      this.invalidateModels()
      for (const [id, live] of this.live) void this.#finish(id, live, 'error', error?.message ?? 'Codex が停止しました')
    })
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true })
    const ids = await readJson(this.indexFile, [])
    if (!Array.isArray(ids)) throw new Error('Codex タスク一覧の形式が不正です')
    for (const id of ids) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Codex タスクIDが不正です')
      const record = await readJson(path.join(this.dir, id + '.json'), null)
      if (!record) continue
      if (record.id !== id || !Array.isArray(record.turns) || !MODES.includes(record.permissionMode)) throw new Error('Codex タスクの形式が不正です')
      // A persisted in-flight request is not proof that Codex accepted or finished it. Never replay it.
      for (const turn of record.turns) {
        if (turn.status !== 'running') continue
        turn.status = 'cancelled'
        delete turn.outputSpeed
        turn.endedAt = this.now()
        turn.error = { message: 'Agent Desk が終了したため、作業が中断されました。履歴を確認してから再開してください。' }
        turn.totalScore = addScores(record.score ?? emptyScore(), null)
        record.score = turn.totalScore
        record.status = 'stopped'
      }
      this.records.set(id, record)
      if (record.sessionId) this.sessions.set(record.sessionId, id)
      await this.#save(record, true)
    }
    return this
  }

  #record(id) {
    const record = this.records.get(id)
    if (!record) throw new Error('Codex タスクが見つかりません')
    return record
  }

  summary(record) {
    const { turns, instructions, mcpServers, tokenTotal, permissionPolicy, accountKey, ...summary } = record
    return { ...summary, state: this.live.has(record.id) ? 'running' : 'idle', pendingApproval: this.pendingPermissions(record.id).length > 0 }
  }

  get(id) { const record = this.records.get(id); return record ? this.summary(record) : null }
  turns(id) { return this.records.get(id)?.turns ?? null }
  list({ includeOwned = false } = {}) {
    return [...this.records.values()].filter(record => includeOwned || (!record.ab && !record.team?.childId && record.team?.role !== 'observer'))
      .map(record => this.summary(record)).sort((a, b) => b.updatedAt - a.updatedAt)
  }
  running(id) { return this.live.has(id) }
  get busy() { return this.live.size > 0 }

  #emit(record) { this.emit('session', this.summary(record)) }
  #index() { this.indexWriter.schedule([...this.records.keys()]) }
  async #save(record, flush = false) {
    let writer = this.writers.get(record.id)
    if (!writer) { writer = debouncedWriter(path.join(this.dir, record.id + '.json')); this.writers.set(record.id, writer) }
    writer.schedule(record)
    if (flush) await writer.flush()
  }

  async models({ refresh = false } = {}) {
    return this.server.use(async () => {
      const { account } = await this.server.rawRequest('account/read', { refreshToken: false })
      if (account?.type !== 'chatgpt') { this.invalidateModels(); return [] }
      const key = accountKey(account)
      if (key && this.modelCache.length && !refresh && this.modelAccountKey === key) return this.modelCache
      if (this.modelAccountKey !== key) this.modelCache = []
      const generation = this.modelGeneration ?? 0
      const models = []
      let cursor = null
      do {
        const page = await this.server.rawRequest('model/list', { includeHidden: false, cursor })
        for (const model of page.data ?? []) {
          const id = model.model ?? model.id
          if (typeof id !== 'string' || !id || model.hidden) continue
          models.push({ id, name: model.displayName ?? id, efforts: (model.supportedReasoningEfforts ?? []).map(option => option.reasoningEffort).filter(value => EFFORTS.includes(value)),
            defaultEffort: model.defaultReasoningEffort ?? 'medium', isDefault: model.isDefault === true })
        }
        cursor = page.nextCursor ?? null
      } while (cursor)
      if (generation !== (this.modelGeneration ?? 0)) throw new Error('Codex の接続状態が変わりました。再度モデルを取得してください。')
      this.modelAccountKey = key
      this.modelKeys.set(models, key)
      this.modelCache = models
      this.emit('models', models)
      return models
    })
  }

  invalidateModels() { this.modelGeneration = (this.modelGeneration ?? 0) + 1; this.modelCache = []; this.modelAccountKey = null; this.emit('models', []) }

  async #selection(model, effort) {
    const models = await this.models()
    if (!models.length) throw new Error('設定 → アカウントで Codex にサインインしてください。')
    const selected = model ? models.find(entry => entry.id === model) : models.find(entry => entry.isDefault) ?? models[0]
    if (!selected) throw new Error('選択した Codex モデルは利用できません。モデルを選び直してください。')
    const chosenEffort = effort || selected.defaultEffort
    if (chosenEffort && !selected.efforts.includes(chosenEffort)) throw new Error('この Codex モデルは指定した推論レベルに対応していません')
    return { model: selected.id, effort: chosenEffort, accountKey: this.modelKeys.get(models) ?? null }
  }

  async create({ workspace, model = null, effort = null, permissionMode = 'workspace-write', instructions = '', mcpServers = {}, permissionPolicy = 'ask', team = null, ab = null }) {
    if (this.closing) throw new Error('アプリを終了しています')
    if (typeof workspace !== 'string' || !workspace.trim() || !(await fs.stat(workspace)).isDirectory()) throw new Error('ワークスペースのフォルダが不正です')
    if (!MODES.includes(permissionMode)) throw new Error('権限モードが不正です')
    const selection = await this.#selection(model, effort)
    const now = this.now()
    const record = { id: randomUUID(), title: '新しいタスク', workspace: path.resolve(workspace), ...selection, permissionMode, instructions, mcpServers, permissionPolicy,
      sessionId: null, status: 'idle', createdAt: now, updatedAt: now, archived: false, pinned: false, turns: [], score: emptyScore(), tokenTotal: null,
      ...(team ? { team } : {}), ...(ab ? { ab } : {}) }
    this.records.set(record.id, record)
    try { await this.#save(record, true); this.#index(); await this.indexWriter.flush() }
    catch (error) { this.records.delete(record.id); this.#index(); throw error }
    this.#emit(record)
    return this.summary(record)
  }

  async configure(id, patch) { return this.update(id, patch) }
  async update(id, patch) {
    const record = this.#record(id)
    if (this.running(id) && ['model', 'effort', 'permissionMode', 'instructions', 'mcpServers'].some(key => patch[key] !== undefined)) throw new Error('作業が終わってから設定を変更してください')
    const next = { ...record }
    if (patch.permissionMode !== undefined) {
      if (!MODES.includes(patch.permissionMode)) throw new Error('権限モードが不正です')
      next.permissionMode = patch.permissionMode
    }
    if (patch.model !== undefined || patch.effort !== undefined) {
      const selection = await this.#selection(patch.model ?? record.model, patch.effort ?? record.effort)
      if (record.sessionId && (!record.accountKey || selection.accountKey !== record.accountKey)) throw new Error('Codex のサインイン先が変わったか照合できません。新しいタスクを作成してください。')
      Object.assign(next, selection)
    }
    if (patch.title !== undefined) { if (typeof patch.title !== 'string' || !patch.title.trim()) throw new Error('タイトルが空です'); next.title = clip(patch.title.trim(), 200) }
    for (const key of ['archived', 'pinned']) if (patch[key] !== undefined) { if (typeof patch[key] !== 'boolean') throw new Error('設定の形式が不正です'); next[key] = patch[key] }
    for (const key of ['instructions', 'mcpServers', 'team', 'permissionPolicy']) if (patch[key] !== undefined) next[key] = patch[key]
    next.updatedAt = this.now()
    await this.#save(next, true)
    this.records.set(id, next)
    this.#emit(next)
    return this.summary(next)
  }

  run(id, text, { images = [] } = {}) {
    const record = this.#record(id)
    if (this.closing) throw new Error('アプリを終了しています')
    if (this.running(id)) throw new Error('作業中です。追加指示として送ってください')
    this.executionGuard?.(record)
    if (typeof text !== 'string' || (!text.trim() && !images.length)) throw new Error('メッセージが空です')
    const turn = { id: randomUUID(), startedAt: this.now(), endedAt: null, status: 'running', stopReason: null, error: null, user: { text, images }, items: [] }
    const live = { turn, turnId: null, startAcknowledged: false, earlyCompletion: null, ended: false, stopping: false, ready: deferred(), done: deferred(), denials: [], baseline: record.tokenTotal, baselineKnown: record.turns.length === 0 || record.tokenTotal !== null, usage: null }
    live.speed = new CodexOutputSpeedMeter({ now: this.speedNow, onChange: speed => {
      if (speed) turn.outputSpeed = speed
      else delete turn.outputSpeed
      if (this.live.get(id) !== live || this.closing || live.ended || speed?.state === 'done') return
      this.emit('turn-speed', { id, turnId: turn.id, speed: speed ?? null })
    } })
    record.turns.push(turn)
    record.updatedAt = this.now()
    record.status = 'running'
    if (record.title === '新しいタスク') record.title = clip(text.trim().split('\n')[0] || '画像付きタスク')
    this.live.set(id, live)
    this.#emit(record)
    this.emit('turn', { id, turn })
    void this.#execute(id, live).catch(error => this.#finish(id, live, live.stopping ? 'stopped' : 'error', error.message))
    return this.summary(record)
  }

  async send(id, { text = '', images = [] } = {}) {
    if (!Array.isArray(images) || typeof text !== 'string' || (!text.trim() && !images.length)) throw new Error('メッセージが空か形式が不正です')
    const checked = await abImages(this.attachmentsDir, images)
    if (this.running(id)) { if (!await this.steer(id, text, { images: checked })) throw new Error('追加指示を送信できませんでした'); return }
    this.run(id, text, { images: checked })
    await this.waitForStart(id)
  }

  async waitForStart(id) {
    const live = this.live.get(id)
    if (!live) throw new Error('Codex への送信状態を確認できません')
    const turnId = await live.ready.promise
    if (!turnId) throw new Error(live.turn.error?.message ?? 'Codex への送信を確認できませんでした')
    return turnId
  }

  async #input(text, images) {
    const checked = await abImages(this.attachmentsDir, images)
    return [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...checked.map(image => ({ type: 'localImage', path: path.resolve(this.attachmentsDir, image.file) }))]
  }

  async #execute(id, live) {
    let record = this.#record(id)
    await this.#save(record, true)
    const input = await this.#input(live.turn.user.text, live.turn.user.images)
    await this.server.use(async () => {
      if (live.ended) return
      if (live.stopping) return this.#finish(id, live, 'stopped')
      // Select the model and its account identity together; never authorize with a different read.
      const selection = await this.#selection(record.model, record.effort)
      if (record.sessionId && !record.accountKey) throw new Error('Codex のサインイン先を照合できません。新しいタスクを作成してください。')
      if (record.accountKey && selection.accountKey !== record.accountKey) throw new Error('Codex のサインイン先が変わりました。新しいタスクを作成してください。')
      if (live.ended) return
      if (live.stopping) return this.#finish(id, live, 'stopped')
      const leanResearch = Boolean((record.ab && !record.ab.writable && record.ab.lean) || record.team?.executionMode === 'research')
      const params = { model: record.model, cwd: record.workspace, sandbox: record.permissionMode,
        approvalPolicy: this.#approvalPolicy(record),
        developerInstructions: [this.instructions(record), record.instructions].filter(Boolean).join('\n\n'),
        // The selected level must also be the conversation's own level. Sent only with turn/start, it reaches the model as a mid-conversation
        // update that applies weakly (measured: max ran like medium to high). thread/start honours this; thread/resume ignores it (measured: the
        // resumed thread kept medium), so a conversation keeps the level it was created with and a later change still applies only weakly.
        config: { ...(record.effort ? { model_reasoning_effort: record.effort } : {}), mcp_servers: record.mcpServers ?? {}, 'features.multi_agent': false, 'features.goals': false, 'features.hooks': false, 'features.plugins': false, web_search: leanResearch ? 'disabled' : 'cached', 'features.shell_tool': !leanResearch, 'features.unified_exec': !leanResearch } }
      const result = record.sessionId
        ? await this.server.rawRequest('thread/resume', { ...params, threadId: record.sessionId, excludeTurns: true })
        : await this.server.rawRequest('thread/start', { ...params, ephemeral: false, serviceName: 'agent_desk_tasks' })
      if (live.ended) return
      if (!result.thread?.id) throw new Error('Codex の会話IDを取得できませんでした')
      if (record.sessionId && result.thread.id !== record.sessionId) throw new Error('Codex の会話IDが一致しません。新規会話へ切り替えず停止しました。')
      record.sessionId = result.thread.id
      this.sessions.set(record.sessionId, id)
      await this.#save(record, true)
      if (live.ended) return
      if (live.stopping) return this.#finish(id, live, 'stopped')
      const response = await this.server.rawRequest('turn/start', { threadId: record.sessionId, clientUserMessageId: live.turn.id,
        input, model: record.model, effort: record.effort, cwd: record.workspace, approvalPolicy: this.#approvalPolicy(record), sandboxPolicy: { ...codexSandbox(record.permissionMode, record.workspace), ...(leanResearch ? { networkAccess: false } : {}) } })
      if (live.ended) return
      if (!response.turn?.id) throw new Error('Codex のターンIDを取得できませんでした')
      if (live.turnId && live.turnId !== response.turn.id) throw new Error('Codex のターンIDが一致しません')
      live.turnId = response.turn.id
      live.startAcknowledged = true
      live.ready.resolve(live.turnId)
      if (live.earlyCompletion) this.#notification('turn/completed', live.earlyCompletion)
      this.#emit(record)
      if (live.stopping && !live.ended) await this.server.rawRequest('turn/interrupt', { threadId: record.sessionId, turnId: live.turnId })
      await live.done.promise
    })
  }

  #approvalPolicy(record) {
    return record.permissionMode === 'read-only' || record.ab || record.permissionPolicy === 'deny' || record.permissionMode === 'danger-full-access' ? 'never' : 'on-request'
  }

  async steer(id, text, { images = [] } = {}) {
    const live = this.live.get(id)
    if (!live || live.ended || live.stopping) return false
    this.executionGuard?.(this.#record(id))
    const input = await this.#input(text, images)
    const turnId = await live.ready.promise
    if (!turnId || live.ended || live.stopping) return false
    const messageId = randomUUID()
    // The local UUID lets Codex correlate this one user message; an uncertain failure is never retried.
    await this.server.rawRequest('turn/steer', { threadId: this.#record(id).sessionId, expectedTurnId: turnId, clientUserMessageId: messageId, input })
    live.turn.items.push({ type: 'steer', id: messageId, text, images, at: this.now() })
    const record = this.#record(id)
    await this.#save(record, true)
    this.emit('turn', { id, turn: live.turn })
    return true
  }

  #notification(method, params = {}) {
    const id = this.sessions.get(params.threadId)
    const live = this.live.get(id)
    if (!live || live.ended) return
    const incomingId = params.turnId ?? params.turn?.id
    if (live.turnId && incomingId && incomingId !== live.turnId) return
    if (!live.stopping) live.speed.event(method, params)
    if (method === 'turn/started') { live.turnId = params.turn.id; live.ready.resolve(live.turnId); return }
    if (method === 'thread/tokenUsage/updated') { live.usage = params.tokenUsage; return }
    if (method === 'model/rerouted' && params.toModel !== this.#record(id).model) {
      live.refusal = 'Codex が別のモデル（' + params.toModel + '）へ切り替えたため停止しました。モデルを確認してから再開してください。'
      live.turn.items.push({ type: 'notice', id: randomUUID(), level: 'warning', text: live.refusal })
      this.emit('turn', { id, turn: live.turn })
      void this.server.rawRequest('turn/interrupt', { threadId: params.threadId, turnId: params.turnId })
        .catch(error => this.#finish(id, live, 'error', live.refusal + ' ' + error.message))
      return
    }
    if (method === 'serverRequest/resolved') {
      this.permissions.delete(String(params.requestId)); this.#emit(this.#record(id)); return
    }
    if (method === 'turn/completed') {
      if (!live.startAcknowledged) { live.earlyCompletion = params; return }
      for (const item of params.turn.items ?? []) applyCodexEvent(live.turn, 'item/completed', { item }, this.now())
      void this.#finish(id, live, live.refusal ? 'error' : live.stopping || params.turn.status === 'interrupted' ? 'stopped' : params.turn.status === 'completed' ? 'done' : 'error', live.refusal ?? params.turn.error?.message)
      return
    }
    if (method === 'error' && params.willRetry !== true) { void this.#finish(id, live, 'error', params.error?.message ?? 'Codex でエラーが発生しました'); return }
    if (applyCodexEvent(live.turn, method, params, this.now())) {
      void this.#save(this.#record(id)).catch(error => this.emit('fault', error))
      this.emit('turn', { id, turn: live.turn })
    }
  }

  #request({ id: requestId, method, params = {} }) {
    const id = this.sessions.get(params.threadId)
    const record = this.records.get(id), live = this.live.get(id)
    const known = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)
    if (!known) { this.server.reject(requestId, { code: -32601, message: 'Agent Desk does not expose this client operation' }); return }
    if (live && !live.ended && (!live.turnId || params.turnId === live.turnId)) live.speed.pause({ discard: true })
    if (!record || !live || live.ended || live.stopping || (live.turnId && params.turnId !== live.turnId) || record.permissionMode === 'read-only' || record.ab || record.permissionPolicy === 'deny') {
      this.server.respond(requestId, { decision: 'decline' })
      if (live) live.denials.push({ tool_name: method, tool_input: { command: params.command, reason: params.reason } })
      return
    }
    this.permissions.set(String(requestId), { rawId: requestId, taskId: id, turnId: params.turnId, kind: method.includes('commandExecution') ? 'command' : 'file',
      title: params.command || (method.includes('fileChange') ? 'ファイル変更の承認' : 'コマンドの承認'), details: params.reason ?? params.cwd ?? '' })
    this.#emit(record)
    this.emit('approval', { id, requestId: String(requestId) })
  }

  pendingPermissions(id) { return [...this.permissions.entries()].filter(([, entry]) => entry.taskId === id).map(([requestId, { rawId, taskId, turnId, ...entry }]) => ({ requestId, ...entry })) }
  respondPermission(id, requestId, decision) {
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('承認の選択が不正です')
    const pending = this.permissions.get(String(requestId)), live = this.live.get(id)
    if (!pending || pending.taskId !== id || !live || live.ended || live.stopping) throw new Error('この承認はすでに終了しています')
    const record = this.#record(id)
    if (record.permissionMode === 'read-only' || record.ab || record.permissionPolicy === 'deny') throw new Error('この担当では権限を拡張できません')
    this.server.respond(pending.rawId, { decision })
    this.permissions.delete(String(requestId))
    this.#emit(record)
  }

  async #finish(id, live, status, message) {
    if (live.ended) return live.done.promise
    live.ended = true
    live.speed.finish()
    live.ready.resolve(null)
    const record = this.#record(id), turn = live.turn
    for (const [key, pending] of this.permissions) if (pending.taskId === id) { try { this.server.respond(pending.rawId, { decision: 'cancel' }) } catch {} this.permissions.delete(key) }
    turn.status = status === 'done' ? 'done' : status === 'stopped' ? 'cancelled' : 'error'
    turn.stopReason = status
    turn.error = message ? { message: String(message) } : null
    turn.endedAt = this.now()
    record.status = status
    record.updatedAt = this.now()
    let score = { points: 0, priced: 0, unpriced: 1 }
    if (live.usage?.total && live.baselineKnown && !live.refusal) {
      const total = live.usage.total, baseline = live.baseline ?? {}
      const count = key => Math.max(0, (total[key] ?? 0) - (baseline[key] ?? 0))
      const input = count('inputTokens'), cached = count('cachedInputTokens'), cacheWrite = count('cacheWriteInputTokens'), output = count('outputTokens')
      score = scoreResponse(await loadPricing(), 'openai-codex/' + record.model, { inputTokens: Math.max(0, input - cached - cacheWrite), cacheReadTokens: cached, cacheWriteTokens: cacheWrite, outputTokens: output }, turn.startedAt, 1)
      turn.usage = { requests: 1, input: Math.max(0, input - cached - cacheWrite), output, cacheRead: cached, cacheWrite, reasoning: count('reasoningOutputTokens'), cost: null, models: ['codex/' + record.model], score }
    }
    record.tokenTotal = live.usage?.total ?? null
    if (live.usage?.last) record.usage = { used: live.usage.last.totalTokens ?? 0, size: live.usage.modelContextWindow ?? 0 }
    record.score = addScores(record.score ?? emptyScore(), score)
    turn.totalScore = record.score
    try { await this.#save(record, true) }
    catch (error) { this.emit('fault', error); turn.error = { message: 'Codex の実行記録を保存できませんでした: ' + error.message }; turn.status = 'error'; record.status = 'error'; status = 'error' }
    this.live.delete(id)
    this.#emit(record)
    this.emit('turn', { id, turn })
    live.done.resolve()
    this.emit('finished', { id, status, text: turn.items.filter(item => item.type === 'agent').at(-1)?.text ?? '', error: turn.error?.message ?? null, denials: live.denials, score: record.score, usage: turn.usage ?? null })
  }

  async stop(id) {
    const live = this.live.get(id)
    if (!live) return this.get(id)
    live.stopping = true
    live.speed.pause()
    if (live.turnId && !live.ended) await this.server.rawRequest('turn/interrupt', { threadId: this.#record(id).sessionId, turnId: live.turnId })
    let timer
    try { await Promise.race([live.done.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Codex の停止完了を確認できませんでした')), this.stopTimeoutMs) })]) }
    finally { clearTimeout(timer) }
    return this.get(id)
  }

  async remove(id) {
    const record = this.#record(id)
    await this.stop(id)
    this.records.delete(id)
    this.#index()
    try { await this.indexWriter.flush() } catch (error) { this.records.set(id, record); this.#index(); throw error }
    if (record.sessionId) this.sessions.delete(record.sessionId)
    // Keep Codex's own conversation; deleting a UI task must not prune shared runtime/account state.
    this.emit('removed', { id })
  }

  async shutdown() {
    this.closing = true
    await Promise.allSettled([...this.live.keys()].map(id => this.stop(id)))
    await this.server.stop()
    await Promise.all([...this.live.values()].map(live => live.done.promise))
    await Promise.all([...this.writers.values()].map(writer => writer.flush()))
    await this.indexWriter.flush()
  }
}
