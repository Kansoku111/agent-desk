import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Loader2, ShieldQuestion, SquareTerminal } from 'lucide-react'
import { request } from '../store'
import type { TerminalSummary, Turn } from '../types'
import { TurnView } from './TurnView'
import { useLedTeam } from './TeamPanel'
import { useConversationScroll } from './useConversationScroll'

type Snapshot = { epoch: string | null; rev: number; omitted: number; reset: boolean; turns: Turn[]; ids: string[] }

/** How often the conversation is read while Claude Code works (or waits for an approval) and while it is idle. */
const BUSY_MS = 1000
const IDLE_MS = 3500

/**
 * A Claude Code task's conversation as chat turns, read from the file Claude Code
 * keeps (server/claude-transcript.js). Only what changed comes over on each read.
 * `poke` reads again soon (after sending a message).
 */
export function useConversation(terminalId: string, terminal: TerminalSummary | undefined, active: boolean) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [omitted, setOmitted] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = terminal?.activity !== 'idle' && terminal?.state === 'running'
  const delay = useRef(IDLE_MS)
  delay.current = busy ? BUSY_MS : IDLE_MS
  const poke = useRef<() => void>(() => {})

  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: number | undefined
    let epoch: string | null = null
    let since = 0
    let known: Turn[] = []
    const poll = async () => {
      window.clearTimeout(timer)
      if (!document.hidden) {
        try {
          const snap = await request<Snapshot>('terminal.conversation', { terminalId, epoch, since })
          if (stopped) return
          const changed = new Map(snap.turns.map((turn) => [turn.id, turn]))
          const before = new Map(known.map((turn) => [turn.id, turn]))
          const next = snap.ids.map((id) => changed.get(id) ?? before.get(id)).filter((turn): turn is Turn => Boolean(turn))
          if (next.length !== snap.ids.length) {
            // Out of step with the server: read everything again.
            epoch = null
            since = 0
            timer = window.setTimeout(() => void poll(), 100)
            return
          }
          epoch = snap.epoch
          since = snap.rev
          if (snap.reset || snap.turns.length || known.length !== next.length) {
            known = next
            setTurns(next)
            setOmitted(snap.omitted)
          }
          setLoaded(true)
          setError(null)
        } catch (cause) {
          if (stopped) return
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), delay.current)
    }
    poke.current = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void poll(), 250)
    }
    const visible = () => {
      if (!document.hidden) {
        window.clearTimeout(timer)
        void poll()
      }
    }
    document.addEventListener('visibilitychange', visible)
    void poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
      poke.current = () => {}
    }
  }, [terminalId, active])

  // Something changed in the task (a hook fired): look now rather than at the next tick.
  useEffect(() => {
    poke.current()
  }, [terminal?.activity, terminal?.updatedAt])

  return { turns, omitted, loaded, error, poke: () => poke.current() }
}

type Dialog = {
  dialogId: string
  text: string[]
  screen: string
  options: { key: string; label: string; detail: string; selected: boolean }[]
}

/** The CLI still owns the question; chat sends only explicit, screen-bound user input. */
export function DialogCard({ terminalId, onShowScreen }: { terminalId: string; onShowScreen: () => void }) {
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [controlsOpen, setControlsOpen] = useState(false)
  const [answer, setAnswer] = useState({ text: '', dialogId: '' })
  const sending = useRef(false)
  const readRevision = useRef(0)
  const refresh = useRef(() => {})
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      if (sending.current) { timer = window.setTimeout(() => void poll(), 250); return }
      const revision = ++readRevision.current
      try {
        const { dialog: next } = await request<{ dialog: Dialog | null }>('terminal.dialog', { terminalId })
        if (!stopped && revision === readRevision.current) {
          setDialog(next)
          setLoadError('')
          setRefreshing(false)
        }
      } catch (cause) {
        if (!stopped && revision === readRevision.current) {
          setLoadError(cause instanceof Error ? cause.message : String(cause))
          setRefreshing(false)
        }
      }
      // A second question, a checkbox or an input box may replace the numbered list.
      if (!stopped && revision === readRevision.current) timer = window.setTimeout(() => void poll(), BUSY_MS)
    }
    refresh.current = () => {
      readRevision.current++
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void poll(), 250)
    }
    void poll()
    return () => {
      stopped = true
      mounted.current = false
      readRevision.current++
      window.clearTimeout(timer)
      refresh.current = () => {}
    }
  }, [terminalId])

  const respond = async (type: string, params: Record<string, unknown>, text = false) => {
    if (sending.current || refreshing || loadError || !dialog) return
    sending.current = true
    readRevision.current++ // Do not let a read from before the click restore an old question.
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await request(type, { terminalId, dialogId: dialog.dialogId, ...params })
      if (!mounted.current) return
      setRefreshing(true)
      if (text) {
        setAnswer({ text: '', dialogId: '' })
        setNotice('入力を反映しました。「確定・次へ」で回答を送れます。')
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sending.current = false
      if (mounted.current) { setBusy(false); refresh.current() }
    }
  }
  const disabled = busy || refreshing || Boolean(loadError)
  const staleAnswer = Boolean(answer.text && answer.dialogId !== dialog?.dialogId)
  const key = (value: string) => void respond('terminal.respond', { key: value })
  const optionLabel = (label: string) => /^Type something\.?$/i.test(label) ? '自由入力（その他）' : /^Chat about this$/i.test(label) ? 'この質問について相談する' : label

  return (
    <div className="terminal-dialog">
      <div className="approval-card" role="region" aria-label="Claude Code の質問・確認" aria-busy={busy || refreshing}>
        <div className="approval-head">
          <ShieldQuestion size={16} />
          <span>{dialog?.text.at(-1) ?? 'Claude Code の質問・確認'}</span>
        </div>
        {loadError && <p role="alert">質問を読み取れませんでした: {loadError}</p>}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status" className="muted">{notice}</p>}
        {!dialog ? <p className="muted">質問の表示を待っています。自動で読み直します。</p> : <>
          {dialog.text.length > 1 && <p className="terminal-dialog-question">{dialog.text.slice(0, -1).join('\n')}</p>}
          {dialog.options.length > 0 ? <div className="terminal-dialog-options">
            {dialog.options.map((option) => (
              <button key={option.key} type="button" disabled={disabled}
                className={`button terminal-dialog-option${option.selected ? ' primary' : ''}`}
                onClick={() => {
                  if (/^Type something\.?$/i.test(option.label)) setControlsOpen(true)
                  void respond('terminal.choose', { key: option.key, label: option.label })
                }}>
                <span className="terminal-dialog-key">{option.key}</span>
                <span>{optionLabel(option.label)}{option.detail && <small className="muted">{option.detail}</small>}</span>
              </button>
            ))}
          </div> : <pre className="approval-command terminal-dialog-screen">{dialog.screen}</pre>}
          <div className="terminal-dialog-controls terminal-dialog-main">
            <button type="button" className="button primary" disabled={disabled} onClick={() => key('enter')}>確定・次へ</button>
            <button type="button" className="button" disabled={disabled} onClick={() => key('escape')}>キャンセル（Esc）</button>
          </div>
          <details className="terminal-dialog-input" open={dialog.options.length === 0 || controlsOpen} onToggle={(event) => setControlsOpen(event.currentTarget.open)}>
            <summary>{dialog.options.length > 0 ? '画面・キー操作・自由入力' : 'キー操作・自由入力'}</summary>
            {dialog.options.length > 0 && <pre className="approval-command terminal-dialog-screen">{dialog.screen}</pre>}
            <div className="terminal-dialog-controls" role="group" aria-label="質問の操作">
              {([['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'], ['tab', 'Tab'], ['space', '選択切替']] as const).map(([value, label]) => (
                <button key={value} type="button" className="button" disabled={disabled} title={value === 'space' ? 'Space: チェックを切り替える' : label} aria-label={{ up: '前の選択肢', down: '次の選択肢', left: '前の質問', right: '次の質問', tab: 'Tab で移動', space: '選択切替' }[value]} onClick={() => key(value)}>{label}</button>
              ))}
            </div>
            <label className="terminal-dialog-answer">自由入力の回答
              <textarea rows={3} maxLength={8000} value={answer.text} disabled={disabled} placeholder="回答を入力（Enter は改行。自動送信しません）"
                onChange={(event) => setAnswer({ text: event.target.value, dialogId: answer.text ? answer.dialogId : dialog.dialogId })} />
            </label>
            {staleAnswer && <p role="status" className="muted">質問の表示が変わったため、入力は送っていません。内容を控えて、入力を消してから書き直してください。</p>}
            <div className="terminal-dialog-controls">
              <button type="button" className="button" disabled={disabled || !answer.text.trim() || staleAnswer} onClick={() => void respond('terminal.respond', { text: answer.text, dialogId: answer.dialogId }, true)}>入力を反映</button>
              <button type="button" className="button" disabled={busy || !answer.text} onClick={() => setAnswer({ text: '', dialogId: '' })}>入力を消す</button>
            </div>
          </details>
        </>}
        <div className="approval-actions">
          <button type="button" className="button" disabled={busy || refreshing} onClick={() => refresh.current()}>再読み込み</button>
          <button type="button" className="button" onClick={onShowScreen}><SquareTerminal size={13} /> 必要なら画面を開く</button>
        </div>
      </div>
    </div>
  )
}

export function TerminalChat({ terminal, turns, omitted, loaded, error, onShowScreen, onRestart }: {
  terminal: TerminalSummary
  turns: Turn[]
  omitted: number
  loaded: boolean
  error: string | null
  onShowScreen: () => void
  onRestart: () => void
}) {
  const working = terminal.state === 'running' && terminal.activity !== 'idle'
  const team = useLedTeam(terminal.id)
  // A turn the file still calls running is over once Claude Code is idle (or ended).
  const shown = useMemo(() => turns.map((turn, index) => (
    turn.status === 'running' && (index < turns.length - 1 || !working) ? { ...turn, status: 'done' as const } : turn
  )), [turns, working])

  const { scroller, showJump, onScroll } = useConversationScroll(terminal.id, true, shown)

  return (
    <div className="terminal-chat">
      <div
        className="scroller"
        ref={scroller}
        onScroll={onScroll}
      >
        <div className="column">
          {!loaded && !error && <div className="loading-turns"><Loader2 size={14} className="spin" /> 読み込み中…</div>}
          {error && !loaded && <div className="loading-turns">{error}</div>}
          {loaded && omitted > 0 && <div className="loading-turns">これより前の {omitted} 件のやり取りは表示していません</div>}
          {loaded && shown.length === 0 && <div className="loading-turns">まだ会話がありません。下の欄からメッセージを送ってください。</div>}
          {shown.map((turn, index) => (
            <TurnView key={turn.id} turn={turn} workspace={terminal.workspace} threadId={terminal.id} threadBusy={false} undoable={false}
              onClaudeLogin={index === shown.length - 1 && terminal.state === 'running' ? onShowScreen : undefined}
              taskScore={index === shown.length - 1 ? team?.score ?? terminal.score ?? turn.totalScore : turn.totalScore} />
          ))}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          className="jump terminal-chat-jump"
          aria-label="最新へ移動"
          onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })}
        >
          <ArrowDown size={15} />
        </button>
      )}
      {terminal.state === 'running' && terminal.activity === 'approval' && (
        <DialogCard key={terminal.id} terminalId={terminal.id} onShowScreen={onShowScreen} />
      )}
      {terminal.state === 'stopped' && !terminal.fallbackTo && (
        <div className="terminal-note terminal-chat-note">
          <span>Claude Code は止まっています</span>
          <button type="button" className="button" onClick={onRestart}>会話を再開</button>
        </div>
      )}
    </div>
  )
}
