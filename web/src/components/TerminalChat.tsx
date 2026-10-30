import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Loader2, ShieldQuestion, SquareTerminal } from 'lucide-react'
import { act, request } from '../store'
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

type Dialog = { text: string[]; options: { key: string; label: string; detail: string; selected: boolean }[] }

/**
 * What Claude Code asks while it waits (an approval, a question), read off its
 * screen (server/terminals.js parseDialog), with its choices as buttons. One
 * that cannot be read is answered on the screen.
 */
function DialogCard({ terminalId, onShowScreen }: { terminalId: string; onShowScreen: () => void }) {
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const { dialog: next } = await request<{ dialog: Dialog | null }>('terminal.dialog', { terminalId })
        if (!stopped) setDialog(next)
      } catch {}
      // The screen can still be drawing it; it may also change (a second question).
      if (!stopped) timer = window.setTimeout(() => void poll(), BUSY_MS)
    }
    void poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [terminalId])

  const choose = async (key: string, label: string) => {
    setBusy(true)
    await act('terminal.choose', { terminalId, key, label })
    setBusy(false)
  }

  if (!dialog) {
    return (
      <div className="terminal-note terminal-chat-note">
        <span>承認が必要です。画面を開いて選んでください</span>
        <button type="button" className="button" onClick={onShowScreen}><SquareTerminal size={13} /> 画面を開く</button>
      </div>
    )
  }
  const question = dialog.text.at(-1)
  return (
    <div className="terminal-dialog">
      <div className="approval-card" role="alertdialog" aria-label="Claude Code の確認">
        <div className="approval-head">
          <ShieldQuestion size={16} />
          <span>{question ?? 'Claude Code が確認を求めています'}</span>
        </div>
        {dialog.text.length > 1 && <pre className="approval-command">{dialog.text.slice(0, -1).join('\n')}</pre>}
        <div className="terminal-dialog-options">
          {dialog.options.map((option) => (
            <button
              key={option.key}
              type="button"
              disabled={busy}
              className={`button terminal-dialog-option${option.selected ? ' primary' : ''}`}
              onClick={() => void choose(option.key, option.label)}
            >
              <span className="terminal-dialog-key">{option.key}</span>
              <span>
                {option.label}
                {option.detail && <small className="muted">{option.detail}</small>}
              </span>
            </button>
          ))}
        </div>
        <div className="approval-actions">
          <button type="button" className="button" onClick={onShowScreen}><SquareTerminal size={13} /> 画面で選ぶ</button>
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
        <DialogCard terminalId={terminal.id} onShowScreen={onShowScreen} />
      )}
      {terminal.state === 'stopped' && (
        <div className="terminal-note terminal-chat-note">
          <span>Claude Code は止まっています</span>
          <button type="button" className="button" onClick={onRestart}>会話を再開</button>
        </div>
      )}
    </div>
  )
}
