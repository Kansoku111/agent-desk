import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, FolderOpen, Loader2, PanelLeftOpen, Paperclip, Square, X } from 'lucide-react'
import { act, isImageAttachment, isNarrow, isTouch, loadCodexPermissions, request, setState, toast, uploadAttachment, upsertCodexTask, useStore } from '../store'
import type { Attachment, CodexTaskSummary } from '../types'
import { getDraft, useDraft, useImeField } from '../drafts'
import { workspaceLabel } from '../util'
import { TurnView } from './TurnView'
import { CodexModelPicker } from './CodexModelPicker'
import { OpenInMenu } from './ThreadView'
import { TeamPanel, TeamToggle } from './TeamPanel'
import { TaskPresetRuns, TaskPresetToggle } from './TaskPresets'
import { useConversationScroll } from './useConversationScroll'

export function CodexView({ taskId }: { taskId: string }) {
  const task = useStore((state) => state.server?.codexTasks?.find((entry) => entry.id === taskId))
  const turns = useStore((state) => state.codexTurns[taskId])
  const permissions = useStore((state) => state.codexPermissions[taskId])
  const initialModels = useStore((state) => state.server?.codexModels)
  const sidebarOpen = useStore((state) => state.sidebarOpen)
  const team = useStore((state) => state.server?.teams?.find((entry) => entry.leaderId === taskId || entry.children.some((child) => child.kind === 'codex' && child.taskId === taskId)))
  const teamPanel = useStore((state) => state.teamPanel)
  const myPc = useStore((state) => state.server?.app.myPc)
  const names = useStore((state) => state.server?.settings.projectNames)
  const draftKey = `codex:${taskId}`
  const [text, setText] = useDraft(draftKey)
  const ime = useImeField()
  const [images, setImages] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [presetOpen, setPresetOpen] = useState(() => !isNarrow())
  const [uploading, setUploading] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const { scroller, stick, showJump, onScroll } = useConversationScroll(taskId, Boolean(task), turns)
  useEffect(() => { void request('codex.models').catch(() => {}) }, [])
  const choices = initialModels ?? []
  if (!task) return <div className="main-empty">タスクが見つかりません</div>
  const working = task.status === 'running'
  const teamChild = team?.children.find((entry) => entry.kind === 'codex' && entry.taskId === taskId)
  const update = async (patch: Partial<CodexTaskSummary>) => {
    const result = await act<{ task: CodexTaskSummary }>('codex.task.update', { taskId, ...patch })
    if (result) upsertCodexTask(result.task)
    return Boolean(result)
  }
  const send = async () => {
    const sentText = getDraft(draftKey), sentImages = images
    if (busy || uploading || (!sentText.trim() && !sentImages.length)) return
    setBusy(true)
    const child = team?.children.find((entry) => entry.kind === 'codex' && entry.taskId === taskId)
    const result = child
      ? await act('team.message', { teamId: team!.id, childId: child.id, text: sentText.trim(), images: sentImages.map(({ file, mimeType, name }) => ({ file, mimeType, name })) })
      : await act('codex.task.send', { taskId, text: sentText.trim(), images: sentImages.map(({ file, mimeType, name }) => ({ file, mimeType, name })) })
    setBusy(false)
    if (result) { if (getDraft(draftKey) === sentText) setText(''); setImages((current) => current === sentImages ? [] : current); stick.current = true }
  }
  const addFiles = async (files: File[]) => {
    if (teamChild) return
    setUploading(true)
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { toast('画像を選択してください', 'error'); continue }
      const saved = await uploadAttachment(file)
      if (saved && isImageAttachment(saved)) setImages((current) => [...current, saved])
    }
    setUploading(false)
  }
  return <div className="thread-view terminal-view agent-view">
    <header className="main-header"><div className="header-left">
      {!sidebarOpen && <button type="button" className="icon-button" aria-label="サイドバーを開く" onClick={() => setState({ sidebarOpen: true })}><PanelLeftOpen size={16} /></button>}
      <span className="cl-mark">GP</span><h1 className="thread-heading" title={task.title}>{task.title}</h1>
      <span className="header-chip" title={task.workspace}><FolderOpen size={13} />{workspaceLabel(task.workspace, myPc, names)}</span>
    </div><div className="header-right">
      {team && <TeamToggle team={team} />}
      <TaskPresetToggle source={{ kind: 'codex', id: taskId }} open={presetOpen} onToggle={() => setPresetOpen((open) => !open)} />
      {working && <button type="button" className="button ghost" onClick={() => void (teamChild ? act('team.stopChild', { teamId: team!.id, childId: teamChild.id }) : act('codex.task.stop', { taskId }))}><Square size={13} /> 停止</button>}
      <OpenInMenu workspace={task.workspace} task={!task.team && !team && !task.ab ? { kind: 'codex', id: taskId } : undefined} />
    </div></header>
    <div className="thread-body"><div className="thread-main"><div className="terminal-chat">
      <div className="scroller" ref={scroller} onScroll={onScroll}><div className="column">
        {!turns && <div className="loading-turns"><Loader2 size={14} className="spin" /> 読み込み中…</div>}
        {turns?.map((turn) => <TurnView key={turn.id} turn={turn} workspace={task.workspace} threadId={taskId} threadBusy={false} undoable={false} />)}
        {permissions?.map((permission) => <div className="approval-card" key={permission.requestId} role="alertdialog" aria-label="実行の承認">
          <div className="approval-head">{permission.title}</div>{permission.details && <pre className="approval-command">{permission.details}</pre>}
          <div className="approval-actions">{(['accept', 'decline', 'cancel'] as const).map((decision) => <button type="button" className={decision === 'accept' ? 'button primary' : 'button'} key={decision} onClick={async () => {
            const result = await act('codex.task.respond', { taskId, requestId: permission.requestId, decision })
            if (result) void loadCodexPermissions(taskId)
          }}>{decision === 'accept' ? '許可' : decision === 'decline' ? '拒否' : 'キャンセル'}</button>)}</div>
        </div>)}
      </div></div>
      {showJump && <button type="button" className="jump terminal-chat-jump" aria-label="最新へ移動" onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })}><ArrowDown size={15} /></button>}
    </div><div className="composer">
      {images.length > 0 && <div className="attachments">{images.map((image) => <div className="attachment" key={image.file}><img src={image.previewUrl} alt={image.name} /><button type="button" className="attachment-remove" aria-label="添付を外す" onClick={() => setImages((current) => current.filter((entry) => entry.file !== image.file))}><X size={12} /></button></div>)}</div>}
      <textarea {...ime.fieldProps} rows={2} value={text} aria-label="メッセージ" placeholder={working ? '追加指示を入力…' : 'メッセージを入力…'} onChange={(event) => setText(event.target.value)} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void addFiles([...event.clipboardData.files]) } }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && !isTouch()) { event.preventDefault(); void send() } }} />
      <div className="composer-bar"><div className="composer-left">
        <button type="button" className="icon-button" aria-label="画像を添付" disabled={Boolean(teamChild)} onClick={() => input.current?.click()}><Paperclip size={16} /></button><input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => { void addFiles([...event.target.files ?? []]); event.target.value = '' }} />
        <CodexModelPicker task={task} models={choices} disabled={working || Boolean(task.team || team || task.ab)} onChange={update} />
        <select aria-label="権限" value={task.permissionMode} disabled={working || Boolean(task.team || team || task.ab)} onChange={(event) => void update({ permissionMode: event.target.value as CodexTaskSummary['permissionMode'] })}><option value="read-only">読み取りのみ</option><option value="workspace-write">ワークスペース編集</option><option value="danger-full-access">フルアクセス</option></select>
      </div><div className="composer-right"><button type="button" className="send-button" title={working ? '追加指示を送信' : '送信'} aria-label={working ? '追加指示を送信' : '送信'} disabled={busy || uploading || (!text.trim() && !images.length)} onPointerDown={(event) => { event.preventDefault(); ime.confirm() }} onClick={() => void send()}><ArrowUp size={17} /></button></div></div>
    </div></div>{team && teamPanel && <TeamPanel team={team} />}{presetOpen && <TaskPresetRuns source={{ kind: 'codex', id: taskId }} onClose={() => setPresetOpen(false)} />}</div>
  </div>
}
