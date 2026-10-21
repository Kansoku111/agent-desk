import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowDown, Bot, ChevronDown, FolderOpen, GitBranch, MoreHorizontal, PanelLeftOpen, Pencil, SquareTerminal, Trash2,
} from 'lucide-react'
import { act, setState, setSubagentPanel, useRemote, useStore } from '../store'
import type { ThreadSummary, Turn } from '../types'
import { undoableRestore, workspaceLabel } from '../util'
import { Composer } from './Composer'
import { Dropdown, MenuItem } from './Popover'
import { SubagentPanel } from './SubagentPanel'
import { BackToLeader, TeamPanel, TeamToggle, useLedTeam } from './TeamPanel'
import { TurnView } from './TurnView'

function useGit(workspace: string, refreshKey: unknown) {
  const [git, setGit] = useState<{ branch: string; changes: number } | null>(null)
  useEffect(() => {
    let alive = true
    void act<{ git: { branch: string; changes: number } | null }>('workspace.git', { path: workspace }).then((result) => {
      if (alive) setGit(result?.git ?? null)
    })
    return () => {
      alive = false
    }
  }, [workspace, refreshKey])
  return git
}

export function OpenInMenu({ workspace }: { workspace: string }) {
  const targets = useStore((state) => state.server?.openTargets)
  return (
    <Dropdown
      placement="bottom"
      align="right"
      width={220}
      trigger={({ toggle, open }) => (
        <button type="button" className={`button ghost ${open ? 'active' : ''}`} onClick={toggle}>
          <span>開く</span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            icon={<FolderOpen size={14} />}
            label="エクスプローラー"
            onSelect={() => {
              close()
              void act('workspace.open', { path: workspace, target: 'files' })
            }}
          />
          {targets?.terminal && (
            <MenuItem
              icon={<SquareTerminal size={14} />}
              label="ターミナル"
              onSelect={() => {
                close()
                void act('workspace.open', { path: workspace, target: 'terminal' })
              }}
            />
          )}
        </>
      )}
    </Dropdown>
  )
}

/** Estimated API cost of the task's turns up to and including one turn, or null when none were billed. */
function costUpTo(turns: Turn[], index: number) {
  let total: number | null = null
  for (const turn of turns.slice(0, index + 1)) {
    if (turn.usage?.cost != null) total = (total ?? 0) + turn.usage.cost
  }
  return total
}

/** Shows or hides the subagent panel; only on tasks that started subagents. */
function SubagentToggle({ threadId }: { threadId: string }) {
  const total = useStore((state) => state.subagents[threadId]?.length ?? 0)
  const running = useStore((state) => state.subagents[threadId]?.filter((entry) => entry.status === 'running' || entry.status === 'starting').length ?? 0)
  const open = useStore((state) => state.subagentPanel)
  if (!total) return null
  return (
    <button
      type="button"
      className={`button ghost subagent-toggle ${open ? 'active' : ''}`}
      aria-pressed={open}
      title={open ? 'サブエージェントのパネルを閉じる' : 'サブエージェントのパネルを開く'}
      onClick={() => setSubagentPanel(!open)}
    >
      <Bot size={14} />
      <span>{running > 0 ? `${running} 実行中` : total}</span>
      {running > 0 && <span className="subagent-dot" aria-hidden="true" />}
    </button>
  )
}

function Header({ thread }: { thread: ThreadSummary }) {
  const sidebarOpen = useStore((state) => state.sidebarOpen)
  const myPc = useStore((state) => state.server?.app.myPc)
  const names = useStore((state) => state.server?.settings.projectNames)
  const git = useGit(thread.workspace, thread.status === 'running' ? 'running' : thread.updatedAt)
  const remote = useRemote()
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(thread.title)
  useEffect(() => setTitle(thread.title), [thread.title])
  const save = async () => {
    setRenaming(false)
    if (title.trim() && title.trim() !== thread.title) await act('thread.update', { threadId: thread.id, title: title.trim() })
  }
  const team = useLedTeam(thread.id)
  return (
    <header className="main-header">
      <div className="header-left">
        {!sidebarOpen && (
          <button type="button" className="icon-button" aria-label="サイドバーを開く" title="サイドバーを開く (Ctrl+B)" onClick={() => setState({ sidebarOpen: true })}>
            <PanelLeftOpen size={16} />
          </button>
        )}
        {thread.team?.childId && <BackToLeader teamId={thread.team.id} childId={thread.team.childId} />}
        {team && <span className="cl-mark tm-mark" title="エージェントチームのリーダー（GPT）">TM</span>}
        {renaming
          ? (
            <input
              className="title-input"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void save()}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter') void save()
                if (event.key === 'Escape') {
                  setTitle(thread.title)
                  setRenaming(false)
                }
              }}
              aria-label="タスク名"
            />
          )
          : <h1 className="thread-heading" onDoubleClick={() => setRenaming(true)} title={thread.title}>{thread.title}</h1>}
        <span className="header-chip" title={thread.workspace}><FolderOpen size={13} />{workspaceLabel(thread.workspace, myPc, names)}</span>
        {git && (
          <span className="header-chip" title={git.changes ? `未コミットの変更 ${git.changes} 件` : 'クリーン'}>
            <GitBranch size={13} />{git.branch}{git.changes > 0 && <span className="git-changes">{git.changes}</span>}
          </span>
        )}
      </div>
      <div className="header-right">
        {team && <TeamToggle team={team} />}
        <SubagentToggle threadId={thread.id} />
        {!remote && <OpenInMenu workspace={thread.workspace} />}
        <Dropdown
          placement="bottom"
          align="right"
          width={180}
          trigger={({ toggle }) => (
            <button type="button" className="icon-button" aria-label="その他の操作" onClick={toggle}><MoreHorizontal size={16} /></button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<Pencil size={14} />} label="名前を変更" onSelect={() => { close(); setRenaming(true) }} />
              <MenuItem
                icon={<Trash2 size={14} />}
                label="削除"
                hint="⌫"
                danger
                keys={['Backspace', 'Delete']}
                onSelect={() => {
                  close()
                  // The confirmed `removed` event handles navigation. Stay on
                  // the task if deletion fails so its error can be retried.
                  void act('thread.remove', { threadId: thread.id })
                }}
              />
            </>
          )}
        </Dropdown>
      </div>
    </header>
  )
}

export function ThreadView({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.server?.threads.find((entry) => entry.id === threadId))
  const turns = useStore((state) => state.turns[threadId])
  const panelOpen = useStore((state) => state.subagentPanel)
  // A GPT team leader shows its children beside it, as a Claude leader does.
  const team = useLedTeam(threadId)
  const teamPanel = useStore((state) => state.teamPanel) && Boolean(team?.children.length)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)

  // Follow new output while the reader is at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [turns])

  useEffect(() => {
    stick.current = true
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
    // Another task's subagent is not one to show here.
    setState({ subagentFocus: null })
  }, [threadId])

  if (!thread) return <div className="main-empty">タスクが見つかりません</div>
  const undoableId = turns ? undoableRestore(turns) : null
  return (
    <div className="thread-view">
      <Header thread={thread} />
      <div className="thread-body">
        <div className="thread-main">
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
              {!turns && <div className="loading-turns">読み込み中…</div>}
              {turns?.map((turn, index) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  workspace={thread.workspace}
                  taskCost={costUpTo(turns, index)}
                  threadId={thread.id}
                  threadBusy={thread.status === 'running'}
                  undoable={turn.id === undoableId}
                />
              ))}
            </div>
          </div>
          <div className="dock">
            {showJump && (
              <button
                type="button"
                className="jump"
                aria-label="最新へ移動"
                onClick={() => {
                  const element = scroller.current
                  if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
                }}
              >
                <ArrowDown size={15} />
              </button>
            )}
            <div className="column">
              <Composer thread={thread} autoFocus />
            </div>
          </div>
        </div>
        {team && teamPanel ? <TeamPanel team={team} /> : panelOpen && <SubagentPanel thread={thread} />}
      </div>
    </div>
  )
}
