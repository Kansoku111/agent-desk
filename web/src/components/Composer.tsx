import { memo, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { ArrowUp, Clock3, CornerDownRight, FileText, Loader2, Paperclip, Square, X } from 'lucide-react'
import { act, isImageAttachment, isTouch, removeQueued, retryQueued, sendMessage, setState, startThread, steerQueued, uploadAttachment, useStore } from '../store'
import type { Attachment, PermissionMode, ThreadSummary } from '../types'
import { formatTokens } from '../util'
import { EffortPicker, FastModeChip, ModelPicker, PermissionPicker } from './Pickers'
import { ChatGptLimitChip } from './ChatGptUsage'

// Unsent text survives switching between threads.
const drafts = new Map<string, string>()

function UsageRing({ used, size }: { used: number; size: number }) {
  const ratio = Math.min(1, size ? used / size : 0)
  const radius = 7
  const circumference = 2 * Math.PI * radius
  return (
    <span className="usage" title={`コンテキスト ${used.toLocaleString()} / ${size.toLocaleString()} トークン`}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={radius} className="usage-track" />
        <circle
          cx="9"
          cy="9"
          r={radius}
          className={`usage-fill ${ratio > 0.85 ? 'high' : ''}`}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      <span className="usage-text">{formatTokens(used)}</span>
    </span>
  )
}

export const Composer = memo(function Composer({ thread, autoFocus }: { thread?: ThreadSummary; autoFocus?: boolean }) {
  const key = thread?.id ?? 'new'
  const draft = useStore((state) => state.draft)
  const queued = useStore((state) => (thread ? state.queued[thread.id] : undefined)) ?? []
  const [text, setText] = useState(() => drafts.get(key) ?? '')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [sending, setSending] = useState(false)
  const [plan, setPlan] = useState(false)
  const [changingToolMode, setChangingToolMode] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setText(drafts.get(key) ?? '')
    setAttachments([])
    // On a phone, focusing would pop the keyboard over the page.
    if (autoFocus && !isTouch()) input.current?.focus()
  }, [key, autoFocus])

  useEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  const running = thread?.status === 'running'
  const model = thread ? thread.model : draft.model
  const effort = thread ? thread.effort : draft.effort
  const permissionMode = thread ? thread.permissionMode : draft.permissionMode
  const toolMode = (thread ? thread.toolMode : draft.toolMode) ?? 'native'
  const ptcAvailable = !thread?.ab && !thread?.team
  const canSend = (text.trim().length > 0 || attachments.length > 0) && uploading === 0 && !sending && !changingToolMode && Boolean(model)

  const updateText = (value: string) => {
    setText(value)
    drafts.set(key, value)
  }

  const addFiles = async (files: File[]) => {
    for (const file of files) {
      setUploading((count) => count + 1)
      const saved = await uploadAttachment(file)
      setUploading((count) => count - 1)
      if (saved) setAttachments((list) => [...list, saved])
    }
  }

  const submit = async () => {
    if (!canSend) return
    const sentText = text
    const sentAttachments = attachments
    setSending(true)
    const ok = thread
      ? await sendMessage(thread.id, text.trim(), attachments, plan)
      : await startThread(text.trim(), attachments, plan)
    setSending(false)
    if (ok) {
      // What was typed or attached while the message was on its way is the next one.
      if ((drafts.get(key) ?? '') === sentText) {
        updateText('')
        drafts.delete(key)
      }
      setAttachments((list) => (list === sentAttachments ? [] : list))
      // A phone puts the keyboard away so the answer has the screen.
      if (isTouch()) input.current?.blur()
      else input.current?.focus()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Never send while an IME is composing (Japanese input confirms with Enter).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    // A touch keyboard's Enter makes a new line; the send button sends.
    if (event.key === 'Enter' && !event.shiftKey && !isTouch()) {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape' && running && thread) {
      event.preventDefault()
      void act('thread.cancel', { threadId: thread.id })
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files]
    if (files.length) {
      event.preventDefault()
      void addFiles(files)
    }
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    void addFiles([...event.dataTransfer.files])
  }

  const setModel = (value: string) => thread
    ? void act('thread.update', { threadId: thread.id, model: value })
    : setState((state) => ({ draft: { ...state.draft, model: value } }))
  const setEffort = (value: string) => thread
    ? void act('thread.update', { threadId: thread.id, effort: value })
    : setState((state) => ({ draft: { ...state.draft, effort: value } }))
  const setMode = (value: PermissionMode) => thread
    ? void act('thread.update', { threadId: thread.id, permissionMode: value })
    : setState((state) => ({ draft: { ...state.draft, permissionMode: value } }))

  return (
    <div
      className={`composer ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes('Files')) {
          event.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {queued.length > 0 && (
        <div className="queued">
          {queued.map((message, index) => (
            <div key={message.id} className="queued-item">
              <Clock3 size={13} />
              {message.plan && <span className="badge">Plan</span>}
              <span className="queued-text">{message.text || `添付 ${message.images.length} 件`}</span>
              <span className="queued-note" title={message.error}>
                {message.phase === 'sending' ? '受領確認待ち' : message.phase === 'uncertain' ? '送信結果不明・自動再送しません' : message.phase === 'failed' ? '送信を保留中' : thread?.status === 'error' ? '次の送信後に送ります' : '作業が終わったら送信'}
              </span>
              {message.phase !== 'queued' && (
                <button type="button" className="steer-button" onClick={() => void retryQueued(thread!.id, index)}>
                  {message.phase === 'failed' ? '再試行' : '受領を確認'}
                </button>
              )}
              {thread?.status === 'running' && message.phase === 'queued' && !message.plan && (
                <button
                  type="button"
                  className="steer-button"
                  title="作業中のエージェントに今すぐ送ります（次のステップで読みます）"
                  onClick={() => void steerQueued(thread.id, index)}
                >
                  <CornerDownRight size={13} />
                  割り込む
                </button>
              )}
              <button type="button" className="icon-button small" disabled={message.phase === 'sending'} aria-label={message.phase === 'uncertain' ? '一覧から外す（送信は取り消せません）' : '送信待ちを取り消す'} onClick={() => removeQueued(thread!.id, index)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {(attachments.length > 0 || uploading > 0) && (
        <div className="attachments">
          {attachments.map((attachment) => (
            <div key={attachment.file} className={`attachment ${isImageAttachment(attachment) ? '' : 'file'}`} title={attachment.name}>
              {isImageAttachment(attachment)
                ? <img src={attachment.previewUrl} alt={attachment.name || '添付画像'} />
                : <><FileText size={18} /><span className="attachment-name">{attachment.name || 'ファイル'}</span></>}
              <button
                type="button"
                className="attachment-remove"
                aria-label="添付を外す"
                onClick={() => setAttachments((list) => list.filter((entry) => entry.file !== attachment.file))}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {uploading > 0 && <div className="attachment loading"><Loader2 size={16} className="spin" /></div>}
        </div>
      )}
      <textarea
        ref={input}
        rows={1}
        value={text}
        placeholder={running ? 'フォローアップを入力（作業が終わったら送信します）' : thread ? '返信を入力…' : 'エージェントに依頼する内容を入力…'}
        onChange={(event) => updateText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        aria-label="メッセージ"
      />
      <div className="composer-bar">
        <div className="composer-left">
          <button type="button" className="icon-button" title="ファイルを添付" aria-label="ファイルを添付" onClick={() => fileInput.current?.click()}>
            <Paperclip size={16} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void addFiles([...(event.target.files ?? [])])
              event.target.value = ''
            }}
          />
          <ModelPicker value={model} onChange={setModel} />
          <EffortPicker model={model} value={effort} onChange={setEffort} />
          <FastModeChip model={model} />
          <PermissionPicker value={permissionMode} onChange={setMode} existing={Boolean(thread?.sessionId)} disabled={running} />
          {!thread?.ab && (
            <button type="button" className={`chip ptc-chip ${plan ? 'on' : ''}`}
              aria-label="Plan" aria-pressed={plan} disabled={sending}
              title="Plan: この設定で送信するメッセージはファイル編集を禁止します"
              onClick={() => setPlan((value) => !value)}>
              Plan {plan ? 'ON' : 'OFF'}
            </button>
          )}
          {ptcAvailable && (
            <button
              type="button"
              className={`chip ptc-chip ${toolMode === 'ptc' ? 'on' : ''}`}
              aria-label="PTC"
              aria-pressed={toolMode === 'ptc'}
              disabled={running || sending || changingToolMode}
              title={`PTC: ${toolMode === 'ptc' ? 'オン' : 'オフ'}（次の送信から適用）`}
              onClick={async () => {
                const value = toolMode === 'ptc' ? 'native' : 'ptc'
                if (!thread) {
                  setState((state) => ({ draft: { ...state.draft, toolMode: value } }))
                  return
                }
                setChangingToolMode(true)
                await act('thread.update', { threadId: thread.id, toolMode: value })
                setChangingToolMode(false)
              }}
            >
              PTC {toolMode === 'ptc' ? 'ON' : 'OFF'}
            </button>
          )}
        </div>
        <div className="composer-right">
          {model?.includes('"openai-codex"') && <ChatGptLimitChip />}
          {thread?.usage && <UsageRing used={thread.usage.used} size={thread.usage.size} />}
          {running && !canSend
            ? (
              <button type="button" className="send-button stop" title="停止 (Esc)" aria-label="停止" onClick={() => void act('thread.cancel', { threadId: thread!.id })}>
                <Square size={12} fill="currentColor" />
              </button>
            )
            : (
              <button type="button" className="send-button" title={running ? '送信待ちに追加' : '送信 (Enter)'} aria-label="送信" disabled={!canSend} onClick={() => void submit()}>
                {sending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={17} />}
              </button>
            )}
        </div>
      </div>
      {dragging && <div className="drop-hint">ドロップしてファイルを添付</div>}
    </div>
  )
})
