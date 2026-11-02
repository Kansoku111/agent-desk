import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Paperclip, X } from 'lucide-react'
import { act, isImageAttachment, isTouch, setState, toast, uploadAttachment, useStore } from '../store'
import type { Attachment, TeamSummary, Turn } from '../types'
import { workflowLevels } from '../../../shared/workflow-effort.js'
import { ClaudeAuthConsent } from './ClaudeAuthConsent'
import type { AuthConsentState } from '../team-auth-consent'
import { Modal } from './Modal'
import { ModelField, modelGroups } from './WorkflowModelField'
import { TurnView } from './TurnView'
import { useConversationScroll } from './useConversationScroll'

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
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
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
  // 開くたびに最新の発言から読めるよう、読み込み後は末尾へ追従する。
  const { scroller, onScroll } = useConversationScroll('observer:' + team.id, segments.length > 0, [segments, threadTurns, agentTurns])
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
  const addFiles = async (files: File[]) => {
    if (sending) return
    const images = files.filter((file) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))
    if (images.length !== files.length) toast('観測者には PNG、JPEG、GIF、WebP 画像のみ添付できます', 'error')
    if (!images.length) return
    setUploading((count) => count + 1)
    try {
      for (const file of images) {
        const saved = await uploadAttachment(file)
        if (saved && isImageAttachment(saved)) setAttachments((list) => [...list, saved])
      }
    } finally { setUploading((count) => count - 1) }
  }
  const canSend = Boolean(choice && available && effortValid && (text.trim() || attachments.length) && !uploading && !saving && !sending && !running && (!claude || auth.ready))
  const submit = async () => {
    if (!choice || !canSend) return
    setSending(true)
    const result = await act('team.observerMessage', { teamId: team.id, model: choice.model, effort: choice.effort, text: text.trim(), images: attachments.map(({ file, mimeType, name }) => ({ file, mimeType, name })), ...(claude && auth.confirmation ? { authConfirmation: auth.confirmation } : {}) })
    setSending(false)
    if (result) { setText(''); setAttachments([]); await load() }
    else if (claude) { setAuth({ ready: false }); setAuthRevision((n) => n + 1) }
  }
  return <Modal title="観測者" onClose={onClose} width={680} className="observer-modal">
    <div className="observer-chat" ref={scroller} onScroll={onScroll}>
      {segments.map((segment) => ((segment.kind === 'thread' ? threadTurns[segment.id] : agentTurns[segment.id]) ?? segment.turns).map((turn) =>
        <TurnView key={segment.id + turn.id} turn={turn} workspace={team.workspace} threadId={segment.id} threadBusy={false} undoable={false} />))}
    </div>
    <div className="observer-compose" onDragOver={(event) => {
      if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); setDragging(true) }
    }} onDragLeave={() => setDragging(false)} onDrop={(event) => {
      event.preventDefault(); setDragging(false); void addFiles([...event.dataTransfer.files])
    }}>
      <ModelField label="モデル" value={choice?.model ?? ''} groups={groups} disabled={saving || sending || running}
        effort={choice?.effort ?? ''} efforts={levels} allowDefaultEffort allowClearUnavailableEffort
        onChange={(model) => void select({ model, effort: null })}
        onEffort={(effort) => { if (choice) void select({ ...choice, effort: effort || null }) }} />
      {choice && !available && <p role="alert" className="team-warning">保存されたモデルは利用できません。選び直してください。</p>}
      {!effortValid && <p role="alert" className="team-warning">推論レベルを選び直してください。</p>}
      {claude && <ClaudeAuthConsent key={authRevision} workspace={team.workspace} teamId={team.id} observer onChange={setAuth} />}
      {(attachments.length > 0 || uploading > 0) && <div className="attachments">
        {attachments.map((attachment) => <div key={attachment.file} className="attachment" title={attachment.name}>
          <img src={attachment.previewUrl} alt={attachment.name || '添付画像'} />
          <button type="button" className="attachment-remove" aria-label="添付を外す" disabled={sending} onClick={() => setAttachments((list) => list.filter((entry) => entry.file !== attachment.file))}><X size={12} /></button>
        </div>)}
        {uploading > 0 && <div className="attachment loading"><Loader2 size={16} className="spin" /></div>}
      </div>}
      <textarea aria-label="観測者へのメッセージ" value={text} disabled={sending} onChange={(event) => setText(event.target.value)} onPaste={(event) => {
        const files = [...event.clipboardData.files]
        if (files.length) { event.preventDefault(); void addFiles(files) }
      }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter' && !event.shiftKey && !isTouch()) { event.preventDefault(); void submit() }
      }} />
      <div className="composer-bar">
        <button type="button" className="icon-button" title="画像を添付" aria-label="画像を添付" disabled={sending} onClick={() => fileInput.current?.click()}><Paperclip size={16} /></button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => {
          void addFiles([...(event.target.files ?? [])]); event.target.value = ''
        }} />
        <button type="button" className="button primary" disabled={!canSend} onClick={() => void submit()}>送信</button>
      </div>
      {dragging && <div>ドロップして画像を添付</div>}
    </div>
  </Modal>
}
