import { memo, useEffect, useState } from 'react'
import {
  ArrowDown, Bot, ChevronDown, Copy, FolderOpen, GitBranch, MoreHorizontal, PanelLeftOpen, Pencil, RotateCw, SquareTerminal, Trash2,
} from 'lucide-react'
import { act, isNarrow, navigate, setState, setSubagentPanel, toast, useRemote, useStore } from '../store'
import type { TaskPresetSource, ThreadSummary, Turn } from '../types'
import { copyText, undoableRestore, workspaceLabel } from '../util'
import { Composer } from './Composer'
import { TaskPresetRuns, TaskPresetToggle } from './TaskPresets'
import { Dropdown, MenuDivider, MenuItem } from './Popover'
import { SubagentPanel } from './SubagentPanel'
import { TeamPanel, TeamToggle, useLedTeam, useTeam } from './TeamPanel'
import { TurnView } from './TurnView'
import { useConversationScroll } from './useConversationScroll'
import { scoresUpTo } from '../../../shared/usage-score.js'

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

export function OpenInMenu({ workspace, task }: { workspace: string; task?: TaskPresetSource }) {
  const remote = useRemote()
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
          {!remote && targets?.terminal && (
            <MenuItem
              icon={<SquareTerminal size={14} />}
              label="ターミナル"
              onSelect={() => {
                close()
                void act('workspace.open', { path: workspace, target: 'terminal' })
              }}
            />
          )}
          <MenuItem
            icon={<Copy size={14} />}
            label="作業フォルダーのパスをコピー"
            onSelect={() => {
              close()
              copyText(workspace).then(() => toast('パスをコピーしました', 'success'), () => toast('コピーできませんでした', 'error'))
            }}
          />
          {task && <>
            <MenuDivider />
            <MenuItem label="子に委託" onSelect={() => { close(); setState({ presetStart: { source: task, kind: 'delegate' } }) }} />
            <MenuItem label="独立レビュー" onSelect={() => { close(); setState({ presetStart: { source: task, kind: 'review' } }) }} />
          </>}
          <MenuDivider />
          <MenuItem
            icon={<RotateCw size={14} />}
            label="ビルドして再起動"
            onSelect={() => {
              close()
              setState({ restartConfirm: true })
            }}
          />
        </>
      )}
    </Dropdown>
  )
}

/** Estimated API cost of the task's turns up to and including each turn, or null where none was billed yet. */
function costsUpTo(turns: Turn[]) {
  let total: number | null = null
  return turns.map((turn) => {
    if (turn.usage?.cost != null) total = (total ?? 0) + turn.usage.cost
    return total
  })
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

const Header = memo(function Header({ thread, presetOpen, onPresetToggle }: { thread: ThreadSummary; presetOpen: boolean; onPresetToggle: () => void }) {
  const sidebarOpen = useStore((state) => state.sidebarOpen)
  const myPc = useStore((state) => state.server?.app.myPc)
  const names = useStore((state) => state.server?.settings.projectNames)
  const git = useGit(thread.workspace, thread.status === 'running' ? 'running' : thread.updatedAt)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(thread.title)
  useEffect(() => setTitle(thread.title), [thread.title])
  const save = async () => {
    setRenaming(false)
    if (title.trim() && title.trim() !== thread.title) await act('thread.update', { threadId: thread.id, title: title.trim() })
  }
  const team = useLedTeam(thread.id)
  const panelTeam = useTeam(thread.team?.id) ?? team
  return (
    <header className="main-header">
      <div className="header-left">
        {!sidebarOpen && (
          <button type="button" className="icon-button" aria-label="サイドバーを開く" title="サイドバーを開く (Ctrl+B)" onClick={() => setState({ sidebarOpen: true })}>
            <PanelLeftOpen size={16} />
          </button>
        )}
        {team && <span className="cl-mark tm-mark" title={team.execution ? 'エコモード' : 'エージェントチームのリーダー'}>{team.execution ? 'eco' : 'TM'}</span>}
        {renaming
          ? (
            <input
              className="title-input"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void save()}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
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
        {panelTeam && <TeamToggle team={panelTeam} />}
        <TaskPresetToggle source={{ kind: 'thread', id: thread.id }} open={presetOpen} onToggle={onPresetToggle} />
        <SubagentToggle threadId={thread.id} />
        <OpenInMenu workspace={thread.workspace} task={!panelTeam && !thread.ab && !thread.preset ? { kind: 'thread', id: thread.id } : undefined} />
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
})

export function ThreadView({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.server?.threads.find((entry) => entry.id === threadId))
  const turns = useStore((state) => state.turns[threadId])
  const panelOpen = useStore((state) => state.subagentPanel)
  const [presetOpen, setPresetOpen] = useState(() => !isNarrow())
  const team = useLedTeam(threadId)
  // Keep the same team beside its leader and its children.
  const panelTeam = useTeam(thread?.team?.id) ?? team
  const teamPanel = useStore((state) => state.teamPanel)
  const fallbackAvailable = useStore((state) => Boolean(thread?.fallbackTo && state.server?.terminals.some((entry) => entry.id === thread.fallbackTo?.id)))
  const { scroller, showJump, onScroll } = useConversationScroll(threadId, !!thread, turns)

  useEffect(() => {
    // Another task's subagent is not one to show here.
    setState({ subagentFocus: null })
  }, [threadId])

  if (!thread) return <div className="main-empty">タスクが見つかりません</div>
  const undoableId = turns ? undoableRestore(turns) : null
  const costs = turns ? costsUpTo(turns) : []
  const scores = turns ? scoresUpTo(turns) : []
  return (
    <div className="thread-view">
      <Header thread={thread} presetOpen={presetOpen} onPresetToggle={() => setPresetOpen((open) => !open)} />
      <div className="thread-body">
        <div className="thread-main">
          {thread.usageFallbackFrom && <div className="terminal-note" role="status">
            <span>{thread.usageFallbackInterrupted ? '切り替え中にアプリが終了しました。作業状態を確認してください。' : 'Claude Codeから切り替わりました。会話は抜粋で、権限は読み取り専用です。'}</span>
            <button type="button" className="button" onClick={() => navigate({ view: 'terminal', id: thread.usageFallbackFrom!.id })}>元の会話を開く</button>
          </div>}
          <div
            className="scroller"
            ref={scroller}
            onScroll={onScroll}
          >
            <div className="column">
              {!turns && <div className="loading-turns">読み込み中…</div>}
              {turns?.map((turn, index) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  workspace={thread.workspace}
                  taskCost={costs[index]}
                  taskScore={index === turns.length - 1 && team ? team.score : scores[index]}
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
              {thread.fallbackTo && <div className="terminal-note" role="status">
                <span>利用上限のため Claude Code に切り替えました。元の会話は閲覧用です。送信待ちの入力はここに残っています。</span>
                <button type="button" className="button" disabled={!fallbackAvailable} onClick={() => navigate({ view: 'terminal', id: thread.fallbackTo!.id })}>切り替え先を開く</button>
                {!fallbackAvailable && <span>切り替え先を表示できません。タスク一覧と作業状態を確認してください。</span>}
              </div>}
              <Composer key={thread.id} thread={thread} autoFocus={!thread.fallbackTo} />
            </div>
          </div>
        </div>
        {panelTeam && teamPanel ? <TeamPanel team={panelTeam} /> : panelOpen && <SubagentPanel thread={thread} />}
        {presetOpen && <TaskPresetRuns source={{ kind: 'thread', id: thread.id }} onClose={() => setPresetOpen(false)} />}
      </div>
    </div>
  )
}
