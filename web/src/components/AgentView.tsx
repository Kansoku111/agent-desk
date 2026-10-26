import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, Clock3, CornerDownRight, FolderOpen, Loader2, PanelLeftOpen, Send, Square, X } from 'lucide-react'
import { act, isTouch, setState, teamChildOf, useRemote, useStore } from '../store'
import { getDraft, useDraft, useImeField } from '../drafts'
import { workspaceLabel } from '../util'
import { StateIcon, stateLabel, TeamPanel, TeamToggle } from './TeamPanel'
import { OpenInMenu } from './ThreadView'
import { TurnView } from './TurnView'

/**
 * A team's Claude child: Claude Code run headless (server/claude-runner.js),
 * shown as its turns. The user can watch it, write to it (the reply also goes
 * to the leader) and stop its turn. A message written while it works waits for
 * the turn to end, or is given to the turn at once ("割り込む"), as in a task.
 */
export function AgentView({ taskId }: { taskId: string }) {
  // The team itself, not a new { team, child } each time: useStore compares by identity.
  const team = useStore((state) => (state.server ? teamChildOf(state.server, taskId)?.team : undefined))
  const child = team?.children.find((entry) => entry.kind === 'agent' && entry.taskId === taskId)
  const turns = useStore((state) => state.agentTurns[taskId])
  const sidebarOpen = useStore((state) => state.sidebarOpen)
  const teamPanel = useStore((state) => state.teamPanel)
  const myPc = useStore((state) => state.server?.app.myPc)
  const names = useStore((state) => state.server?.settings.projectNames)
  const remote = useRemote()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [text, setText] = useDraft(`agent:${taskId}`)
  const ime = useImeField()
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
  const followups = child.followups ?? []
  const submit = async () => {
    // Read from the store: the IME's last text settles into it as the button is pressed.
    const body = getDraft(`agent:${taskId}`).trim()
    if (!body || sending) return
    setSending(true)
    const result = await act('team.message', { teamId: team.id, childId: child.id, text: body })
    setSending(false)
    if (result) {
      // What was typed while the message was on its way is the next one.
      if (getDraft(`agent:${taskId}`).trim() === body) setText('')
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
          <TeamToggle team={team} />
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
            {followups.length > 0 && (
              <div className="queued">
                {followups.map((followup) => (
                  <div key={followup.id} className="queued-item">
                    <Clock3 size={13} />
                    <span className="queued-text">{followup.text}</span>
                    <span className="queued-note">{working ? '作業が終わったら送信' : '送信待ち'}</span>
                    {working && (
                      <button
                        type="button"
                        className="steer-button"
                        title="作業中のこの子に今すぐ送ります（次のステップで読みます）"
                        onClick={() => void act('team.steerFollowup', { teamId: team.id, childId: child.id, followupId: followup.id })}
                      >
                        <CornerDownRight size={13} />
                        割り込む
                      </button>
                    )}
                    <button type="button" className="icon-button small" aria-label="送信待ちを取り消す"
                      onClick={() => void act('team.dropFollowup', { teamId: team.id, childId: child.id, followupId: followup.id })}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="terminal-input">
              <textarea
                {...ime.fieldProps}
                value={text}
                rows={1}
                placeholder={working ? 'フォローアップを入力（作業が終わったら送信します）' : `子「${child.name}」に送るメッセージ（返事はリーダーにも届きます）`}
                aria-label={`子「${child.name}」に送るメッセージ`}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return
                  if (event.key === 'Escape' && working) {
                    event.preventDefault()
                    void act('team.stopChild', { teamId: team.id, childId: child.id })
                    return
                  }
                  if (event.key !== 'Enter' || event.shiftKey || isTouch()) return
                  event.preventDefault()
                  void submit()
                }}
              />
              <button type="button" className="terminal-send" aria-label="送信" title={working ? '送信待ちに追加' : '送信'} disabled={sending || !text.trim()}
                onPointerDown={(event) => {
                  event.preventDefault()
                  ime.confirm()
                }}
                onClick={() => void submit()}>
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
        {teamPanel && team.children.length > 0 && <TeamPanel team={team} />}
      </div>
    </div>
  )
}
