import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, PanelLeftOpen, Square, Trash2 } from 'lucide-react'
import { act, navigate, setState, useStore } from '../store'
import type { AbConfig, AbJob, AbRun, AppState } from '../types'
import { providerReady, visibleModels } from '../model-selection'
import { effortLabel } from '../util'
import { abTimeline } from '../ab-transcript'
import { workflowEffort, workflowLevels, workflowOptions } from '../../../shared/workflow-effort.js'
import { Modal, ConfirmDialog } from './Modal'
import { byNewest, PROVIDER_NOTE, PROVIDER_ORDER } from './Pickers'
import { Dropdown, MenuDivider, MenuHeading, MenuItem } from './Popover'
import { useWheelSelect } from './useWheelSelect'
import { Markdown, CopyButton } from './Markdown'
import { ClaudeAuthConsent } from './ClaudeAuthConsent'
import { AbImages, AbInput, useAbDraft } from './AbInput'
import type { AuthConsentState } from '../team-auth-consent'

export const AB_PHASE: Record<string, string> = { consulting: '2社に相談中', judging: '判断中', 'awaiting-approval': '案を確認', preparing: '実装指示を作成中', implementing: '実装中', reviewing: 'レビュー中', completed: '実装担当の報告', reviewed: 'レビュー報告', 'needs-attention': '要確認', stopped: '停止', interrupted: '中断', error: 'エラー' }
const ACTIVE = ['consulting', 'judging', 'preparing', 'implementing', 'reviewing']
const ROLE: Record<string, string> = { a: '相談 A', b: '相談 B', leader: '判断・報告', instructions: '実装指示', implementer: '実装', direct: 'リーダー実装', reviewer: 'レビュー' }
const FIELDS = [['a', '相談 A'], ['b', '相談 B'], ['leader', '判断・報告リーダー'], ['implementer', '実装用モデル']] as const
const CLAUDE_CODE = [{ value: 'claude:opus', name: 'Opus' }, { value: 'claude:sonnet', name: 'Sonnet' }, { value: 'claude:haiku', name: 'Haiku' }]

function modelEfforts(server: AppState, model: string, wanted: string): string[] {
  return workflowOptions(wanted, workflowLevels(server.catalog, model))
}

interface ModelGroup { id: string; heading: string; note: string; models: { value: string; name: string }[] }

/** The models a field offers, grouped and named as in the composer's model menu. */
function modelGroups(server: AppState): ModelGroup[] {
  const byProvider = new Map<string, { value: string; name: string; id: string }[]>()
  for (const model of visibleModels(server)) {
    if (model.retired || !providerReady(server, model.provider)) continue
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
  }
  const order = [...new Set([...PROVIDER_ORDER, ...byProvider.keys()])].filter((provider) => byProvider.has(provider))
  return [
    { id: 'claude-code', heading: 'Claude Code', note: '', models: CLAUDE_CODE },
    ...order.map((provider) => ({
      id: provider, heading: server.catalog.providers[provider] ?? provider, note: PROVIDER_NOTE[provider] ?? '',
      models: byProvider.get(provider)!.sort(byNewest),
    })),
  ]
}

function ModelField({ label, value, groups, disabled, onChange, effort, efforts, onEffort }: {
  label: string; value: string; groups: ModelGroup[]; disabled: boolean; onChange: (value: string) => void
  effort: string; efforts: string[]; onEffort: (value: string) => void
}) {
  const effortName = !efforts.length ? '指定不可' : effort ? `${effortLabel(effort)}${efforts.includes(effort) ? '' : '（非対応）'}` : '中'
  const name = groups.flatMap((group) => group.models).find((model) => model.value === value)?.name ?? 'モデルを選択'
  const modelWheel = useWheelSelect<HTMLButtonElement>(disabled ? [] : groups.flatMap((group) => group.models.map((model) => model.value)), value, onChange)
  const effortWheel = useWheelSelect<HTMLButtonElement>(disabled || !value ? [] : efforts, efforts.includes(effort) ? effort : null, onEffort)
  const wheelName = groups.flatMap((group) => group.models).find((model) => model.value === modelWheel.shown)?.name ?? name
  const shownEffort = effortWheel.pending && effortWheel.shown ? effortLabel(effortWheel.shown) : effortName
  return <div className="ab-field">
    <span>{label}</span>
    <div className="ab-model-controls"><Dropdown
      placement="bottom"
      portal
      width={300}
      trigger={({ toggle, open }) => (
        <button ref={modelWheel.ref} type="button" className={`ab-picker ${open ? 'active' : ''} ${modelWheel.pending ? 'wheeling' : ''}`} aria-label={`${label}: ${name}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={toggle}>
          <span>{wheelName}</span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <div className="menu-scroll">
          {groups.map((group, index) => (
            <div key={group.id}>
              {index > 0 && <MenuDivider />}
              <MenuHeading>{group.heading}<span className="menu-heading-note">{group.note}</span></MenuHeading>
              {group.models.map((model) => (
                <MenuItem key={model.value} label={model.name} selected={model.value === value} onSelect={() => { onChange(model.value); close() }} />
              ))}
            </div>
          ))}
        </div>
      )}
    </Dropdown>
    <Dropdown portal width={160} className="ab-effort-menu" trigger={({ toggle, open }) => (
      <button ref={effortWheel.ref} type="button" className={`ab-effort ${effortWheel.pending ? 'wheeling' : ''}`} aria-label={`${label}の推論レベル: ${effortName}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled || !value || !efforts.length} onClick={toggle}>
        <span>{shownEffort}</span><ChevronDown size={12} />
      </button>
    )}>
      {(close) => <>
        {efforts.map((value) => <MenuItem key={value} label={effortLabel(value)} selected={effort === value} onSelect={() => { onEffort(value); close() }} />)}
      </>}
    </Dropdown></div>
  </div>
}

function ImplementationOptions({ config, change, disabled = false }: { config: Pick<AbConfig, 'delegate' | 'review'>; change: (patch: Partial<AbConfig>) => void; disabled?: boolean }) {
  return <div className="ab-switches">
    <label><input type="checkbox" checked={config.delegate} disabled={disabled} onChange={(event) => change({ delegate: event.target.checked })} /> 実装用モデルに委託</label>
    <label><input type="checkbox" checked={config.review} disabled={disabled || !config.delegate} onChange={(event) => change({ review: event.target.checked })} /> 委託後にリーダーがレビュー</label>
  </div>
}

export function AbStartDialog({ workspace }: { workspace: string }) {
  const server = useStore((state) => state.server)
  const [config, setConfig] = useState<AbConfig | null>(null)
  const draft = useAbDraft()
  const [auth, setAuth] = useState<AuthConsentState>({ ready: false })
  const [busy, setBusy] = useState(false)
  const saves = useRef(Promise.resolve<unknown>(null))
  useEffect(() => {
    let alive = true
    void act<{ config: AbConfig }>('ab.config', {}).then((result) => {
      if (!alive || !result) return
      const next = { ...result.config, efforts: { ...result.config.efforts } }
      if (server) for (const [key] of FIELDS) {
        next.efforts[key] = workflowEffort(next.efforts[key], workflowLevels(server.catalog, next[key]))
      }
      setConfig(next)
      if (JSON.stringify(next) !== JSON.stringify(result.config)) saves.current = saves.current.then(() => act('ab.configure', { config: next }))
    })
    return () => { alive = false }
  }, [])
  const change = (patch: Partial<AbConfig>) => {
    if (!config) return
    const next = { ...config, ...patch }
    setConfig(next)
    saves.current = saves.current.then(() => act('ab.configure', { config: next }))
  }
  const close = () => setState({ abStart: null })
  if (!server) return null
  const groups = modelGroups(server)
  const valid = (value: string) => groups.some((group) => group.models.some((model) => model.value === value))
  const required = config ? [config.a, config.b, config.leader, ...(config.delegate ? [config.implementer] : [])] : []
  const usesClaude = config ? [config.a, config.b, config.leader, config.implementer].some((value) => value.startsWith('claude:')) : false
  const ready = config && required.every(valid) && draft.ready && (!usesClaude || auth.ready)
  const start = () => draft.submit(Boolean(ready), async () => {
    setBusy(true)
    try {
      await saves.current
      const result = await act<{ run: AbRun }>('ab.create', { workspace, text: draft.text, images: draft.images, config, authConfirmation: usesClaude ? auth.confirmation : undefined })
      if (result) { close(); navigate({ view: 'ab', id: result.run.id }) }
      return result
    } finally { setBusy(false) }
  })
  return <Modal title="AB" onClose={close} width={700} className="team-start-modal">
    <div className="team-start-body">
      {config ? <>
        <div className="ab-model-grid">{FIELDS.map(([key, label]) => (
          <ModelField key={key} label={label} value={valid(config[key]) ? config[key] : ''} groups={groups} disabled={busy}
            effort={config.efforts[key]} efforts={modelEfforts(server, config[key], config.efforts[key])}
            onEffort={(value) => change({ efforts: { ...config.efforts, [key]: value } })}
            onChange={(value) => change({ [key]: value, efforts: { ...config.efforts, [key]: workflowEffort(config.efforts[key], workflowLevels(server.catalog, value), true) } })} />
        ))}</div>
        <div className="ab-switches"><label><input type="checkbox" checked={config.lean} disabled={busy} onChange={(event) => change({ lean: event.target.checked })} /> 相談モデルのツールを絞る</label></div>
        <ImplementationOptions config={config} change={change} disabled={busy} />
        <AbInput draft={draft} label="相談内容" placeholder="相談したいこと" disabled={busy} rows={6} onSubmit={() => void start()} />
        {usesClaude && <ClaudeAuthConsent workspace={workspace} onChange={setAuth} />}
      </> : <Loader2 className="spin" size={20} />}
    </div>
    <div className="modal-actions"><button className="button" onClick={close} disabled={busy}>キャンセル</button><button className="button primary" disabled={!ready || busy} onClick={() => void start()}>{busy ? '開始中…' : '2社に相談'}</button></div>
  </Modal>
}

function Report({ job, workspace, modelName, open = false }: { job: AbJob; workspace: string; modelName: string; open?: boolean }) {
  return <details className="ab-report" open={open || undefined}>
    <summary><span>{ROLE[job.role] ?? job.role}</span><span className="muted">{modelName}{job.effort ? ` · ${effortLabel(job.effort)}` : ''}</span>{job.status === 'running' && <Loader2 size={14} className="spin" />}</summary>
    {job.error && <p className="error-text">{job.error}</p>}
    {job.stopError && <p role="alert" className="error-text">{job.stopError}</p>}
    {job.report ? <><CopyButton text={job.report} /><Markdown text={job.report} workspace={workspace} /></> : <p className="muted">{job.status === 'running' ? '検討中…' : '報告なし'}</p>}
  </details>
}

export function AbView({ id }: { id: string }) {
  const server = useStore((state) => state.server)
  const run = server?.ab?.find((entry) => entry.id === id)
  const draft = useAbDraft()
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [options, setOptions] = useState({ delegate: run?.config.delegate ?? true, review: run?.config.review ?? true })
  useEffect(() => { if (run) setOptions({ delegate: run.config.delegate, review: run.config.review }) }, [id, run?.config.delegate, run?.config.review])
  if (!run || !server) return <div className="empty-state">ABが見つかりません</div>
  const modelName = (value: string) => CLAUDE_CODE.find((entry) => entry.value === value)?.name ?? server.catalog.models.find((entry) => entry.value === value)?.name ?? value
  const action = async (method: string, input: object = {}) => {
    setBusy(true)
    try { return await act(method, { runId: id, ...input }) } finally { setBusy(false) }
  }
  const running = run.jobs.some((job) => ['running', 'stopping'].includes(job.status))
  const canRetry = run.retryJobId && (['error', 'stopped', 'interrupted', 'needs-attention'].includes(run.phase) || (run.phase === 'reviewed' && run.warning)) && !running
  const followup = () => draft.submit(!busy && !running && ['awaiting-approval', 'completed', 'reviewed', 'needs-attention'].includes(run.phase), () => action('ab.revise', { text: draft.text, images: draft.images }))
  const latest = run.jobs.filter((job) => ['leader', 'implementer', 'direct', 'reviewer'].includes(job.role) && job.report).at(-1)
  return <div className="ab-view">
    <header className="ab-header"><button className="icon-button" aria-label="サイドバーを開く" onClick={() => setState({ sidebarOpen: true })}><PanelLeftOpen size={18} /></button><span className="cl-mark tm-mark">AB</span><h2>{run.title}</h2>
      <span className="ab-phase">{ACTIVE.includes(run.phase) && <Loader2 size={14} className="spin" />}{AB_PHASE[run.phase] ?? run.phase}</span>
      {(ACTIVE.includes(run.phase) || running) && <button className="icon-button" aria-label="ABを停止" disabled={busy} onClick={() => void action('ab.stop')}><Square size={16} /></button>}
      <button className="icon-button" aria-label="ABを削除" disabled={busy} onClick={() => setRemoving(true)}><Trash2 size={16} /></button>
    </header>
    <div className="ab-content">
      <section className="ab-question"><CopyButton text={run.text} /><Markdown text={run.text} workspace={run.workspace} /><AbImages images={run.images} /></section>
      <div className="ab-consultations">{run.jobs.filter((job) => ['a', 'b'].includes(job.role)).map((job) => <Report key={job.id} job={job} workspace={run.workspace} modelName={modelName(job.model)} />)}</div>
      {run.error && <p role="alert" className="error-text">{run.error}</p>}
      {run.warning && <p role="alert" className="error-text">{run.warning}</p>}
      {abTimeline(run).filter((entry) => entry.kind !== 'job' || !['a', 'b'].includes(entry.job.role)).map((entry) => entry.kind === 'message'
        ? <section className="ab-question" key={entry.key}><Markdown text={entry.text} workspace={run.workspace} /><AbImages images={entry.images} /></section>
        : <Report key={entry.key} job={entry.job} workspace={run.workspace} modelName={modelName(entry.job.model)} open={entry.job.id === latest?.id} />)}
      {run.phase === 'awaiting-approval' && !running && <section className="ab-approval">
        <ImplementationOptions config={options} change={(patch) => setOptions((current) => ({ ...current, ...patch }))} disabled={busy} />
        <button className="button primary" disabled={busy || (options.delegate && !run.config.implementer)} onClick={() => void action('ab.approve', { revision: run.revision, ...options })}>この案に同意して実装</button>

      </section>}
      {['awaiting-approval', 'completed', 'reviewed', 'needs-attention'].includes(run.phase) && !running && <div className="ab-followup"><AbInput draft={draft} label="追加相談" placeholder="案への修正・追加の条件" rows={3} disabled={busy || draft.busy} onSubmit={() => void followup()} /><button className="button" disabled={busy || !draft.ready} onClick={() => void followup()}>リーダーに送る</button></div>}
      {['completed', 'needs-attention'].includes(run.phase) && run.config.delegate && !run.jobs.some((job) => job.role === 'reviewer' && job.status === 'completed') && <p className="muted">リーダーレビュー未実施</p>}
      {canRetry && <button className="button" disabled={busy} onClick={() => setRetrying(run.retryJobId!)}>この段階を再試行</button>}
      {['error', 'stopped', 'interrupted'].includes(run.phase) && <button className="button" onClick={() => setState({ abStart: run.workspace })}>新しい相談</button>}
    </div>
    {retrying && <ConfirmDialog title="この段階を再試行" body={<p>変更済みのファイルは残し、同じ担当・承認済みの案で続けます。担当が現在の差分を確認してから再開します。</p>} confirmLabel="再試行" onClose={() => setRetrying(null)} onConfirm={() => void action('ab.retry', { jobId: retrying })} />}
    {removing && <ConfirmDialog title="ABを削除" body={<p>実行中の作業を停止し、相談と各担当の記録を削除します。プロジェクトのファイルは削除しません。</p>} confirmLabel="削除" danger onClose={() => setRemoving(false)} onConfirm={() => void action('ab.remove')} />}
  </div>
}
