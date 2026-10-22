import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, FolderOpen, Loader2, PanelLeftOpen, Send, Square } from 'lucide-react'
import { act, isTouch, setState, teamChildOf, useRemote, useStore } from '../store'
import { useDraft } from '../drafts'
import { workspaceLabel } from '../util'
import { BackToLeader, StateIcon, stateLabel } from './TeamPanel'
import { OpenInMenu } from './ThreadView'
import { TurnView } from './TurnView'

/**
 * A team's Claude child: Claude Code run headless (server/claude-runner.js),
 * shown as its turns. The user can watch it, write to it (the reply also goes
 * to the leader) and stop its turn.
 */
export function AgentView({ taskId }: { taskId: string }) {
  // The team itself, not a new { team, child } each time: useStore compares by identity.
  const team = useStore((state) => (state.server ? teamChildOf(state.server, taskId)?.team : undefined))
  const child = team?.children.find((entry) => entry.kind === 'agent' && entry.taskId === taskId)
  const turns = useStore((state) => state.agentTurns[taskId])
  const sidebarOpen = useStore((state) => state.sidebarOpen)
  const myPc = useStore((state) => state.server?.app.myPc)
  const names = useStore((state) => state.server?.settings.projectNames)
  const remote = useRemote()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [text, setText] = useDraft(`agent:${taskId}`)
  const [sending, setSending] = useState(false)

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [turns])
  useEffect(() => {
    stick.current = true
  }, [taskId])

  if (!team || !child) return <div className="main-empty">この子は見つかりません</div>
  const working = child.state === 'running'
  const submit = async () => {
    const body = text.trim()
    if (!body || working || sending) return
    setSending(true)
    const result = await act('team.message', { teamId: team.id, childId: child.id, text: body })
    setSending(false)
    if (result) {
      setText('')
      stick.current = true
    }
  }

  return (
    <div className="thread-view terminal-view agent-view">
      <header className="main-header">
        <div className="header-left">
          {!sidebarOpen && (
            <button type="button" className="icon-button" aria-label="サイドバーを開く" title="サイドバーを開く (Ctrl+B)" onClick={() => setState({ sidebarOpen: true })}>
              <PanelLeftOpen size={16} />
            </button>
          )}
          <BackToLeader teamId={team.id} childId={child.id} />
          <span className="cl-mark" aria-hidden="true">CL</span>
          <h1 className="thread-heading" title={child.title}>{child.name === child.title ? child.title : `${child.name}: ${child.title}`}</h1>
          <span className="header-chip" title={team.workspace}><FolderOpen size={13} />{workspaceLabel(team.workspace, myPc, names)}</span>
          <span className="header-chip" title={`${child.modelName}${child.effort ? ` · ${child.effort}` : ''}`}>{child.modelName}</span>
          <span className={`header-chip terminal-status ${working ? 'running' : 'idle'}`}>
            <StateIcon state={child.state} size={12} />
            {stateLabel(child)}
          </span>
        </div>
        <div className="header-right">
          {working && (
            <button type="button" className="button ghost" title="この子の作業を止める（リーダーに伝わります）"
              onClick={() => void act('team.stopChild', { teamId: team.id, childId: child.id })}>
              <Square size={13} /> 止める
            </button>
          )}
          {!remote && <OpenInMenu workspace={team.workspace} />}
        </div>
      </header>
      <div className="thread-body">
        <div className="thread-main">
          <div className="terminal-chat">
            <div
              className="scroller"
              ref={scroller}
              onScroll={(event) => {
                const element = event.currentTarget
                const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
                stick.current = atBottom
                setShowJump(!atBottom)
              }}
            >
              <div className="column">
                {!turns && <div className="loading-turns"><Loader2 size={14} className="spin" /> 読み込み中…</div>}
                {turns && turns.length === 0 && <div className="loading-turns">まだ作業の記録がありません</div>}
                {turns?.map((turn) => (
                  <TurnView key={turn.id} turn={turn} workspace={team.workspace} threadId={taskId} threadBusy={false} undoable={false} />
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
          </div>
          <div className="terminal-touch">
            <div className="terminal-input">
              <textarea
                value={text}
                rows={1}
                disabled={working}
                placeholder={working ? '作業中です。終わると送れます' : `子「${child.name}」に送るメッセージ（返事はリーダーにも届きます）`}
                aria-label={`子「${child.name}」に送るメッセージ`}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || isTouch()) return
                  event.preventDefault()
                  void submit()
                }}
              />
              <button type="button" className="terminal-send" aria-label="送信" disabled={working || sending || !text.trim()}
                onPointerDown={(event) => event.preventDefault()} onClick={() => void submit()}>
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
