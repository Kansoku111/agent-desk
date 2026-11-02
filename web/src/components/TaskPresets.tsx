import { useEffect, useRef, useState } from 'react'
import './TaskPresets.css'
import { CheckCircle2, ChevronRight, CornerDownRight, FolderOpen, Loader2, PanelLeftOpen, PanelRight, Send, Square, X } from 'lucide-react'
import { act, isNarrow, isTouch, loadThread, navigate, request, setState, useStore } from '../store'
import { getDraft, useDraft, useImeField } from '../drafts'
import { PRESET_PROMPT_MARK } from '../../../shared/task-preset-mark.js'
import type { AppState, ExecutionCheck, TaskPresetKind, TaskPresetRun, TaskPresetSource, Turn } from '../types'
import { effortLabel, parseModel, workspaceLabel } from '../util'
import { workflowEffort, workflowEffortSupported, workflowLevels, workflowOptions } from '../../../shared/workflow-effort.js'
import { reviewModelChoice } from '../../../shared/task-preset-models.js'
import { ModelField, modelGroups } from './WorkflowModelField'
import { Modal } from './Modal'
import { Markdown } from './Markdown'
import { TurnView } from './TurnView'
import { useConversationScroll } from './useConversationScroll'
import { UsageCost } from './UsageCost'
import { FileRef } from './FileRef'
import { ClaudeAuthConsent } from './ClaudeAuthConsent'
import type { AuthConsentState } from '../team-auth-consent'
const LABEL = { delegate: '子に委託', review: '独立レビュー' }
const PHASE: Record<string, string> = { preparing: '親が指示を作成中', running: '作業中', verifying: '検証中', stopping: '停止中', completed: '完了', 'needs-attention': '要確認', stopped: '停止' }
const CHECK: Record<string, string> = { passed: '成功', failed: '失敗', unverified: 'コマンド未選択', cancelled: '中断', invalidated: '再検証が必要', error: '取得できません' }
const active = (run: TaskPresetRun) => ['preparing', 'running', 'verifying', 'stopping'].includes(run.phase)
interface Inspection { workspace: string; title: string; checks: ExecutionCheck[] }

export function TaskPresetModels() {
  const server = useStore((state) => state.server)
  const [saving, setSaving] = useState(false)
  if (!server) return null
  const groups = modelGroups(server)
  const change = async (role: 'delegate' | 'reviewDsh' | 'reviewClaude', model: string, effort: string) => {
    setSaving(true)
    await act('settings.update', { patch: { taskPresets: { [role]: { model: model || null, effort: effort || null } } } })
    setSaving(false)
  }
  return <section className="account-card">
    <div className="account-head"><h3>タスクのプリセット</h3></div>
    <div className="ab-model-grid">{(['delegate', 'reviewDsh', 'reviewClaude'] as const).map((role) => {
      const choice = role === 'delegate' ? server.settings.taskPresets?.delegate : reviewModelChoice(server.settings, role === 'reviewClaude' ? 'claude' : 'dsh')
      const model = choice?.model ?? ''
      const levels = workflowLevels(server.catalog, model)
      const effort = workflowEffort(choice?.effort ?? '', levels)
      const roleGroups = role === 'delegate' ? groups : groups.filter((group) => role === 'reviewClaude' ? group.id === 'claude-code' : group.id !== 'claude-code')
      const available = roleGroups.some((group) => group.models.some((entry) => entry.value === model))
      const label = role === 'delegate' ? LABEL.delegate : role === 'reviewClaude' ? '独立レビュー / Claude Code' : '独立レビュー / DSH'
      return <ModelField key={role} label={label + (model && !available ? '（利用不可）' : '')} value={model} groups={roleGroups} disabled={saving}
        effort={effort} efforts={workflowOptions(effort, levels)} allowClearUnavailableEffort
        onEffort={(value) => void change(role, model, value)}
        onChange={(value) => void change(role, value, workflowEffort(effort, workflowLevels(server.catalog, value), true))} />
    })}</div>
  </section>
}

function ReviewStartDialog({ source }: { source: TaskPresetSource }) {
  const server = useStore((state) => state.server)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [harness, setHarness] = useState<'dsh' | 'claude'>(source.kind === 'terminal' ? 'dsh' : 'claude')
  const [mode, setMode] = useState<'opinion' | 'fix'>('opinion')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [auth, setAuth] = useState<AuthConsentState>({ ready: false })
  const intent = useRef({ fingerprint: '', id: '' })
  const close = () => setState({ presetStart: null })
  useEffect(() => {
    let alive = true
    request<Inspection>('preset.inspect', { source }).then((value) => { if (alive) setInspection(value) }).catch((cause) => { if (alive) setError(cause.message) })
    return () => { alive = false }
  }, [source.id, source.kind])
  if (!server) return null
  const choice = reviewModelChoice(server.settings, harness)
  const model = choice?.model ?? ''
  const groups = modelGroups(server)
  const group = groups.find((entry) => entry.models.some((item) => item.value === model))
  const selected = group?.models.find((item) => item.value === model)
  const effort = workflowEffort(choice?.effort ?? '', workflowLevels(server.catalog, model))
  const ready = selected && workflowEffortSupported(effort, workflowLevels(server.catalog, model))
  const start = async () => {
    if (!inspection || busy) return
    const payload = { source, kind: 'review', harness, reviewMode: mode, expectedModel: model, expectedEffort: effort }
    const fingerprint = JSON.stringify(payload)
    if (fingerprint !== intent.current.fingerprint) intent.current = { fingerprint, id: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      const result = await request<{ run: TaskPresetRun }>('preset.create', { ...payload, requestId: intent.current.id, authConfirmation: auth.confirmation })
      setState({ presetStart: null })
      navigate({ view: 'preset', id: result.run.id })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    setBusy(false)
  }
  return <Modal title="独立レビュー" onClose={busy ? () => {} : close} width={560}>
    <div className="modal-body preset-form">
      <fieldset className="preset-switch"><legend>担当</legend>
        {([['dsh', 'DSH'], ['claude', 'Claude Code']] as const).map(([value, label]) => <label key={value}><input type="radio" name="review-harness" value={value} checked={harness === value} disabled={busy} onChange={() => setHarness(value)} />{label}</label>)}
      </fieldset>
      <fieldset className="preset-switch"><legend>方法</legend>
        {([['opinion', '意見を聞く'], ['fix', 'レビューして修正']] as const).map(([value, label]) => <label key={value}><input type="radio" name="review-mode" value={value} checked={mode === value} disabled={busy} onChange={() => setMode(value)} />{label}</label>)}
      </fieldset>
      <div className="preset-model-line"><strong>{selected ? group!.heading + ' / ' + selected.name : model ? '設定済みの担当モデルを利用できません' : '担当モデルが未設定です'}</strong><span className="muted">{effort ? effortLabel(effort) : '推論指定なし'} · {harness === 'claude' ? 'フルアクセス' : mode === 'opinion' ? '読み取り専用' : '作業フォルダーに書き込み'}</span>
        <button type="button" className="link-button" disabled={busy} onClick={() => { close(); setState({ settingsOpen: 'models' }) }}>設定</button></div>
      {harness === 'claude' && inspection && selected && <ClaudeAuthConsent workspace={inspection.workspace} taskPreset onChange={setAuth} />}
      {error && <p className="team-warning" role="alert">{error}</p>}
      {mode === 'opinion' && <div className="preset-start-note muted">完了後、元のセッションへ自動で返します。</div>}
      <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={close}>キャンセル</button>
        <button type="button" className="button primary" disabled={busy || !inspection || !ready || (harness === 'claude' && !auth.ready)} onClick={() => void start()}>{busy && <Loader2 size={14} className="spin" />}始める</button></div>
    </div>
  </Modal>
}

function StartDialog({ source, kind }: { source: TaskPresetSource; kind: TaskPresetKind }) {
  const server = useStore((state) => state.server)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [error, setError] = useState('')
  const [instruction, setInstruction] = useState('')
  const [browser, setBrowser] = useState(false)
  const [permission, setPermission] = useState('workspace-write')
  const [checkIds, setChecks] = useState<string[]>([])
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [auth, setAuth] = useState<AuthConsentState>({ ready: false })
  const intent = useRef({ fingerprint: '', id: '' })
  const close = () => setState({ presetStart: null })
  useEffect(() => {
    let alive = true
    request<Inspection>('preset.inspect', { source }).then((value) => { if (alive) setInspection(value) }).catch((cause) => { if (alive) setError(cause.message) })
    return () => { alive = false }
  }, [source.id, source.kind])
  if (!server) return null
  const model = server.settings.taskPresets?.[kind]?.model ?? ''
  const groups = modelGroups(server)
  const selectedGroup = groups.find((group) => group.models.some((entry) => entry.value === model))
  const selected = selectedGroup?.models.find((entry) => entry.value === model)
  const effort = workflowEffort(server.settings.taskPresets?.[kind]?.effort ?? '', workflowLevels(server.catalog, model))
  const cli = model.startsWith('claude:')
  const ready = selected && workflowEffortSupported(effort, workflowLevels(server.catalog, model))
  const start = async () => {
    if (!inspection || busy) return
    const payload = { source, kind, instruction, browser, permissionMode: cli ? 'danger-full-access' : permission, checkIds, command, expectedModel: model, expectedEffort: effort }
    const fingerprint = JSON.stringify(payload)
    if (fingerprint !== intent.current.fingerprint) intent.current = { fingerprint, id: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      const result = await request<{ run: TaskPresetRun }>('preset.create', { ...payload, requestId: intent.current.id, authConfirmation: auth.confirmation })
      setState({ presetStart: null })
      navigate({ view: 'preset', id: result.run.id })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    setBusy(false)
  }
  return <Modal title={LABEL[kind]} onClose={busy ? () => {} : close} width={560}>
    <div className="modal-body preset-form">
      <div className="preset-model-line"><strong>{selected ? selectedGroup!.heading + ' / ' + selected.name : model ? '設定済みの担当モデルを利用できません' : '担当モデルが未設定です'}</strong><span className="muted">{effort ? effortLabel(effort) : '推論指定なし'} · {cli || permission === 'danger-full-access' ? 'フルアクセス' : '作業フォルダーに書き込み'}</span>
        <button type="button" className="link-button" disabled={busy} onClick={() => { close(); setState({ settingsOpen: 'models' }) }}>設定</button></div>
      <textarea aria-label="追加指示" rows={3} maxLength={8000} placeholder="追加指示（任意）" value={instruction} disabled={busy} onChange={(event) => setInstruction(event.target.value)} />
      <details><summary>実行設定</summary><div className="preset-options">
        {cli ? <p className="muted">Claude Codeはフルアクセスで実行します。</p> : <label>権限<select value={permission} disabled={busy} onChange={(event) => setPermission(event.target.value)}><option value="workspace-write">作業フォルダーへの書き込み</option><option value="danger-full-access">フルアクセス</option></select></label>}
        <label className="preset-check"><input type="checkbox" checked={browser} disabled={busy} onChange={(event) => setBrowser(event.target.checked)} />ブラウザを使う</label>
        {inspection?.checks.map((check) => <label className="preset-check" key={check.id}><input type="checkbox" checked={checkIds.includes(check.id)} disabled={busy}
          onChange={(event) => setChecks(event.target.checked ? [...checkIds, check.id] : checkIds.filter((id) => id !== check.id))} /><span>{check.id}<code>{check.command}</code></span></label>)}
        <p className="muted">選択した検証コマンドはPC上で実行します（担当のサンドボックス外）。</p>
        <label>追加の検証コマンド<input value={command} maxLength={4000} placeholder="例: npm test" disabled={busy} onChange={(event) => setCommand(event.target.value)} /></label>
      </div></details>
      {cli && inspection && <ClaudeAuthConsent workspace={inspection.workspace} taskPreset onChange={setAuth} />}
      {error && <p className="team-warning" role="alert">{error}</p>}
      <div className="preset-start-note muted">{kind === 'review' ? '別モデルが指摘箇所の修正・検証まで行います。' : '現在のモデルが指示を作り、子が実作業と確認を行います。'} 完了後、親には自動送信しません。</div>
      <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={close}>キャンセル</button>
        <button type="button" className="button primary" disabled={busy || !inspection || !ready || (cli && !auth.ready)} onClick={() => void start()}>{busy && <Loader2 size={14} className="spin" />}始める</button></div>
    </div>
  </Modal>
}

function usePresetRuns(source: TaskPresetSource) {
  const runs = useStore((state) => state.server?.taskPresets)
  return runs?.filter((run) => run.source.kind === source.kind && run.source.id === source.id) ?? []
}

export function TaskPresetToggle({ source, open, onToggle }: { source: TaskPresetSource; open: boolean; onToggle: () => void }) {
  const runs = usePresetRuns(source)
  if (!runs.length) return null
  return <button type="button" className={`button ghost subagent-toggle team-toggle ${open ? 'active' : ''}`}
    aria-pressed={open} aria-label={open ? '委託のパネルを閉じる' : '委託のパネルを開く'} onClick={onToggle}>
    <PanelRight size={16} /><span className="team-toggle-label">委託</span><span className="team-toggle-count">{runs.length}</span>
  </button>
}

function modelLabel(server: AppState, run: TaskPresetRun) {
  const model = run.model.startsWith('claude:')
    ? server.catalog.models.find((entry) => entry.provider === 'anthropic' && entry.id === run.model.slice(7))?.name ?? run.model.slice(7)
    : server.catalog.models.find((entry) => entry.value === run.model)?.name ?? parseModel(run.model)?.id ?? run.model
  const providerId = parseModel(run.model)?.provider
  const provider = run.model.startsWith('claude:') ? 'Claude Code' : providerId ? server.catalog.providers[providerId] ?? providerId : ''
  return (provider ? provider + ' / ' : '') + model
}

export function TaskPresetRuns({ source, onClose }: { source: TaskPresetSource; onClose: () => void }) {
  const server = useStore((state) => state.server)
  const route = useStore((state) => state.route)
  const runs = usePresetRuns(source)
  if (!server || !runs.length) return null
  const parent = source.kind === 'thread' ? server.threads.find((entry) => entry.id === source.id) : server.terminals.find((entry) => entry.id === source.id)
  const here = (view: string, id: string) => route.view === view && 'id' in route && route.id === id ? 'page' as const : undefined
  return <>
    <div className="subagent-backdrop" aria-hidden="true" onClick={onClose} />
    <aside className="subagent-panel team-panel" aria-label="委託とレビュー">
      <div className="subagent-panel-head"><span className="subagent-panel-title">委託とレビュー</span>
        <button type="button" className="icon-button small" aria-label="パネルを閉じる" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="subagent-list">
        {parent && <button type="button" className="subagent-card team-card" aria-current={here(source.kind, source.id)} onClick={() => navigate({ view: source.kind, id: source.id })}>
          <div className="subagent-card-head"><span className="team-card-name">親</span></div>
          <div className="subagent-card-title">{parent.title}</div>
          <ChevronRight size={14} className="subagent-card-chev" />
        </button>}
        {runs.map((run) => {
        return <button type="button" key={run.id} className={`subagent-card team-card status-${active(run) ? 'running' : run.phase === 'completed' ? 'done' : 'error'}`} aria-current={here('preset', run.id)} onClick={() => navigate({ view: 'preset', id: run.id })}>
          <div className="subagent-card-head"><span className="subagent-status">{active(run) ? <Loader2 size={13} className="spin" /> : run.phase === 'completed' ? <CheckCircle2 size={13} /> : <CornerDownRight size={13} />}</span>
            <span className="team-card-name">{LABEL[run.kind]}</span><span className="subagent-time">{PHASE[run.phase] ?? run.phase}</span></div>
          <div className="subagent-card-title">{run.title}</div>
          <div className="subagent-card-activity">{modelLabel(server, run)}{run.effort ? '・' + effortLabel(run.effort) : ''}</div>
          <ChevronRight size={14} className="subagent-card-chev" />
        </button>
      })}</div>
    </aside>
  </>
}

function Evidence({ id, kind, index, title }: { id: string; kind: string; index?: number; title: string }) {
  const [data, setData] = useState<{ text: string; truncated: boolean; file: string } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = async () => {
    if (data || loading) return
    setLoading(true); setError('')
    try { setData(await request('preset.evidence', { runId: id, kind, index })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    setLoading(false)
  }
  return <details onToggle={(event) => { if (event.currentTarget.open) void load() }}><summary>{title}</summary>
    {loading && <p>読み込み中…</p>}
    {error && <p role="alert">{error}</p>}
    {data && <><pre className="preset-evidence">{data.text || '（空の資料）'}</pre>{data.truncated && <p className="muted">先頭128KBを表示しています。全文: <FileRef refText={data.file} workspace={null}>{data.file}</FileRef></p>}</>}
  </details>
}

function ResultDialog({ id }: { id: string }) {
  const server = useStore((state) => state.server)
  const summary = server?.taskPresets?.find((run) => run.id === id)
  const [detail, setDetail] = useState<{ run: TaskPresetRun; turns: Turn[] } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => setState({ presetRun: null })
  useEffect(() => {
    let alive = true
    const refresh = () => { void request<{ run: TaskPresetRun; turns: Turn[] }>('preset.get', { runId: id }).then((value) => { if (alive) setDetail(value) }).catch((cause) => { if (alive) setError(cause.message) }) }
    refresh()
    const timer = summary && active(summary) ? setInterval(refresh, 2000) : null
    return () => { alive = false; if (timer) clearInterval(timer) }
  }, [id, summary?.updatedAt, summary?.phase])
  const run = detail?.run ?? summary
  const hasReport = !!(run?.worker && (run.report?.trim() || run.result?.summary?.trim()))
  const action = async (method: string) => {
    setBusy(true); setError('')
    try { await request('preset.' + method, { runId: id }) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    setBusy(false)
  }
  return <Modal title={run ? LABEL[run.kind] : '委託'} onClose={close} width={760}>
    <div className="modal-body preset-result">
      {!run ? <p>読み込み中…</p> : <>
        <div className="preset-result-head"><strong>{PHASE[run.phase] ?? run.phase}</strong><span className="muted">{modelGroups(server!).flatMap((group) => group.models.map((model) => ({ ...model, heading: group.heading }))).filter((model) => model.value === run.model).map((model) => model.heading + ' / ' + model.name)[0] ?? run.model} · {effortLabel(run.effort)}</span></div>
        {run.error && <p className="team-warning" role="alert">{run.error}</p>}
        {run.deliveryError && <p className="team-warning" role="alert">{run.deliveryError}</p>}
        {run.warning && <p className="team-warning">{run.warning}</p>}
        <UsageCost score={run.score} detail="担当の累計です。親の指示作成・結果送信の使用量は元タスク側に含まれます。" />
        {run.verification && <p>検証: {CHECK[run.verification.status] ?? run.verification.status}</p>}
        {run.result?.summary ? <Markdown text={run.result.summary} workspace={run.workspace} /> : run.report && <Markdown text={run.report} workspace={run.workspace} />}
        {run.changedFiles?.length ? <details><summary>変更 {run.changedFiles.length} 件</summary><ul>{run.changedFiles.map((file) => <li key={file.path}><code>{file.status} {file.path}</code></li>)}</ul></details> : null}
        {run.patch && <Evidence id={id} kind="patch" title="担当による修正差分" />}
        {run.originalPatch && <Evidence id={id} kind="original" title="レビュー対象の元の差分" />}
        {run.verification?.checks.map((check, index) => <Evidence key={check.id} id={id} kind="check" index={index} title={check.id + ' · ' + (CHECK[check.status] ?? check.status)} />)}
        {run.record && <Evidence id={id} kind="report" title="報告全文" />}
        {run.brief && <details><summary>親からの指示</summary><Markdown text={run.brief} workspace={run.workspace} /></details>}
        {!run.worker && run.parentReport && <details><summary>親の回答</summary><Markdown text={run.parentReport} workspace={run.workspace} /></details>}
        {run.sourceGone && <p className="muted">元タスクは削除済みです。</p>}
        {!active(run) && !hasReport && !run.sourceGone && <p className="muted">{run.worker ? '担当からの報告はまだありません。' : '担当は開始していません。元の会話で依頼を確認し、「開く」から開始し直してください。'}</p>}
        {!active(run) && hasReport && !run.sourceGone && <p className="muted">「本セッションに渡す」を押すと、元のモデルへ送信し、応答を開始します。</p>}
        <div className="modal-actions">
          {active(run) && <button type="button" className="button" disabled={busy || run.phase === 'stopping'} onClick={() => void action('stop')}><Square size={13} />停止</button>}
          {!active(run) && run.worker && !run.sourceGone && run.phase !== 'completed' && <button type="button" className="button" disabled={busy} onClick={() => void action('resume')}>同じ担当で続ける</button>}
          <button type="button" className="button" onClick={close}>閉じる</button>
          {!active(run) && hasReport && <button type="button" className="button primary" disabled={busy || run.sourceGone || !!run.deliveredAt} onClick={() => void action('deliver')}>{run.deliveredAt ? '送信済み' : '本セッションに渡す'}</button>}
        </div>
      </>}
      {error && <p className="team-warning" role="alert">{error}</p>}
    </div>
  </Modal>
}

export function TaskPresetDialogs() {
  const start = useStore((state) => state.presetStart)
  const result = useStore((state) => state.presetRun)
  return <>{start && (start.kind === 'review' ? <ReviewStartDialog key={start.source.kind + start.source.id} source={start.source} /> : <StartDialog key={start.source.kind + start.source.id + start.kind} {...start} />)}{result && <ResultDialog key={result} id={result} />}</>
}

/**
 * A delegated worker shown like a team's child: its own turns, live, with the
 * runs of the same parent beside it. Details (diff, checks) stay in the dialog.
 */
export function PresetView({ id }: { id: string }) {
  const server = useStore((state) => state.server)
  const run = useStore((state) => state.server?.taskPresets?.find((entry) => entry.id === id))
  const worker = run?.worker
  const turns = useStore((state) => !worker ? undefined : worker.kind === 'thread' ? state.turns[worker.id] : state.agentTurns[worker.id])
  const sidebarOpen = useStore((state) => state.sidebarOpen)
  const [panelOpen, setPanelOpen] = useState(() => !isNarrow())
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useDraft('preset:' + id)
  const ime = useImeField()
  const loaded = turns !== undefined
  const { scroller, onScroll } = useConversationScroll('preset:' + id, !!run, turns)
  useEffect(() => {
    let alive = true
    // Live frames only update turns already loaded; a reconnect clears them.
    if (worker?.kind === 'thread' && !loaded) void loadThread(worker.id)
    void request<{ run: TaskPresetRun; turns: Turn[] }>('preset.get', { runId: id }).then((value) => {
      if (!alive) return
      setBrief(value.run.brief ?? '')
      if (worker?.kind === 'claude' && !loaded) setState((current) => ({ agentTurns: { ...current.agentTurns, [worker.id]: value.turns } }))
    }).catch(() => {})
    return () => { alive = false }
  }, [id, worker?.kind, worker?.id, loaded])
  if (!server || !run) return <div className="main-empty">委託が見つかりません</div>
  const working = active(run)
  const hasReport = !!(run.worker && (run.report?.trim() || run.result?.summary?.trim()))
  const action = async (method: string) => {
    setBusy(true); setError('')
    try { await request('preset.' + method, { runId: id }) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    setBusy(false)
  }
  // While the worker works this interrupts it; once it has stopped this replies to it.
  const submit = async () => {
    const body = getDraft('preset:' + id).trim()
    if (!body || busy) return
    setBusy(true); setError('')
    try {
      await request('preset.message', { runId: id, text: body })
      if (getDraft('preset:' + id).trim() === body) setText('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    setBusy(false)
  }
  return <div className="thread-view terminal-view agent-view">
    <header className="main-header">
      <div className="header-left">
        {!sidebarOpen && <button type="button" className="icon-button" aria-label="サイドバーを開く" title="サイドバーを開く (Ctrl+B)" onClick={() => setState({ sidebarOpen: true })}><PanelLeftOpen size={16} /></button>}
        {run.model.startsWith('claude:') && <span className="cl-mark" aria-hidden="true">CL</span>}
        <h1 className="thread-heading" title={run.title}>{LABEL[run.kind]}: {run.title}</h1>
        <span className="header-chip" title={run.workspace}><FolderOpen size={13} />{workspaceLabel(run.workspace, server.app.myPc, server.settings.projectNames)}</span>
        <span className="header-chip">{modelLabel(server, run)}{run.effort ? '・' + effortLabel(run.effort) : ''}</span>
        <span className={`header-chip terminal-status ${working ? 'running' : 'idle'}`}>{working && <Loader2 size={12} className="spin" />}{PHASE[run.phase] ?? run.phase}</span>
      </div>
      <div className="header-right">
        <TaskPresetToggle source={run.source} open={panelOpen} onToggle={() => setPanelOpen((open) => !open)} />
        {working && <button type="button" className="button ghost" disabled={busy || run.phase === 'stopping'} onClick={() => void action('stop')}><Square size={13} /> 止める</button>}
      </div>
    </header>
    <div className="thread-body">
      <div className="thread-main">
        <div className="terminal-chat"><div className="scroller" ref={scroller} onScroll={onScroll}><div className="column">
          {brief && <details className="preset-brief"><summary>親からの指示</summary><Markdown text={brief} workspace={run.workspace} /></details>}
          {!worker ? <div className="loading-turns">{working ? <><Loader2 size={14} className="spin" /> {PHASE[run.phase]}</> : run.parentReport ? <Markdown text={run.parentReport} workspace={run.workspace} /> : '担当は開始していません'}</div>
            : !turns ? <div className="loading-turns"><Loader2 size={14} className="spin" /> 読み込み中…</div>
              : turns.map((turn, index) => <TurnView key={turn.id} turn={turn} workspace={run.workspace} threadId={worker.id} hideUser={index === 0 || turn.user.text.startsWith(PRESET_PROMPT_MARK)} threadBusy={working} undoable={false} />)}
          {(run.error || error || run.deliveryError) && <p className="team-warning" role="alert">{error || run.error || run.deliveryError}</p>}
        </div></div></div>
        {!working && <div className="preset-view-actions">
          {run.worker && !run.sourceGone && run.phase !== 'completed' && <button type="button" className="button" disabled={busy} onClick={() => void action('resume')}>同じ担当で続ける</button>}
          <button type="button" className="button" onClick={() => setState({ presetRun: id })}>詳細</button>
          {hasReport && <button type="button" className="button primary" disabled={busy || run.sourceGone || !!run.deliveredAt} onClick={() => void action('deliver')}>{run.deliveredAt ? '送信済み' : '本セッションに渡す'}</button>}
        </div>}
        {worker && !run.sourceGone && <div className="terminal-touch">
          <div className="terminal-input">
            <textarea {...ime.fieldProps} value={text} rows={1} placeholder={working ? '作業中の担当に割り込む' : '担当に返信'} aria-label="担当に送るメッセージ"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key === 'Escape' && working) { event.preventDefault(); void action('stop'); return }
                if (event.key !== 'Enter' || event.shiftKey || isTouch()) return
                event.preventDefault()
                void submit()
              }} />
            <button type="button" className="terminal-send" aria-label="送信" disabled={busy || !text.trim()}
              onPointerDown={(event) => { event.preventDefault(); ime.confirm() }} onClick={() => void submit()}><Send size={16} /></button>
          </div>
        </div>}
      </div>
      {panelOpen && <TaskPresetRuns source={run.source} onClose={() => setPanelOpen(false)} />}
    </div>
  </div>
}
