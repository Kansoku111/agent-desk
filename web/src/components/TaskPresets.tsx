import { useEffect, useRef, useState } from 'react'
import './TaskPresets.css'
import { CheckCircle2, ChevronRight, CornerDownRight, Loader2, PanelRight, Square, X } from 'lucide-react'
import { act, request, setState, useStore } from '../store'
import type { ExecutionCheck, TaskPresetKind, TaskPresetRun, TaskPresetSource, Turn } from '../types'
import { effortLabel, parseModel } from '../util'
import { workflowEffort, workflowEffortSupported, workflowLevels, workflowOptions } from '../../../shared/workflow-effort.js'
import { ModelField, modelGroups } from './WorkflowModelField'
import { Modal } from './Modal'
import { Markdown } from './Markdown'
import { TurnView } from './TurnView'
import { UsageCost } from './UsageCost'
import { FileRef } from './FileRef'
import { ClaudeAuthConsent } from './ClaudeAuthConsent'
import type { AuthConsentState } from '../team-auth-consent'
const LABEL = { delegate: '子に委託', review: '独立レビュー' }
const PHASE: Record<string, string> = { preparing: '親が指示を作成中', running: '作業中', verifying: '検証中', stopping: '停止中', completed: '完了', 'needs-attention': '要確認', stopped: '停止' }
const CHECK: Record<string, string> = { passed: '成功', failed: '失敗', unverified: 'コマンド未選択', cancelled: '中断', invalidated: '再検証が必要', error: '取得できません' }
const active = (run: TaskPresetRun) => ['preparing', 'running', 'verifying', 'stopping'].includes(run.phase)
interface Inspection { workspace: string; title: string; bases: { id: string; label: string }[]; checks: ExecutionCheck[] }

export function TaskPresetModels() {
  const server = useStore((state) => state.server)
  const [saving, setSaving] = useState(false)
  if (!server) return null
  const groups = modelGroups(server)
  const change = async (role: TaskPresetKind, model: string, effort: string) => {
    setSaving(true)
    await act('settings.update', { patch: { taskPresets: { [role]: { model: model || null, effort: effort || null } } } })
    setSaving(false)
  }
  return <section className="account-card">
    <div className="account-head"><h3>タスクのプリセット</h3></div>
    <div className="ab-model-grid">{(['delegate', 'review'] as const).map((role) => {
      const choice = server.settings.taskPresets?.[role]
      const model = choice?.model ?? ''
      const levels = workflowLevels(server.catalog, model)
      const effort = workflowEffort(choice?.effort ?? '', levels)
      const available = groups.some((group) => group.models.some((entry) => entry.value === model))
      return <ModelField key={role} label={LABEL[role] + (model && !available ? '（利用不可）' : '')} value={model} groups={groups} disabled={saving}
        effort={effort} efforts={workflowOptions(effort, levels)} allowClearUnavailableEffort
        onEffort={(value) => void change(role, model, value)}
        onChange={(value) => void change(role, value, workflowEffort(effort, workflowLevels(server.catalog, value), true))} />
    })}</div>
  </section>
}

function StartDialog({ source, kind }: { source: TaskPresetSource; kind: TaskPresetKind }) {
  const server = useStore((state) => state.server)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [error, setError] = useState('')
  const [instruction, setInstruction] = useState('')
  const [scope, setScope] = useState('')
  const [ref, setRef] = useState('')
  const [files, setFiles] = useState('')
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
    request<Inspection>('preset.inspect', { source }).then((value) => {
      if (!alive) return
      setInspection(value); setScope(value.bases[0]?.id ?? 'git')
    }).catch((cause) => { if (alive) setError(cause.message) })
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
    const review = kind !== 'review' ? null : scope === 'git' ? { mode: 'git', ref: ref.trim() } : scope === 'files' ? { mode: 'files', files: files.split('\n').map((file) => file.trim()).filter(Boolean) } : { base: scope }
    const payload = { source, kind, instruction, browser, permissionMode: cli ? 'danger-full-access' : permission, review, checkIds, command, expectedModel: model, expectedEffort: effort }
    const fingerprint = JSON.stringify(payload)
    if (fingerprint !== intent.current.fingerprint) intent.current = { fingerprint, id: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      const result = await request<{ run: TaskPresetRun }>('preset.create', { ...payload, requestId: intent.current.id, authConfirmation: auth.confirmation })
      setState({ presetStart: null, presetRun: result.run.id })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    setBusy(false)
  }
  return <Modal title={LABEL[kind]} onClose={busy ? () => {} : close} width={560}>
    <div className="modal-body preset-form">
      <div className="preset-model-line"><strong>{selected ? selectedGroup!.heading + ' / ' + selected.name : model ? '設定済みの担当モデルを利用できません' : '担当モデルが未設定です'}</strong><span className="muted">{effort ? effortLabel(effort) : '推論指定なし'} · {cli || permission === 'danger-full-access' ? 'フルアクセス' : '作業フォルダーに書き込み'}</span>
        <button type="button" className="link-button" disabled={busy} onClick={() => { close(); setState({ settingsOpen: 'models' }) }}>設定</button></div>
      {kind === 'review' && <label>対象<select value={scope} disabled={busy || !inspection} onChange={(event) => setScope(event.target.value)}>
        {inspection?.bases.map((base) => <option value={base.id} key={base.id}>{base.label}</option>)}
        <option value="git">基準コミットから現在まで</option><option value="files">ファイル指定（過去の差分なし）</option>
      </select></label>}
      {kind === 'review' && scope === 'git' && <label>基準コミット<input placeholder="例: HEAD~1（未コミット変更も含む）" value={ref} maxLength={200} disabled={busy} onChange={(event) => setRef(event.target.value)} /></label>}
      {kind === 'review' && scope === 'files' && <label>対象ファイル<textarea rows={3} placeholder="プロジェクト内の相対パスを1行ずつ" value={files} disabled={busy} onChange={(event) => setFiles(event.target.value)} /></label>}
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
        <button type="button" className="button primary" disabled={busy || !inspection || !ready || (cli && !auth.ready) || (kind === 'review' && ((scope === 'git' && !ref.trim()) || (scope === 'files' && !files.trim())))} onClick={() => void start()}>{busy && <Loader2 size={14} className="spin" />}始める</button></div>
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

export function TaskPresetRuns({ source, onClose }: { source: TaskPresetSource; onClose: () => void }) {
  const server = useStore((state) => state.server)
  const runs = usePresetRuns(source)
  if (!server || !runs.length) return null
  return <>
    <div className="subagent-backdrop" aria-hidden="true" onClick={onClose} />
    <aside className="subagent-panel team-panel" aria-label="委託とレビュー">
      <div className="subagent-panel-head"><span className="subagent-panel-title">委託とレビュー</span>
        <button type="button" className="icon-button small" aria-label="パネルを閉じる" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="subagent-list">{runs.map((run) => {
        const model = run.model.startsWith('claude:')
          ? server.catalog.models.find((entry) => entry.provider === 'anthropic' && entry.id === run.model.slice(7))?.name ?? run.model.slice(7)
          : server.catalog.models.find((entry) => entry.value === run.model)?.name ?? parseModel(run.model)?.id ?? run.model
        const providerId = parseModel(run.model)?.provider
        const provider = run.model.startsWith('claude:') ? 'Claude Code' : providerId ? server.catalog.providers[providerId] ?? providerId : ''
        return <button type="button" key={run.id} className={`subagent-card team-card status-${active(run) ? 'running' : run.phase === 'completed' ? 'done' : 'error'}`} onClick={() => setState({ presetRun: run.id })}>
          <div className="subagent-card-head"><span className="subagent-status">{active(run) ? <Loader2 size={13} className="spin" /> : run.phase === 'completed' ? <CheckCircle2 size={13} /> : <CornerDownRight size={13} />}</span>
            <span className="team-card-name">{LABEL[run.kind]}</span><span className="subagent-time">{PHASE[run.phase] ?? run.phase}</span></div>
          <div className="subagent-card-title">{run.title}</div>
          <div className="subagent-card-activity">{provider ? provider + ' / ' : ''}{model}{run.effort ? '・' + effortLabel(run.effort) : ''}</div>
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
        {detail?.turns.length ? <details><summary>作業記録</summary>{detail.turns.map((turn) => <TurnView key={turn.id} turn={turn} workspace={run.workspace} threadId={run.worker?.id ?? run.source.id} hideUser threadBusy={active(run)} undoable={false} />)}</details> : run.parentReport && <details><summary>親の回答</summary><Markdown text={run.parentReport} workspace={run.workspace} /></details>}
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
  return <>{start && <StartDialog key={start.source.kind + start.source.id + start.kind} {...start} />}{result && <ResultDialog key={result} id={result} />}</>
}
