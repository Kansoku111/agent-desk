import { useCallback, useEffect, useRef, useState } from 'react'
import { act, setState, useStore } from '../store'
import type { TeamSummary, Turn } from '../types'
import { workflowLevels } from '../../../shared/workflow-effort.js'
import { ClaudeAuthConsent } from './ClaudeAuthConsent'
import type { AuthConsentState } from '../team-auth-consent'
import { Modal } from './Modal'
import { ModelField, modelGroups } from './WorkflowModelField'
import { TurnView } from './TurnView'

type Segment = { id: string; kind: 'thread' | 'agent'; turns: Turn[] }
type Choice = { model: string; effort: string | null }

export function ObserverChat({ team, onClose }: { team: TeamSummary; onClose: () => void }) {
  const server = useStore((state) => state.server)
  const threadTurns = useStore((state) => state.turns)
  const agentTurns = useStore((state) => state.agentTurns)
  const [choice, setChoice] = useState<Choice | null>(() => server?.settings.observerModel ?? null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [auth, setAuth] = useState<AuthConsentState>({ ready: false })
  const [authRevision, setAuthRevision] = useState(0)
  const loadRevision = useRef(0)
  const load = useCallback(async () => {
    const revision = ++loadRevision.current
    const result = await act<{ segments: Segment[]; running: boolean }>('team.observerTurns', { teamId: team.id })
    if (!result || revision !== loadRevision.current) return
    setSegments(result.segments)
    setState((current) => {
      const turns = { ...current.turns }, agents = { ...current.agentTurns }
      for (const segment of result.segments) {
        const previous = segment.kind === 'thread' ? turns[segment.id] : agents[segment.id]
        const byId = new Map(previous?.map((turn) => [turn.id, turn]) ?? [])
        const merged = segment.turns.map((turn) => byId.get(turn.id) ?? turn)
        const seen = new Set(merged.map((turn) => turn.id))
        merged.push(...(previous ?? []).filter((turn) => !seen.has(turn.id)))
        if (segment.kind === 'thread') turns[segment.id] = merged
        else agents[segment.id] = merged
      }
      return { turns, agentTurns: agents }
    })
  }, [team.id])
  useEffect(() => { void load(); return () => { loadRevision.current++ } }, [load, team.observer?.id])
  if (!server) return null
  const groups = modelGroups(server)
  const available = Boolean(choice && groups.some((group) => group.models.some((model) => model.value === choice.model)))
  const claude = Boolean(choice?.model.startsWith('claude:'))
  const levels = choice ? workflowLevels(server.catalog, choice.model) ?? ['low', 'medium', 'high'] : []
  const effortValid = !choice?.effort || levels.includes(choice.effort)
  const running = Boolean(team.observer?.running)
  const select = async (next: Choice) => {
    setChoice(next); setSaving(true)
    const result = await act('settings.update', { patch: { observerModel: next } })
    setSaving(false)
    if (!result) setChoice(server.settings.observerModel ?? null)
  }
  const submit = async () => {
    if (!choice || !available || !effortValid || !text.trim() || saving || sending || running || (claude && !auth.ready)) return
    setSending(true)
    const body = text.trim()
    const result = await act('team.observerMessage', { teamId: team.id, model: choice.model, effort: choice.effort, text: body, ...(claude && auth.confirmation ? { authConfirmation: auth.confirmation } : {}) })
    setSending(false)
    if (result) { setText(''); await load() }
    else if (claude) { setAuth({ ready: false }); setAuthRevision((n) => n + 1) }
  }
  return <Modal title="観測者" onClose={onClose} width={680} className="observer-modal">
    <div className="observer-chat">
      {segments.map((segment) => ((segment.kind === 'thread' ? threadTurns[segment.id] : agentTurns[segment.id]) ?? segment.turns).map((turn) =>
        <TurnView key={segment.id + turn.id} turn={turn} workspace={team.workspace} threadId={segment.id} threadBusy={false} undoable={false} />))}
    </div>
    <div className="observer-compose">
      <ModelField label="モデル" value={choice?.model ?? ''} groups={groups} disabled={saving || sending || running}
        effort={choice?.effort ?? ''} efforts={levels} allowDefaultEffort allowClearUnavailableEffort
        onChange={(model) => void select({ model, effort: null })}
        onEffort={(effort) => { if (choice) void select({ ...choice, effort: effort || null }) }} />
      {choice && !available && <p role="alert" className="team-warning">保存されたモデルは利用できません。選び直してください。</p>}
      {!effortValid && <p role="alert" className="team-warning">推論レベルを選び直してください。</p>}
      {claude && <ClaudeAuthConsent key={authRevision} workspace={team.workspace} teamId={team.id} observer onChange={setAuth} />}
      <textarea aria-label="観測者へのメッセージ" value={text} disabled={sending} onChange={(event) => setText(event.target.value)} />
      <button type="button" className="button primary" disabled={!text.trim() || !available || !effortValid || saving || sending || running || (claude && !auth.ready)} onClick={() => void submit()}>送信</button>
    </div>
  </Modal>
}
