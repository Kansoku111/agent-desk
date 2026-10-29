import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { act, setState, startTeam, useStore } from '../store'
import type { ExecutionCheck, TeamProvider, TeamSettings } from '../types'
import { executionChildChoice, executionModelSelection } from '../model-selection'
import { nextCheckId } from '../execution-checks'
import { ModelField, modelGroups } from './WorkflowModelField'
import { workflowEffort, workflowEffortSupported, workflowLevels, workflowOptions } from '../../../shared/workflow-effort.js'
import { Modal } from './Modal'
import { PtcToggle } from './PtcToggle'
import { ClaudeAuthConsent } from './ClaudeAuthConsent'
import type { AuthConsentState } from '../team-auth-consent'

const providers: { id: TeamProvider; name: string; catalog?: string }[] = [
  { id: 'claude', name: 'Claude Code' }, { id: 'claudeApi', name: 'Claude（API）', catalog: 'anthropic' },
  { id: 'gpt', name: 'GPT', catalog: 'openai-codex' }, { id: 'deepseek', name: 'DeepSeek', catalog: 'deepseek-official' },
  { id: 'opencodeGo', name: 'OpenCode Go', catalog: 'opencode-go' }, { id: 'local', name: 'ローカル LLM', catalog: 'local-llm' },
]

const CHOICE_KEY = 'agent-desk.execution-models'
const DEFAULT_CHOICE = { leader: 'claude:opus', provider: 'claude' as TeamProvider, model: 'haiku', leaderEffort: '', childEffort: '', toolMode: 'ptc' as 'native' | 'ptc', planImplement: false }
function readChoice() {
  try {
    const value = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null')
    if (typeof value?.leader === 'string' && providers.some((entry) => entry.id === value.provider) && typeof value.model === 'string') return { ...DEFAULT_CHOICE, ...value, leaderEffort: typeof value.leaderEffort === 'string' ? value.leaderEffort : '', childEffort: typeof value.childEffort === 'string' ? value.childEffort : '', planImplement: value.planImplement === true } as typeof DEFAULT_CHOICE
  } catch { /* use the defaults */ }
  return DEFAULT_CHOICE
}

function CheckEditor({ checks, onChange }: { checks: ExecutionCheck[]; onChange: (checks: ExecutionCheck[]) => void }) {
  const update = (index: number, patch: Partial<ExecutionCheck>) => onChange(checks.map((check, i) => i === index ? { ...check, ...patch } : check))
  return <section className="account-card ex-checks">
    <div className="account-head"><h3>検証コマンド</h3><button type="button" className="button ghost" onClick={() => onChange([...checks, { id: nextCheckId(checks), command: '', cwd: '.', timeoutMs: 300000 }])}><Plus size={14} />追加</button></div>
    {checks.map((check, i) => <div className="ex-check" key={i}>
      <div className="ex-check-heading"><input aria-label={`検証${i + 1}のID`} placeholder="ID" value={check.id} onChange={(e) => update(i, { id: e.target.value })} />
        <button type="button" className="icon-button small" aria-label={`検証${i + 1}を削除`} onClick={() => onChange(checks.filter((_, index) => index !== i))}><Trash2 size={14} /></button></div>
      <input aria-label={`検証${i + 1}のコマンド`} placeholder="npm test" value={check.command} onChange={(e) => update(i, { command: e.target.value })} />
      <div className="ex-check-heading"><label>実行場所<input value={check.cwd ?? '.'} onChange={(e) => update(i, { cwd: e.target.value })} /></label>
        <label>制限時間（秒）<input type="number" min={1} max={1800} value={(check.timeoutMs ?? 300000) / 1000} onChange={(e) => update(i, { timeoutMs: Number(e.target.value) * 1000 })} /></label></div>
      <label><input type="checkbox" checked={check.allowSourceChanges === true} onChange={(e) => update(i, { allowSourceChanges: e.target.checked })} /> ソース変更と1回の再検証を許可</label>
      <label><input type="checkbox" checked={check.autoRepair === true} onChange={(e) => update(i, { autoRepair: e.target.checked })} /> 失敗時に子へ自動差し戻し</label>
    </div>)}
  </section>
}

function useChecks(workspace: string) {
  const [checks, setChecks] = useState<ExecutionCheck[] | null>(null)
  useEffect(() => {
    let alive = true
    void act<{ checks: ExecutionCheck[] }>('execution.checks', { workspace }).then((result) => { if (alive && result) setChecks(result.checks) })
    return () => { alive = false }
  }, [workspace])
  return [checks, setChecks] as const
}

export function ExecutionChecksDialog({ workspace, onClose }: { workspace: string; onClose: () => void }) {
  const [checks, setChecks] = useChecks(workspace)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    const result = await act('execution.configure', { workspace, checks })
    setSaving(false)
    if (result) onClose()
  }
  return <Modal title="エコモードの検証" onClose={onClose} width={600}>
    {checks ? <CheckEditor checks={checks} onChange={setChecks} /> : <p>読み込み中…</p>}
    <div className="modal-actions"><button type="button" className="button" onClick={onClose}>キャンセル</button><button type="button" className="button primary" disabled={!checks || saving} onClick={() => void save()}>保存</button></div>
  </Modal>
}

export function ExecutionStartDialog({ workspace }: { workspace: string }) {
  const server = useStore((state) => state.server)
  const [choice, setChoice] = useState(readChoice)
  const { leader, provider, model, leaderEffort, childEffort } = choice
  const latest = useRef(choice)
  const saves = useRef(Promise.resolve<unknown>(true))
  const startingRef = useRef(false)
  const [modelsReady, setModelsReady] = useState(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      const result = await act<{ models: typeof DEFAULT_CHOICE | null }>('execution.models', {})
      if (!alive || !result) return
      // Migrate browser-only preferences once, without overwriting a newer
      // selection saved from another device. This never starts a model.
      const restored = result.models ? result : await act<{ models: typeof DEFAULT_CHOICE }>('execution.setModels', { models: readChoice(), onlyIfUnset: true })
      if (!alive || !restored?.models) return
      const next = { ...DEFAULT_CHOICE, ...restored.models, planImplement: restored.models.planImplement === true }
      const levels = effortOptions(next)
      next.leaderEffort = workflowEffort(next.leaderEffort, levels.leader)
      next.childEffort = workflowEffort(next.childEffort, levels.child)
      latest.current = next
      setChoice(next)
      if (JSON.stringify(next) !== JSON.stringify(restored.models)) saves.current = saves.current.then(() => act('execution.setModels', { models: next }))
      setModelsReady(true)
    })()
    return () => { alive = false }
  }, [])
  const changeModels = (patch: Partial<typeof DEFAULT_CHOICE>) => {
    const next = { ...latest.current, ...patch }
    const levels = effortOptions(next)
    next.leaderEffort = workflowEffort(next.leaderEffort, levels.leader, next.leader !== latest.current.leader)
    next.childEffort = workflowEffort(next.childEffort, levels.child, next.model !== latest.current.model || next.provider !== latest.current.provider)
    latest.current = next
    setChoice(next)
    try { localStorage.setItem(CHOICE_KEY, JSON.stringify(next)) } catch { /* server persistence remains available */ }
    saves.current = saves.current.then(() => act('execution.setModels', { models: next }))
  }
  const [checks, setChecks] = useChecks(workspace)
  const [auth, setAuth] = useState<AuthConsentState>({ ready: false })
  const [starting, setStarting] = useState(false)
  const close = () => setState({ executionStart: null })
  const effortOptions = (value: typeof DEFAULT_CHOICE) => {
    const levels = (model: string) => server && model ? workflowLevels(server.catalog, model) : []
    const selected = server ? executionModelSelection(server, value.provider, value.leader, value.model) : null
    const child = value.provider === 'claude' ? (selected?.model ? `claude:${selected.model}` : '') : selected?.childModels.find((entry) => entry.id === selected.model)?.value ?? ''
    return { leader: levels(selected?.leader ?? ''), child: levels(child) }
  }
  const levels = effortOptions(choice)
  const selection = server ? executionModelSelection(server, provider, leader, model) : null
  useEffect(() => {
    if (!modelsReady || !selection) return
    if ((leader && !selection.leader) || (model && !selection.model) || leaderEffort !== workflowEffort(leaderEffort, levels.leader) || childEffort !== workflowEffort(childEffort, levels.child)) {
      changeModels({ leader: selection.leader, model: selection.model })
    }
  }, [modelsReady, selection?.leader, selection?.model, leader, model, leaderEffort, childEffort, levels.leader?.join(), levels.child?.join()])
  if (!server?.settings.agentTeams || !selection) return null
  const groups = modelGroups(server)
  const leaderGroups = groups.map((group) => ({
    ...group,
    models: group.models.filter((entry) => (group.id === 'claude-code' && /^claude:(?:claude-)?(?:opus|sonnet)(?:-|$)/i.test(entry.value)) || selection.leaderModels.some((model) => model.value === entry.value)),
  })).filter((group) => group.models.length)
  const childValue = provider === 'claude' ? (selection.model ? `claude:${selection.model}` : '') : selection.childModels.find((entry) => entry.id === selection.model)?.value ?? ''
  const usesClaude = modelsReady && (selection.leader.startsWith('claude:') || provider === 'claude')
  const start = async () => {
    const current = { ...latest.current }
    const currentLevels = effortOptions(current)
    if (startingRef.current || !modelsReady || !checks || !selection.leader || !selection.model
      || !workflowEffortSupported(current.leaderEffort, currentLevels.leader) || !workflowEffortSupported(current.childEffort, currentLevels.child)
      || (usesClaude && !auth.ready)) return
    startingRef.current = true
    setStarting(true)
    try {
      if (!await saves.current) return
      const { leader, provider, model, leaderEffort, childEffort } = current
      if (!await act('execution.configure', { workspace, checks })) return
      const choices = structuredClone(server.settings.agentTeams!) as TeamSettings
      for (const item of providers) choices[item.id] = { enabled: item.id === provider, low: { enabled: true, model: item.id === provider ? model : null, effort: item.id === provider ? childEffort || null : null }, mid: { enabled: false, model: null, effort: null } }
      choices.leaderProvider = leader.startsWith('claude:') ? 'claude' : 'gpt'
      choices.leader = { model: leader.startsWith('claude:') ? leader.slice(7) : 'opus', effort: leaderEffort || null }
      choices.gptLeader = { model: null, effort: leaderEffort || null }
      choices.toolMode = current.toolMode
      choices.leanChildren = false
      choices.batchReports = true
      choices.maxChildren = 6
      choices.policy = null
      if (await startTeam(workspace, choices, usesClaude ? auth.confirmation : undefined, { ...(leader.startsWith('claude:') ? {} : { leaderModel: leader }), planImplement: current.planImplement })) {
        close()
      }
    } finally { startingRef.current = false; setStarting(false) }
  }

  return <Modal title="エコモード" onClose={close} width={620} className="team-start-modal">
    <div className="team-start-body">
      <section className="account-card ex-models">
        <ModelField label="親" value={modelsReady ? selection.leader : ''} groups={leaderGroups} disabled={!modelsReady || starting}
          effort={leaderEffort} efforts={workflowOptions(leaderEffort, levels.leader)} onEffort={(leaderEffort) => changeModels({ leaderEffort })}
          allowClearUnavailableEffort onChange={(leader) => changeModels({ leader })} />
        <ModelField label="子" value={modelsReady ? childValue : ''} groups={groups} disabled={!modelsReady || starting}
          effort={childEffort} efforts={workflowOptions(childEffort, levels.child)} onEffort={(childEffort) => changeModels({ childEffort })}
          allowClearUnavailableEffort onChange={(value) => { const child = executionChildChoice(server, value); if (child) changeModels(child) }} />
      </section>
      <div className="ex-options">
        <PtcToggle mode={choice.toolMode} disabled={!modelsReady || starting} onChange={(toolMode) => changeModels({ toolMode })} />
        <button type="button" className={`chip plan-implement-chip ${choice.planImplement ? 'on' : ''}`} aria-label="計画 → 実装" aria-pressed={choice.planImplement}
          title="親が計画、子が実装。親が最大1回レビューし、必要なら同じ子が最終修正" disabled={!modelsReady || starting}
          onClick={() => changeModels({ planImplement: !latest.current.planImplement })}>計画 → 実装 {choice.planImplement ? 'ON' : 'OFF'}</button>
      </div>
      {checks ? <CheckEditor checks={checks} onChange={setChecks} /> : <p>検証設定を読み込み中…</p>}
      {usesClaude && <ClaudeAuthConsent workspace={workspace} onChange={setAuth} />}
    </div>
    <div className="modal-actions"><button type="button" className="button" onClick={close}>キャンセル</button><button type="button" className="button primary" disabled={starting || !modelsReady || !checks || !selection.leader || !selection.model || !workflowEffortSupported(leaderEffort, levels.leader) || !workflowEffortSupported(childEffort, levels.child) || (usesClaude && !auth.ready)} onClick={() => void start()}>始める</button></div>
  </Modal>
}
