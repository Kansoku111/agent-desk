import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { act, setState, startTeam, useStore } from '../store'
import type { ExecutionCheck, TeamProvider, TeamSettings } from '../types'
import { executionModelSelection } from '../model-selection'
import { Modal } from './Modal'
import { ClaudeAuthConsent } from './ClaudeAuthConsent'
import type { AuthConsentState } from '../team-auth-consent'

const providers: { id: TeamProvider; name: string; catalog?: string }[] = [
  { id: 'claude', name: 'Claude Code' }, { id: 'claudeApi', name: 'Claude（API）', catalog: 'anthropic' },
  { id: 'gpt', name: 'GPT', catalog: 'openai-codex' }, { id: 'deepseek', name: 'DeepSeek', catalog: 'deepseek-official' },
  { id: 'opencodeGo', name: 'OpenCode Go', catalog: 'opencode-go' }, { id: 'local', name: 'ローカル LLM', catalog: 'local-llm' },
]

const CHOICE_KEY = 'agent-desk.execution-models'
const DEFAULT_CHOICE = { leader: 'claude:opus', provider: 'claude' as TeamProvider, model: 'haiku' }
function readChoice() {
  try {
    const value = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null')
    if (typeof value?.leader === 'string' && providers.some((entry) => entry.id === value.provider) && typeof value.model === 'string') return value as typeof DEFAULT_CHOICE
  } catch { /* use the defaults */ }
  return DEFAULT_CHOICE
}

function CheckEditor({ checks, onChange }: { checks: ExecutionCheck[]; onChange: (checks: ExecutionCheck[]) => void }) {
  const update = (index: number, patch: Partial<ExecutionCheck>) => onChange(checks.map((check, i) => i === index ? { ...check, ...patch } : check))
  return <section className="account-card ex-checks">
    <div className="account-head"><h3>検証コマンド</h3><button type="button" className="button ghost" onClick={() => onChange([...checks, { id: `check-${checks.length + 1}`, command: '', cwd: '.', timeoutMs: 300000 }])}><Plus size={14} />追加</button></div>
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
  const { leader, provider, model } = choice
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
      setChoice(restored.models)
      setModelsReady(true)
    })()
    return () => { alive = false }
  }, [])
  const changeModels = (patch: Partial<typeof DEFAULT_CHOICE>) => {
    const next = { ...choice, ...patch }
    setChoice(next)
    try { localStorage.setItem(CHOICE_KEY, JSON.stringify(next)) } catch { /* server persistence remains available */ }
    void act('execution.setModels', { models: next })
  }
  const [checks, setChecks] = useChecks(workspace)
  const [auth, setAuth] = useState<AuthConsentState>({ ready: false })
  const [starting, setStarting] = useState(false)
  const close = () => setState({ executionStart: null })
  const selection = server ? executionModelSelection(server, provider, leader, model) : null
  useEffect(() => {
    if (!modelsReady || !selection) return
    if ((leader && !selection.leader) || (model && !selection.model)) {
      setChoice((current) => ({ ...current, leader: selection.leader, model: selection.model }))
    }
  }, [modelsReady, selection?.leader, selection?.model, leader, model])
  if (!server?.settings.agentTeams || !selection) return null
  const { leaderModels, childModels } = selection
  const usesClaude = modelsReady && (selection.leader.startsWith('claude:') || provider === 'claude')
  const start = async () => {
    if (!modelsReady || !checks || !selection.leader || !selection.model || (usesClaude && !auth.ready)) return
    setStarting(true)
    try {
      if (!await act('execution.configure', { workspace, checks })) return
      const choices = structuredClone(server.settings.agentTeams!) as TeamSettings
      for (const item of providers) choices[item.id] = { enabled: item.id === provider, low: { enabled: true, model: item.id === provider ? model : null, effort: null }, mid: { enabled: false, model: null, effort: null } }
      choices.leaderProvider = leader.startsWith('claude:') ? 'claude' : 'gpt'
      choices.leader = { model: leader.startsWith('claude:') ? leader.slice(7) : 'opus', effort: null }
      choices.gptLeader = { model: null, effort: null }
      choices.leanChildren = true
      choices.batchReports = true
      choices.maxChildren = 6
      choices.policy = null
      if (await startTeam(workspace, choices, usesClaude ? auth.confirmation : undefined, leader.startsWith('claude:') ? {} : { leaderModel: leader })) {
        close()
      }
    } finally { setStarting(false) }
  }
  return <Modal title="エコモード" onClose={close} width={620} className="team-start-modal">
    <div className="team-start-body">
      <section className="account-card ex-models">
        <label>親<select disabled={!modelsReady || starting} value={modelsReady ? selection.leader : ''} onChange={(e) => changeModels({ leader: e.target.value })}>
          <option value="">モデルを選択</option>
          <optgroup label="Claude Code"><option value="claude:opus">Opus</option><option value="claude:sonnet">Sonnet</option></optgroup>
          <optgroup label="API / サブスクリプション">{leaderModels.map((entry) => <option key={entry.value} value={entry.value}>{entry.name} · {entry.provider === 'anthropic' ? 'API' : 'ChatGPT'}</option>)}</optgroup>
        </select></label>
        <label>子<select disabled={!modelsReady || starting} value={provider} onChange={(e) => changeModels({ provider: e.target.value as TeamProvider, model: e.target.value === 'claude' ? 'haiku' : '' })}>
          {providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        <label>子のモデル<select disabled={!modelsReady || starting} value={modelsReady ? selection.model : ''} onChange={(e) => changeModels({ model: e.target.value })}>
          <option value="">モデルを選択</option>
          {provider === 'claude' ? <><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></> : <>{childModels.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</>}
        </select></label>
      </section>
      {checks ? <CheckEditor checks={checks} onChange={setChecks} /> : <p>検証設定を読み込み中…</p>}
      {usesClaude && <ClaudeAuthConsent workspace={workspace} onChange={setAuth} />}
    </div>
    <div className="modal-actions"><button type="button" className="button" onClick={close}>キャンセル</button><button type="button" className="button primary" disabled={starting || !modelsReady || !checks || !selection.leader || !selection.model || (usesClaude && !auth.ready)} onClick={() => void start()}>始める</button></div>
  </Modal>
}
