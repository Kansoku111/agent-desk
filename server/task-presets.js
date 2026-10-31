import { EventEmitter } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJson, writeText } from './json-file.js'
import { Checkpoints } from './checkpoints.js'
import { ExecutionVerifier, normalizeChecks, sourceSnapshot, workspacesOverlap } from './execution.js'
import { workflowEffort, workflowEffortSupported, workflowLevels } from '../shared/workflow-effort.js'
import { abClaudeArgs } from './ab-runner.js'
import { PRESET_ACTIVE, PRESET_LABEL, preparePresetPrompt, parsePresetBrief, matchesPresetPrompt, workerPresetInstructions, parsePresetResult } from './task-preset-protocol.js'
import { gitPresetReview, presetFileScope } from './task-preset-evidence.js'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const finalText = (turn) => (turn?.items ?? []).filter((item) => item.type === 'agent').at(-1)?.text ?? ''
const sourceKey = (source) => source.kind + ':' + source.id
export class TaskPresets extends EventEmitter {
  constructor({ dir, threads, terminals, agents, teams, catalog, settings, validateModel, authorize, mcpServers = () => [], instructions = () => '', writers = () => [], snapshot = sourceSnapshot }) {
    super()
    Object.assign(this, { dir, threads, terminals, agents, teams, catalog, settings, validateModel, authorize, mcpServers, instructions, writers, snapshot })
    this.runs = new Map()
    this.held = new Set()
    this.pending = new Map()
    this.sends = new Map()
    this.resuming = new Map()
    this.writes = Promise.resolve()
    this.creating = Promise.resolve()
    this.closing = false
    this.checkpoints = new Checkpoints({ root: path.join(dir, 'snapshots') })
    this.verifier = new ExecutionVerifier({ dir: path.join(dir, 'verification') })
    threads.on('turn-finished', ({ threadId }) => this.onThreadFinished(threadId))
    threads.on('usage-priced', (thread) => {
      const run = [...this.runs.values()].find((entry) => entry.worker?.kind === 'thread' && entry.worker.id === thread.id)
      if (run) { run.score = thread.score; void this.save(run).catch((error) => this.emit('fault', error)) }
    })
    terminals.on('turn-finished', ({ terminalId }) => {
      for (const run of this.runs.values()) if (run.source.kind === 'terminal' && run.source.id === terminalId && run.phase === 'preparing') this.enqueue(run, () => this.parentFinished(run))
    })
    terminals.on('terminal', (record) => {
      if (record.state !== 'exited') return
      for (const run of this.runs.values()) if (run.source.kind === 'terminal' && run.source.id === record.id && run.phase === 'preparing') this.enqueue(run, () => { throw new Error('元のClaude Codeが終了したため、担当を起動しません。') })
    })
    terminals.on('hook', ({ terminalId, input }) => {
      for (const run of this.runs.values()) if (run.source.kind === 'terminal' && run.source.id === terminalId && run.phase === 'preparing') {
        if (input.hook_event_name === 'UserPromptSubmit' && input.task_preset_marks?.includes(run.id)) run.submitted = true
        if (['Stop', 'StopFailure'].includes(input.hook_event_name)) this.enqueue(run, () => this.parentFinished(run, input.hook_event_name === 'StopFailure'))
      }
    })
    agents.on('finished', (event) => {
      const run = [...this.runs.values()].find((entry) => entry.worker?.kind === 'claude' && entry.worker.id === event.id && entry.phase === 'running')
      if (run) this.enqueue(run, () => this.workerFinished(run, event))
    })
    threads.on('removed', ({ threadId }) => this.sourceRemoved({ kind: 'thread', id: threadId }))
    terminals.on('removed', ({ terminalId }) => this.sourceRemoved({ kind: 'terminal', id: terminalId }))
  }
  async load() {
    const state = await readJson(path.join(this.dir, 'state.json'), { version: 1, runs: [], held: [] }, { recoverCorrupt: false })
    this.held = new Set(state.held ?? [])
    for (const run of state.runs) {
      if (PRESET_ACTIVE.has(run.phase)) { run.phase = 'needs-attention'; run.error = 'アプリの終了により中断されました。自動では再開しません。' }
      this.runs.set(run.id, run)
    }
    await this.verifier.load()
    return this
  }
  get busy() { return [...this.runs.values()].some((run) => PRESET_ACTIVE.has(run.phase)) }
  summary(run) {
    const { preparePrompt, brief, parentReport, parentBefore, parentTurnIds, fingerprint, reviewEvidence, lastRetryKey, checks, result, verification, ...view } = run
    return { ...view, report: (run.report ?? '').slice(0, 1200),
      ...(result ? { result: { ...result, summary: result.summary.slice(0, 1200) } } : {}),
      ...(verification ? { verification: { status: verification.status, record: verification.record, checks: verification.checks.map(({ id, status, log }) => ({ id, status, log })) } } : {}),
    }
  }
  list() { return [...this.runs.values()].map((run) => this.summary(run)) }
  require(id) { const run = this.runs.get(id); if (!run) throw new Error('委託が見つかりません'); return run }
  async save(run) {
    if (run) run.updatedAt = Date.now()
    const value = structuredClone({ version: 1, runs: [...this.runs.values()], held: [...this.held] })
    this.writes = this.writes.catch(() => {}).then(() => writeJson(path.join(this.dir, 'state.json'), value))
    await this.writes
    if (run) this.emit('run', this.summary(run))
  }
  enqueue(run, work) {
    const task = (this.pending.get(run.id) ?? Promise.resolve()).then(work).catch(async (error) => {
      if (!run.cancelled) { run.phase = 'needs-attention'; run.error = error.message; await this.save(run) }
    })
    this.pending.set(run.id, task)
    void task.finally(() => { if (this.pending.get(run.id) === task) this.pending.delete(run.id) }).catch((error) => this.emit('fault', error))
    return task
  }
  assertLive(run) { if (this.closing || run.cancelled || !PRESET_ACTIVE.has(run.phase)) throw new Error('委託は停止されました') }
  async source(source, idle = false) {
    if (!source || !['thread', 'terminal'].includes(source.kind) || typeof source.id !== 'string') throw new Error('元タスクが不正です')
    const record = source.kind === 'thread' ? (await this.threads.get(source.id)).thread : this.terminals.list().find((entry) => entry.id === source.id)
    if (!record || record.ab || record.team || record.preset || this.teams.teamLedBy(source.id)) throw new Error('通常タスクからのみ使えます')
    if (idle && (source.kind === 'thread' ? record.status === 'running' || record.pendingApproval : record.state !== 'running' || record.activity !== 'idle' || record.background > 0 || !this.terminals.status(source.id)?.ready || this.terminals.live?.get(source.id)?.sessionAt === null)) throw new Error('元タスクと裏の作業が待機中になってから開始してください')
    return record
  }
  async inspect(source) {
    const record = await this.source(source)
    let bases = []
    const previous = [...this.runs.values()].filter((run) => sourceKey(run.source) === sourceKey(source) && run.kind === 'delegate' && run.baseline?.commit && run.phase === 'completed').at(-1)
    if (previous) bases.push({ id: 'run:' + previous.id, label: '直前の委託開始前', model: previous.model })
    if (source.kind === 'thread') {
      const { turns } = await this.threads.get(source.id)
      bases.push(...turns.filter((turn) => turn.status === 'done' && turn.checkpoint?.before && turn.checkpoint.changed > 0).reverse().map((turn) => ({ id: 'turn:' + turn.id, label: (turn.user.text ?? '').slice(0, 70), model: record.model })))
    }
    return { workspace: record.workspace, title: record.title, model: record.model, bases, checks: this.teams.execution.checks(record.workspace) }
  }
  guard(record, context) {
    if (!record?.workspace) return
    for (const run of this.runs.values()) {
      if (!PRESET_ACTIVE.has(run.phase) || !workspacesOverlap(record.workspace, run.workspace)) continue
      const ownWorker = run.worker?.id === record.id && record.preset?.runId === run.id
      const ownParent = run.phase === 'preparing' && run.source.id === record.id
      if (context?.presetRunId === run.id && (ownWorker && run.phase === 'running' || ownParent)) continue
      // Model read-only permissions do not make checkpoint restore/undo read-only.
      if (record.permissionMode === 'read-only' && context?.operation !== 'restore' && run.source.id !== record.id && !ownWorker) continue
      throw new Error(PRESET_LABEL[run.kind] + 'が実行中です（' + run.title + ' / ' + run.id + ' / ' + run.workspace + '）')
    }
    if (record.preset && context?.presetRunId !== record.preset.runId) throw new Error('委託の担当には結果画面から操作してください')
  }
  room(workspace) {
    for (const record of this.threads.threads.values()) if ((record.status === 'running' && record.permissionMode !== 'read-only' || this.threads.restoring.has(record)) && workspacesOverlap(workspace, record.workspace)) throw new Error('同じフォルダーで別タスクが作業・復元中です: ' + record.title)
    for (const record of this.terminals.list()) if ((record.activity !== 'idle' || record.background > 0) && workspacesOverlap(workspace, record.workspace)) throw new Error('同じフォルダーでClaude Codeが作業中です: ' + record.title)
    // Stored children have no state; summaries include starting and still-stopping workers.
    for (const team of this.teams.list()) {
      if (!workspacesOverlap(workspace, team.workspace)) continue
      const writing = team.children.some((child) => team.execution
        ? !child.closed && child.execution?.mode !== 'research'
        : ['running', 'approval', 'resuming'].includes(child.state))
      if (writing) throw new Error('同じフォルダーのチーム作業が終わっていません')
    }
    for (const record of this.writers()) if (workspacesOverlap(workspace, record.workspace)) throw new Error('同じフォルダーで別の担当が作業中です: ' + record.title)
    this.guard({ workspace })
    this.teams.guardExecution({ workspace })
  }
  goalWaiting(thread, { userInput = false } = {}) {
    const controlled = [...this.runs.values()].some((run) => run.source.kind === 'thread' && run.source.id === thread.id)
    return controlled ? this.held.has('thread:' + thread.id) && !userInput : undefined
  }
  userAccepted(id) { if (this.held.delete('thread:' + id)) void this.save().catch((error) => this.emit('fault', error)) }
  create(input) {
    const task = this.creating.catch(() => {}).then(() => this.start(input))
    this.creating = task
    return task
  }
  async start({ requestId, source, kind, instruction = '', permissionMode = 'workspace-write', browser = false, review = null, checkIds = [], command = '', expectedModel, expectedEffort, authConfirmation }) {
    if (this.closing) throw new Error('アプリを終了しています')
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId) || !Object.hasOwn(PRESET_LABEL, kind)) throw new Error('委託の要求が不正です')
    if (typeof instruction !== 'string' || instruction.length > 8000 || typeof browser !== 'boolean' || !['workspace-write', 'danger-full-access'].includes(permissionMode)) throw new Error('委託の設定が不正です')
    const payload = { source, kind, instruction, permissionMode, browser, review, checkIds, command, expectedModel, expectedEffort }
    const fingerprint = hash(payload)
    const known = [...this.runs.values()].find((run) => run.requestId === requestId)
    if (known) { if (known.fingerprint !== fingerprint) throw new Error('同じ要求IDに異なる設定は使えません'); return { run: this.summary(known) } }
    const record = await this.source(source, true)
    const config = this.settings().taskPresets?.[kind]
    if (!config?.model) throw new Error('設定 → モデルで担当モデルを選択してください')
    this.validateModel(config.model)
    const levels = workflowLevels(this.catalog(), config.model)
    const effort = workflowEffort(config.effort ?? '', levels)
    if (!workflowEffortSupported(effort, levels)) throw new Error('担当モデルの推論レベルを選び直してください')
    if ((expectedModel !== undefined && expectedModel !== config.model) || (expectedEffort !== undefined && expectedEffort !== effort)) throw new Error('担当の設定が更新されました。表示を確認し、新しく開始してください。')
    const details = await this.inspect(source)
    let base = null
    if (kind === 'review') {
      if (!review || typeof review !== 'object') throw new Error('レビュー対象を指定してください')
      base = details.bases.find((entry) => entry.id === review.base)
      if (!base && review.mode !== 'git' && review.mode !== 'files') throw new Error('レビュー開始点を選び直してください')
      if ((base?.model ?? record.model) === config.model || (source.kind === 'terminal' && config.model === 'claude:' + record.model)) throw new Error('独立レビューには実装とは別のモデルを選択してください')
      if (review.mode === 'files') review = { mode: 'files', files: await presetFileScope(record.workspace, review.files) }
      if (review.mode === 'git') {
        const validated = await gitPresetReview(record.workspace, review.ref)
        review = { mode: 'git', ref: validated.sha, label: review.ref }
      }
    }
    if (!Array.isArray(checkIds) || checkIds.length > 30 || typeof command !== 'string' || command.length > 4000) throw new Error('検証の選択が不正です')
    const checks = normalizeChecks([...checkIds.map((id) => { const check = details.checks.find((entry) => entry.id === id); if (!check) throw new Error('検証IDが見つかりません'); return { ...check, autoRepair: true } }), ...(command.trim() ? [{ id: 'preset-check', command: command.trim(), cwd: '.', timeoutMs: 300000, autoRepair: true }] : [])])
    await this.authorize({ workspace: record.workspace, model: config.model, authConfirmation })
    await this.source(source, true)
    this.room(record.workspace)
    const now = Date.now()
    const run = { id: randomUUID(), requestId, fingerprint, source: { ...source }, sourceSession: record.sessionId, sourceModel: record.modelInUse ?? record.model, kind, title: record.title, workspace: record.workspace, model: config.model, effort, permissionMode: config.model.startsWith('claude:') ? 'danger-full-access' : permissionMode, browser, instruction, review, checks, phase: 'preparing', createdAt: now, updatedAt: now, report: '', sourceGone: false }
    // Reserve before any filesystem/model await; completion never releases the parent's goal gate.
    this.runs.set(run.id, run)
    this.held.add(sourceKey(source))
    run.preparePrompt = preparePresetPrompt(run)
    await this.save(run)
    try {
      const conversation = source.kind === 'thread' ? await this.threads.get(source.id) : await this.terminals.conversation(source.id)
      run.parentTurnIds = conversation.turns.map((turn) => turn.id)
      run.parentBefore = (await this.snapshot(run.workspace)).hash
      this.assertLive(run)
      if (source.kind === 'thread') await this.threads.setGoalWaiting(source.id, true)
      this.assertLive(run)
      if (source.kind === 'thread') {
        const receipt = await this.threads.send(source.id, { text: run.preparePrompt, messageId: run.id }, { presetRunId: run.id })
        run.parentTurnId = receipt.turnId
      } else await this.terminals.sendMessage(source.id, run.preparePrompt, { presetRunId: run.id })
      await this.save(run)
    } catch (error) { if (!run.cancelled) { run.phase = 'needs-attention'; run.error = error.message; await this.save(run) } }
    return { run: this.summary(run) }
  }
  onThreadFinished(id) {
    for (const run of this.runs.values()) {
      if (run.source.kind === 'thread' && run.source.id === id && run.phase === 'preparing') this.enqueue(run, () => this.parentFinished(run))
      if (run.worker?.kind === 'thread' && run.worker.id === id && run.phase === 'running') this.enqueue(run, async () => {
        const { thread, turns } = await this.threads.get(id)
        const turn = turns.at(-1)
        await this.workerFinished(run, { status: turn?.status, text: finalText(turn), error: turn?.error?.message, score: thread.score })
      })
    }
  }
  async parentFinished(run, failed = false) {
    if (run.phase !== 'preparing' || run.cancelled) return
    const source = await this.source(run.source)
    if (run.sourceSession && source.sessionId !== run.sourceSession) throw new Error('元セッションが変更されました。起動しません。')
    run.sourceSession ??= source.sessionId
    let turn
    for (const delay of [0, 100, 400, 1000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      this.assertLive(run)
      const { turns } = run.source.kind === 'thread' ? await this.threads.get(run.source.id) : await this.terminals.conversation(run.source.id)
      const matches = turns.filter((entry) => !run.parentTurnIds.includes(entry.id) && (run.source.kind === 'thread' ? entry.user?.messageId === run.id : matchesPresetPrompt(entry.user?.text, run.preparePrompt)))
      if (matches.length === 1 && turns.at(-1)?.id === matches[0].id && matches[0].status !== 'running') { turn = matches[0]; break }
    }
    if (failed || !turn || turn.status !== 'done' || run.source.kind === 'terminal' && !run.submitted) throw new Error('対応する親の正常な最終回答を確認できません。自動起動しません。')
    run.parentTurnId = turn.id
    run.parentReport = finalText(turn)
    const result = parsePresetBrief(run.parentReport, run)
    run.brief = result.brief
    if (result.status === 'needs_input') { run.phase = 'needs-attention'; run.error = result.questions; return this.save(run) }
    if ((await this.snapshot(run.workspace)).hash !== run.parentBefore) throw new Error('指示の作成中にソースが変更されました。内容を確認して再度開始してください。')
    await this.launch(run)
  }
  async evidence(run) {
    const review = run.review
    if (review.mode === 'git') return gitPresetReview(run.workspace, review.ref)
    if (review.mode === 'files') return { files: review.files.map((file) => ({ path: file })), patch: '', warning: '過去の基準点がないファイルレビューです。実装差分は不明です。' }
    if (review.base.startsWith('run:')) {
      const previous = this.require(review.base.slice(4))
      if (sourceKey(previous.source) !== sourceKey(run.source) || previous.workspace !== run.workspace || !previous.baseline?.commit) throw new Error('委託開始前の記録がありません')
      const after = await this.checkpoints.snapshot(run.workspace)
      return { ...await this.checkpoints.reviewDiff(run.workspace, previous.baseline.commit, after.commit, [...(previous.baseline.omitted ?? []), ...after.omitted]), warning: [previous.baseline.warning, after.warning].filter(Boolean).join('\n') }
    }
    const { turns } = await this.threads.get(run.source.id)
    const turn = turns.find((entry) => 'turn:' + entry.id === review.base)
    if (!turn?.checkpoint?.before || !this.threads.checkpoints) throw new Error('実装開始前の記録がありません')
    const after = await this.threads.checkpoints.snapshot(run.workspace)
    return { ...await this.threads.checkpoints.reviewDiff(run.workspace, turn.checkpoint.before, after.commit, after.omitted), warning: after.warning }
  }
  async launch(run) {
    this.assertLive(run)
    const folder = path.join(this.dir, 'runs', run.id)
    await fs.mkdir(folder, { recursive: true })
    if (run.kind === 'review') {
      const evidence = await this.evidence(run)
      if (!evidence.files.length) throw new Error('対象の変更がありません。基準コミットまたは対象ファイルを指定してください。')
      run.reviewEvidence = { files: evidence.files, warning: evidence.warning, sha: evidence.sha }
      run.originalPatch = path.join(folder, 'original.patch')
      await writeText(run.originalPatch, evidence.patch)
    }
    run.baseline = await this.checkpoints.snapshot(run.workspace, run.id + '/before')
    run.record = path.join(folder, 'report.md')
    run.contract = path.join(folder, 'instructions.md')
    await writeText(run.contract, run.brief)
    this.assertLive(run)
    if ((await this.snapshot(run.workspace)).hash !== run.parentBefore) throw new Error('担当の起動前にソースが変更されました。対象を確認し、再度開始してください。')
    this.assertLive(run)
    this.validateModel(run.model)
    if (run.model.startsWith('claude:')) {
      let args = abClaudeArgs({ writable: true, instructions: workerPresetInstructions(run) + '\n\n' + this.instructions() })
      if (run.browser) {
        const servers = this.mcpServers({ workspace: run.workspace, preset: { browser: true } })
        args.push('--mcp-config', JSON.stringify({ mcpServers: Object.fromEntries(servers.map((server) => [server.name, { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }])) }))
      }
      const worker = await this.agents.create({ workspace: run.workspace, model: run.model.slice(7), effort: run.effort || null, args })
      run.worker = { kind: 'claude', id: worker.id }
    } else {
      const worker = await this.threads.create({ workspace: run.workspace, model: run.model, effort: run.effort, permissionMode: run.permissionMode, toolMode: 'ptc', preset: { runId: run.id, browser: run.browser } })
      run.worker = { kind: 'thread', id: worker.id }
    }
    this.assertLive(run)
    run.phase = 'running'
    await this.save(run)
    const prompt = [run.worker.kind === 'thread' ? workerPresetInstructions(run) : '', '依頼:\n' + run.brief, run.reviewEvidence ? 'レビュー対象（アプリ取得）:\n' + JSON.stringify(run.reviewEvidence) + '\n差分全文: ' + run.originalPatch : '', 'アプリが最後に実行する検証:\n' + JSON.stringify(run.checks) + '\n未選択の場合は検証未実行です。自分で必要な確認は省略しないでください。'].filter(Boolean).join('\n\n')
    await this.sendWorker(run, prompt)
  }
  async sendWorker(run, text) {
    this.assertLive(run)
    if (run.worker.kind === 'claude') this.agents.run(run.worker.id, text)
    else await this.threads.send(run.worker.id, { text }, { presetRunId: run.id })
  }
  async retryWork(run, code, reason) {
    const state = (await this.snapshot(run.workspace)).hash
    const key = hash({ state, code })
    if (run.lastRetryKey === key) throw new Error('同じ未完了状態で進捗を確認できません: ' + reason)
    run.lastRetryKey = key
    run.phase = 'running'
    await this.save(run)
    await this.sendWorker(run, 'この同じ作業を完了してください。親への報告や別担当への委託で終えません。\n' + reason + '\n元の範囲・受け入れ条件を変えず、必要な修正・検証を行い、指定の最終JSONを返してください。requestId: ' + run.id)
  }
  async workerFinished(run, event) {
    if (run.phase !== 'running' || run.cancelled) return
    run.score = event.score ?? run.score
    run.report = event.text ?? ''
    await writeText(run.record, run.report)
    if (event.status !== 'done' || event.denials?.length) throw new Error(event.error || '担当が正常に完了していないか、権限不足です。')
    let result
    try { result = parsePresetResult(run.report, run) } catch (error) { return this.retryWork(run, 'invalid-result', error.message) }
    run.result = result
    if (result.status === 'blocked') throw new Error(result.blocker + (result.remaining ? '\n' + result.remaining : ''))
    if (result.status === 'continue') return this.retryWork(run, 'unfinished', result.remaining || '未完了の修正と検証を続けてください')
    if (result.status === 'verify' && (!run.checks.length || result.blocker)) throw new Error('登録コマンドだけの検証待ちではありません。担当の報告を確認してください。')
    run.phase = 'verifying'
    await this.save(run)
    let verification = await this.verifier.verify({ id: run.id, folder: run.workspace, checks: run.checks })
    if (verification.canRerun && !run.cancelled) verification = await this.verifier.verify({ id: run.id, folder: run.workspace, checks: run.checks, previousRun: verification })
    this.assertLive(run)
    run.verification = verification
    if (verification.status === 'failed') {
      const failed = verification.checks.find((check) => check.status !== 'passed')
      if (!failed?.autoRepair) throw new Error('検証に失敗しました。結果を確認して「続ける」で同じ担当へ戻せます。')
      return this.retryWork(run, 'check:' + failed.id + ':' + failed.exitCode, 'アプリの検証が失敗しました。結果: ' + verification.record + '\nログ: ' + failed.log)
    }
    if (!['passed', 'unverified'].includes(verification.status)) throw new Error('検証を確定できません: ' + verification.status + (verification.error ? '\n' + verification.error : ''))
    const after = await this.checkpoints.snapshot(run.workspace, run.id + '/after')
    const diff = await this.checkpoints.reviewDiff(run.workspace, run.baseline.commit, after.commit, [...(run.baseline.omitted ?? []), ...after.omitted])
    run.changedFiles = diff.files
    run.patch = path.join(this.dir, 'runs', run.id, 'changes.patch')
    run.warning = [run.reviewEvidence?.warning, run.baseline.warning, after.warning].filter(Boolean).join('\n')
    await writeText(run.patch, diff.patch)
    if ((await this.snapshot(run.workspace)).hash !== verification.endHash) throw new Error('検証後にソースが変更されました。再確認が必要です。')
    if (result.status === 'verify') run.result = { ...result, status: 'complete', remaining: '', summary: result.summary + '\n\n登録されたアプリの検証が成功しました。' }
    run.phase = 'completed'
    run.error = null
    await this.save(run)
    // UI state only. Never send a prompt, append a parent turn, or release its goal gate here.
  }
  async get(id) {
    const run = this.require(id)
    const turns = run.worker?.kind === 'thread' ? (await this.threads.get(run.worker.id)).turns : run.worker ? this.agents.turns(run.worker.id) : []
    return { run: { ...this.summary(run), report: run.report, brief: run.brief, parentReport: run.parentReport, result: run.result }, turns: turns ?? [] }
  }
  async readEvidence(id, kind, index) {
    const run = this.require(id)
    const file = { report: run.record, patch: run.patch, original: run.originalPatch }[kind]
      ?? (kind === 'check' && Number.isInteger(index) && index >= 0 ? run.verification?.checks[index]?.log : null)
    if (!['report', 'patch', 'original', 'check'].includes(kind) || !file) throw new Error('資料が見つかりません')
    const handle = await fs.open(file, 'r')
    try {
      const { size } = await handle.stat()
      const buffer = Buffer.alloc(Math.min(size, 128000))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: size > bytesRead, file }
    } finally { await handle.close() }
  }
  async stop(id) {
    const run = this.require(id)
    if (!PRESET_ACTIVE.has(run.phase)) return { run: this.summary(run) }
    const preparing = run.phase === 'preparing'
    run.cancelled = true
    run.phase = 'stopping'
    this.verifier.cancel(run.id)
    await this.save(run)
    const stopThread = async (threadId) => { const done = this.threads.active.get(threadId)?.done; await this.threads.cancel(threadId); await done }
    if (run.worker?.kind === 'thread') await stopThread(run.worker.id)
    if (run.worker?.kind === 'claude') { const exited = this.agents.live.get(run.worker.id)?.exited; this.agents.stop(run.worker.id); await exited }
    if (preparing) {
      if (run.source.kind === 'thread') await stopThread(run.source.id)
      else this.terminals.interrupt(run.source.id, null)
    }
    await this.pending.get(id)
    run.phase = 'stopped'
    await this.save(run)
    return { run: this.summary(run) }
  }
  resume(id) {
    if (this.resuming.has(id)) return this.resuming.get(id)
    const task = this.resumeWork(id).finally(() => this.resuming.delete(id))
    this.resuming.set(id, task)
    return task
  }
  async resumeWork(id) {
    const run = this.require(id)
    if (!['needs-attention', 'stopped'].includes(run.phase) || !run.worker) throw new Error('担当の開始前です。元タスクで条件を確認し、新しく開始してください。')
    await this.source(run.source, true)
    this.room(run.workspace)
    this.validateModel(run.model)
    await this.authorize({ workspace: run.workspace, model: run.model })
    // Authorization yields: recheck and claim synchronously, just as a new run does.
    await this.source(run.source, true)
    if (this.closing) throw new Error('アプリを終了しています')
    if (this.sends.has(id)) throw new Error('結果を送信中です。送信完了後に再開してください。')
    this.room(run.workspace)
    run.cancelled = false
    run.error = null
    delete run.lastRetryKey
    // A resumed attempt produces a new result, not a retry of the previous delivery.
    delete run.deliveredAt
    delete run.deliveryAttempted
    delete run.deliveryMessageId
    run.phase = 'running'
    await this.save(run)
    this.enqueue(run, () => this.sendWorker(run, workerPresetInstructions(run) + '\n依頼を途中から再開し、未完了の修正・検証を完了してください。前回の状態:\n' + JSON.stringify({ error: run.result?.blocker, remaining: run.result?.remaining, verification: run.verification })))
    return { run: this.summary(run) }
  }
  async deliver(id) {
    const run = this.require(id)
    if (PRESET_ACTIVE.has(run.phase)) throw new Error('担当が終了してから送信してください')
    if (run.deliveredAt) return { sent: true }
    if (this.sends.has(id)) return this.sends.get(id)
    const task = (async () => {
      await this.source(run.source, true)
      this.room(run.workspace)
      if (run.deliveryAttempted && run.source.kind === 'terminal') throw new Error('前回の送信状態が不明です。元の会話を確認してください。自動では再送しません。')
      run.deliveryAttempted = true
      run.deliveryMessageId ??= randomUUID()
      await this.save(run)
      const text = '[Agent Desk: ' + PRESET_LABEL[run.kind] + 'の結果 / ' + run.id + ']\n状態: ' + run.phase + '\n検証: ' + (run.verification?.status ?? '未実行') + '\n' + (run.result?.summary ?? run.report ?? '').slice(0, 5000) + '\n未完了: ' + (run.error || run.result?.remaining || 'なし') + '\n資料: ' + (run.record ?? '担当開始前') + (run.patch ? '\n修正差分: ' + run.patch : '') + '\nこれは担当の報告です。未検証事項を成功とみなさず、必要に応じて確認してください。'
      if (run.source.kind === 'thread') await this.threads.send(run.source.id, { text, messageId: run.deliveryMessageId }, { userInitiated: true })
      else await this.terminals.sendMessage(run.source.id, text)
      run.deliveredAt = Date.now()
      await this.save(run)
      return { sent: true }
    })().finally(() => this.sends.delete(id))
    this.sends.set(id, task)
    return task
  }
  sourceRemoved(source) {
    for (const run of this.runs.values()) if (sourceKey(run.source) === sourceKey(source)) {
      run.sourceGone = true
      void (PRESET_ACTIVE.has(run.phase) ? this.stop(run.id) : this.save(run)).catch((error) => this.emit('fault', error))
    }
  }
  async shutdown() {
    this.closing = true
    await Promise.allSettled([...this.runs.values()].filter((run) => PRESET_ACTIVE.has(run.phase)).map((run) => this.stop(run.id)))
    await this.verifier.stop()
    await Promise.allSettled([...this.pending.values()])
    await this.writes
  }
}
