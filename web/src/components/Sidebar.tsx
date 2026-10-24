import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Archive, ArchiveRestore, ArrowLeft, Folder, FolderOpen, FolderPlus, Loader2, Monitor, MoreHorizontal, PanelLeftClose, Pencil, Plus,
  CheckSquare, Copy, Search, Settings, SquarePen, Trash2, X,
} from 'lucide-react'
import { act, getState, isNarrow, navigate, request, setState, startTerminal, toast, useRemote, useStore } from '../store'
import { selectThreadRange } from '../thread-selection'
import { threadMarkdown } from '../thread-transcript'
import { ConfirmDialog } from './Modal'
import type { TerminalSummary, ThreadSummary, Turn } from '../types'
import { copyText, parseModel, relativeTime, workspaceLabel } from '../util'
import { PROJECT_HUES, projectColor, stepColor } from '../projectColors'
import { Dropdown, MenuItem } from './Popover'
import { openProjectDialog } from './ProjectDialog'
import { teamNeedsUser, useLedTeam } from './TeamPanel'
import { UsageSummaryButton } from './UsagePanel'

const COLLAPSED_KEY = 'agentdesk.sidebar.collapsed'

function readCollapsed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function writeCollapsed(paths: string[]) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(paths))
  } catch {}
}

// The sidebar unmounts when closed, so its scroll position lives here to survive reopening.
let taskTreeScroll = 0

/** Opens the composer for a new task in one project (or My PC). */
function newTaskIn(workspace: string) {
  setState((state) => ({ draft: { ...state.draft, workspace } }))
  navigate({ view: 'home' })
  setTimeout(() => document.querySelector<HTMLTextAreaElement>('.home-composer textarea')?.focus(), 30)
}

/** Copies the task's conversation as Markdown, to hand to another agent or chat. */
async function copyHistory(thread: ThreadSummary) {
  const turns = getState().turns[thread.id] ?? (await act<{ turns: Turn[] }>('thread.get', { threadId: thread.id }))?.turns
  if (!turns) return
  const model = parseModel(thread.model)
  try {
    await copyText(threadMarkdown({ ...thread, model: model ? `${model.provider} / ${model.id}` : thread.model }, turns))
    toast('履歴をコピーしました', 'success')
  } catch {
    toast('コピーできませんでした', 'error')
  }
}

/** Copies a Claude Code task's conversation, read from the file Claude Code keeps, as `copyHistory` does for a thread. */
async function copyTerminalHistory(terminal: TerminalSummary) {
  const snapshot = await act<{ turns: Turn[]; omitted: number; file: string | null }>('terminal.conversation', { terminalId: terminal.id })
  if (!snapshot) return
  if (!snapshot.turns.length) {
    toast('コピーできる会話がまだありません', 'info')
    return
  }
  try {
    await copyText(threadMarkdown({ ...terminal, model: terminal.modelInUse ?? terminal.model }, snapshot.turns, { omitted: snapshot.omitted, file: snapshot.file }))
    toast('履歴をコピーしました', 'success')
  } catch {
    toast('コピーできませんでした', 'error')
  }
}

function ThreadStatus({ thread }: { thread: ThreadSummary }) {
  // A GPT team leader also shows what its children are doing, as a Claude leader does.
  const team = useLedTeam(thread.id)
  if (thread.pendingApproval) return <span className="status-dot approval" title="承認待ち" />
  if (teamNeedsUser(team)) return <span className="status-dot approval" title="チームが確認を求めています" />
  if (thread.status === 'running') return <Loader2 size={13} className="spin muted" aria-label="作業中" />
  if (team?.children.some((child) => child.state === 'running' || child.state === 'approval')) {
    return <Loader2 size={13} className="spin muted" aria-label="子が作業中" />
  }
  if (thread.status === 'error') return <span className="status-dot error" title="エラー" />
  return <span className="thread-time">{relativeTime(thread.updatedAt)}</span>
}

function TerminalStatus({ terminal }: { terminal: TerminalSummary }) {
  // A team's leader also shows what its children are doing: it may sleep while they work.
  const team = useLedTeam(terminal.id)
  if (terminal.state === 'running' && terminal.activity === 'approval') return <span className="status-dot approval" title="承認待ち" />
  if (teamNeedsUser(team)) return <span className="status-dot approval" title="チームが確認を求めています" />
  if (terminal.state === 'running' && terminal.activity === 'running') return <Loader2 size={13} className="spin muted" aria-label="作業中" />
  if (terminal.state === 'running' && terminal.background > 0) return <Loader2 size={13} className="spin muted" aria-label="裏で作業中" />
  if (team?.children.some((child) => child.state === 'running' || child.state === 'approval')) {
    return <Loader2 size={13} className="spin muted" aria-label="子が作業中" />
  }
  return <span className="thread-time">{relativeTime(terminal.updatedAt)}</span>
}

interface ThreadSelection {
  enabled: boolean
  selected: ReadonlySet<string>
  busy: boolean
  toggle: (id: string, range: boolean) => void
  group: (ids: string[]) => void
}

function ThreadRow({ thread, active, selection }: { thread: ThreadSummary; active: boolean; selection: ThreadSelection }) {
  const leads = thread.team?.role === 'leader'
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(thread.title)
  const save = async () => {
    setRenaming(false)
    if (title.trim() && title.trim() !== thread.title) await act('thread.update', { threadId: thread.id, title: title.trim() })
  }
  return (
    <li className={`thread-row ${active ? 'active' : ''} ${selection.enabled && selection.selected.has(thread.id) ? 'selected' : ''}`}>
      {selection.enabled && (
        <input type="checkbox" className="thread-checkbox" aria-label={`${thread.title} を選択`}
          checked={selection.selected.has(thread.id)} disabled={selection.busy}
          onChange={() => {}}
          onClick={(event) => selection.toggle(thread.id, event.shiftKey)} />
      )}
      {renaming
        ? (
          <input
            className="rename-input"
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
        : (
          <button type="button" className="thread-button" disabled={selection.busy}
            onClick={(event) => selection.enabled || event.ctrlKey || event.metaKey || event.shiftKey
              ? selection.toggle(thread.id, event.shiftKey)
              : navigate({ view: 'thread', id: thread.id })} title={leads ? `エージェントチーム（GPT）: ${thread.title}` : thread.title}>
            {leads && <span className="cl-mark tm-mark small" aria-label="エージェントチーム">TM</span>}
            <span className="thread-title">{thread.title}</span>
            <span className="thread-meta"><ThreadStatus thread={thread} /></span>
          </button>
        )}
      {!renaming && !selection.enabled && (
        <Dropdown
          placement="bottom"
          align="right"
          width={180}
          className="thread-actions"
          trigger={({ toggle }) => (
            <button type="button" className="icon-button small" aria-label="タスクの操作" onClick={toggle}>
              <MoreHorizontal size={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Pencil size={14} />}
                label="名前を変更"
                onSelect={() => {
                  close()
                  setTitle(thread.title)
                  setRenaming(true)
                }}
              />
              <MenuItem
                icon={<Copy size={14} />}
                label="履歴をコピー"
                onSelect={() => {
                  close()
                  void copyHistory(thread)
                }}
              />
              <MenuItem
                icon={thread.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                label={thread.archived ? 'アーカイブから戻す' : 'アーカイブ'}
                onSelect={() => {
                  close()
                  void act('thread.update', { threadId: thread.id, archived: !thread.archived })
                }}
              />
              <MenuItem
                icon={<Trash2 size={14} />}
                label={leads ? 'チームを削除' : '削除'}
                hint="⌫"
                danger
                keys={['Backspace', 'Delete']}
                onSelect={() => {
                  close()
                  void act('thread.remove', { threadId: thread.id })
                }}
              />
            </>
          )}
        </Dropdown>
      )}
    </li>
  )
}

/** A Claude Code task in the list, marked "CL" ("TM" for a team's leader). */
function TerminalRow({ terminal, active, selection }: { terminal: TerminalSummary; active: boolean; selection: ThreadSelection }) {
  const leads = terminal.team?.role === 'leader'
  const team = useLedTeam(terminal.id)
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [title, setTitle] = useState(terminal.title)
  const save = async () => {
    setRenaming(false)
    if (title.trim() && title.trim() !== terminal.title) await act('terminal.update', { terminalId: terminal.id, title: title.trim() })
  }
  return (
    <li className={`thread-row terminal-row ${active ? 'active' : ''} ${selection.enabled && selection.selected.has(terminal.id) ? 'selected' : ''}`}>
      {selection.enabled && (
        <input type="checkbox" className="thread-checkbox" aria-label={`${terminal.title} を選択`}
          checked={selection.selected.has(terminal.id)} disabled={selection.busy}
          onChange={() => {}}
          onClick={(event) => selection.toggle(terminal.id, event.shiftKey)} />
      )}
      {renaming
        ? (
          <input
            className="rename-input"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter') void save()
              if (event.key === 'Escape') {
                setTitle(terminal.title)
                setRenaming(false)
              }
            }}
            aria-label="タスク名"
          />
        )
        : (
          <button type="button" className="thread-button" disabled={selection.busy}
            onClick={(event) => selection.enabled || event.ctrlKey || event.metaKey || event.shiftKey
              ? selection.toggle(terminal.id, event.shiftKey)
              : navigate({ view: 'terminal', id: terminal.id })} title={`${leads ? 'エージェントチーム' : 'Claude Code'}: ${terminal.title}`}>
            {leads
              ? <span className="cl-mark tm-mark small" aria-label="エージェントチーム">TM</span>
              : <span className="cl-mark small" aria-label="Claude Code">CL</span>}
            <span className="thread-title">{terminal.title}</span>
            <span className="thread-meta"><TerminalStatus terminal={terminal} /></span>
          </button>
        )}
      {!renaming && !selection.enabled && (
        <Dropdown
          placement="bottom"
          align="right"
          width={180}
          className="thread-actions"
          trigger={({ toggle }) => (
            <button type="button" className="icon-button small" aria-label="タスクの操作" onClick={toggle}>
              <MoreHorizontal size={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Pencil size={14} />}
                label="名前を変更"
                onSelect={() => {
                  close()
                  setTitle(terminal.title)
                  setRenaming(true)
                }}
              />
              <MenuItem
                icon={<Copy size={14} />}
                label="履歴をコピー"
                onSelect={() => {
                  close()
                  void copyTerminalHistory(terminal)
                }}
              />
              <MenuItem
                icon={terminal.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                label={terminal.archived ? 'アーカイブから戻す' : 'アーカイブ'}
                onSelect={() => {
                  close()
                  void act('terminal.update', { terminalId: terminal.id, archived: !terminal.archived })
                }}
              />
              <MenuItem
                icon={<Trash2 size={14} />}
                label={leads ? 'チームを削除' : '削除'}
                hint="⌫"
                danger
                keys={['Backspace', 'Delete']}
                onSelect={() => {
                  close()
                  // Deleting a team's leader deletes its children and their reports: asked first.
                  if (leads) setRemoving(true)
                  else void act('terminal.remove', { terminalId: terminal.id })
                }}
              />
            </>
          )}
        </Dropdown>
      )}
      {removing && (
        <ConfirmDialog title="チームを削除しますか？"
          body={<p>リーダーと子 {team?.children.length ?? 0} 人のタスクと、報告の記録を削除します。この操作は元に戻せません。実行中の作業は停止します。</p>}
          confirmLabel="チームを削除" danger
          onClose={() => setRemoving(false)} onConfirm={() => void act('terminal.remove', { terminalId: terminal.id })} />
      )}
    </li>
  )
}

interface Group {
  path: string
  label: string
  pc: boolean
  color: number
  threads: ThreadSummary[]
  terminals: TerminalSummary[]
}

/** Agent tasks and Claude Code tasks of one group, most recent first. */
function groupRows(group: Group) {
  return [
    ...group.threads.map((thread) => ({ id: thread.id, updatedAt: thread.updatedAt, thread, terminal: null })),
    ...group.terminals.map((terminal) => ({ id: terminal.id, updatedAt: terminal.updatedAt, thread: null, terminal })),
  ].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Turning the mouse wheel over a group's header steps through the tints. The
 * new color shows at once and is saved when the wheel stops.
 */
function useWheelColor(path: string, color: number) {
  const head = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const shown = preview ?? color
  const current = useRef(shown)
  current.current = shown

  useEffect(() => {
    const element = head.current
    if (!element) return
    let delta = 0
    let timer: number | undefined
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      // Line-based wheels (Firefox) report a few lines, not pixels.
      delta += event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY
      if (Math.abs(delta) < 40) return
      const next = stepColor(current.current, delta > 0 ? 1 : -1)
      delta = 0
      current.current = next
      setPreview(next)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void act('project.color', { path, color: next }).then(() => setPreview((value) => (value === next ? null : value)))
      }, 350)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      window.clearTimeout(timer)
    }
  }, [path])

  return { head, color: shown }
}

function TaskGroup({ group, collapsed, onToggle, draftHere, activeId, searching, selection }: {
  group: Group
  collapsed: boolean
  onToggle: () => void
  draftHere: boolean
  activeId: string | null
  searching: boolean
  selection: ThreadSelection
}) {
  const open = !collapsed || searching
  const rows = groupRows(group)
  const hasRows = rows.length > 0 || draftHere
  const remote = useRemote()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(group.label)
  const saveName = async () => {
    setRenaming(false)
    if (name.trim() && name.trim() !== group.label) await act('project.rename', { path: group.path, name: name.trim() })
  }
  const Icon = group.pc ? Monitor : open && hasRows ? FolderOpen : Folder
  const { head, color } = useWheelColor(group.path, group.color)
  const tint = color >= 0 ? { '--group-hue': PROJECT_HUES[color] } as CSSProperties : undefined
  return (
    <section className={`task-group ${tint ? 'tinted' : ''}`} style={tint}>
      <div className="task-group-head" ref={head}>
        {renaming
          ? (
            <input
              className="rename-input"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key === 'Enter') void saveName()
                if (event.key === 'Escape') setRenaming(false)
              }}
              aria-label="プロジェクト名"
            />
          )
          : (
            <button
              type="button"
              className="task-group-toggle"
              onClick={onToggle}
              aria-expanded={open}
              title={`${group.pc ? `プロジェクトに属さないタスク（${group.path}）` : group.path}\nホイールで色を変更`}
            >
              <Icon size={15} />
              <span>{group.label}</span>
            </button>
          )}
        <div className="task-group-actions">
          {rows.length > 0 && (
            <button type="button" className="icon-button small" disabled={selection.busy}
              title="このProjectの表示中のセッションを全選択" aria-label={`${group.label} のセッションを全選択`}
              onClick={() => selection.group(rows.map((row) => row.id))}>
              <CheckSquare size={14} />
            </button>
          )}
          <button type="button" className="icon-button small cl-button tm-button" title="エージェントチームを始める（リーダーや子のモデルを選んでから始めます）"
            aria-label={`${group.label} でエージェントチームを始める`} onClick={() => setState({ teamStart: group.path })}>
            TM
          </button>
          <button type="button" className="icon-button small cl-button" title="Claude Code で新しいタスク" aria-label={`${group.label} で Claude Code を開く`}
            onClick={() => void startTerminal(group.path)}>
            CL
          </button>
          <button type="button" className="icon-button small new-task-button" title="新しいタスク" aria-label={`${group.label} で新しいタスク`} onClick={() => newTaskIn(group.path)}>
            <Plus size={14} />
          </button>
          {!group.pc && (
            <Dropdown
              placement="bottom"
              align="right"
              width={200}
              trigger={({ toggle }) => (
                <button type="button" className="icon-button small" aria-label={`${group.label} の操作`} onClick={toggle}>
                  <MoreHorizontal size={14} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    icon={<Pencil size={14} />}
                    label="名前を変更"
                    onSelect={() => {
                      close()
                      setName(group.label)
                      setRenaming(true)
                    }}
                  />
                  {!remote && (
                    <MenuItem
                      icon={<FolderOpen size={14} />}
                      label="フォルダを開く"
                      onSelect={() => {
                        close()
                        void act('workspace.open', { path: group.path, target: 'files' })
                      }}
                    />
                  )}
                  {rows.length === 0 && (
                    <MenuItem
                      icon={<X size={14} />}
                      label="一覧から外す"
                      onSelect={() => {
                        close()
                        void act('workspace.remove', { path: group.path })
                      }}
                    />
                  )}
                </>
              )}
            </Dropdown>
          )}
        </div>
      </div>
      {open && hasRows && (
        <ul>
          {draftHere && (
            <li className="thread-row active draft-row">
              <button
                type="button"
                className="thread-button"
                onClick={() => document.querySelector<HTMLTextAreaElement>('.home-composer textarea')?.focus()}
              >
                <span className="thread-title">新しいタスク</span>
              </button>
            </li>
          )}
          {rows.map((row) => (row.thread
            ? <ThreadRow key={row.id} thread={row.thread} active={activeId === row.id} selection={selection} />
            : <TerminalRow key={row.id} terminal={row.terminal!} active={activeId === row.id} selection={selection} />))}
        </ul>
      )}
    </section>
  )
}

export function Sidebar() {
  const threads = useStore((state) => state.server?.threads) ?? []
  const terminals = useStore((state) => state.server?.terminals) ?? []
  const workspaces = useStore((state) => state.server?.settings.workspaces) ?? []
  const myPc = useStore((state) => state.server?.app.myPc) ?? ''
  const names = useStore((state) => state.server?.settings.projectNames)
  const colors = useStore((state) => state.server?.settings.projectColors)
  const accounts = useStore((state) => state.server?.accounts)
  const updateOffered = useStore((state) => {
    const updates = state.server?.updates
    return Boolean(updates && (updates.app?.available || updates.dsh.available || updates.codex.available || updates.claude.available))
  })
  const route = useStore((state) => state.route)
  const draftWorkspace = useStore((state) => state.draft.workspace)
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const anchor = useRef<string | null>(null)
  const [confirming, setConfirming] = useState<string[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const tree = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (tree.current) tree.current.scrollTop = taskTreeScroll
  }, [])

  const needle = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const shown = (task: { archived: boolean; title: string; workspace: string }) => Boolean(task.archived) === archived
      && (!needle || task.title.toLowerCase().includes(needle) || task.workspace.toLowerCase().includes(needle))
    // A team's children show in their leader's panel, not as tasks of their own.
    const visible = threads.filter((thread) => !thread.team?.childId && shown(thread))
    const visibleTerminals = terminals.filter((terminal) => shown(terminal))
    // My PC first, then projects in recent-use order, then any project only a task remembers.
    const order = [myPc, ...workspaces, ...threads.map((thread) => thread.workspace), ...terminals.map((terminal) => terminal.workspace)].filter(Boolean)
    const result: Group[] = []
    for (const path of new Set(order)) {
      const pc = path === myPc
      result.push({
        path,
        pc,
        label: workspaceLabel(path, myPc, names),
        color: projectColor(colors, path),
        threads: visible.filter((thread) => thread.workspace === path),
        terminals: visibleTerminals.filter((terminal) => terminal.workspace === path),
      })
    }
    const any = (group: Group) => group.threads.length > 0 || group.terminals.length > 0
    // Searching or browsing the archive shows only groups with matches; otherwise projects stay listed.
    return needle || archived
      ? result.filter(any)
      : result.filter((group) => group.pc || any(group) || workspaces.includes(group.path))
  }, [threads, terminals, workspaces, myPc, names, colors, needle, archived])

  // Search/archive changes cannot leave hidden tasks selected for deletion.
  const availableIds = useMemo(() => new Set(groups.flatMap((group) => groupRows(group).map((row) => row.id))), [groups])
  const selectedIds = selected.filter((id) => availableIds.has(id))
  const visibleIds = groups.filter((group) => needle || !collapsed.includes(group.path))
    .flatMap((group) => groupRows(group).map((row) => row.id))
  useEffect(() => {
    setSelected((current) => {
      const next = current.filter((id) => availableIds.has(id))
      return next.length === current.length ? current : next
    })
  }, [availableIds])
  const clearSelection = () => {
    if (deleting) return
    setSelecting(false)
    setSelected([])
    anchor.current = null
  }
  const selection: ThreadSelection = {
    enabled: selecting,
    selected: new Set(selectedIds),
    busy: deleting,
    toggle: (id, range) => {
      if (deleting) return
      setSelecting(true)
      const from = anchor.current
      setSelected((current) => selectThreadRange(current, visibleIds, from, id, range))
      if (!range || from === null) anchor.current = id
    },
    group: (ids) => {
      if (deleting) return
      setSelecting(true)
      setSelected((current) => [...new Set([...current, ...ids])])
      anchor.current = ids[0] ?? null
    },
  }
  const removeSelected = async (ids: string[]) => {
    setDeleting(true)
    const failed: string[] = []
    // Reuse the removal fence, cancellation and durable index commit for each task.
    // No workspace/project removal RPC is called here.
    const terminalIds = new Set(terminals.map((terminal) => terminal.id))
    for (const threadId of ids) {
      try {
        if (terminalIds.has(threadId)) await request('terminal.remove', { terminalId: threadId })
        else await request('thread.remove', { threadId })
      } catch {
        failed.push(threadId)
      }
    }
    setDeleting(false)
    setSelected(failed)
    setSelecting(failed.length > 0)
    anchor.current = null
    if (failed.length) toast(`${ids.length - failed.length}件を削除しました。${failed.length}件の削除に失敗しました。接続や状態を確認して再試行してください。`, 'error')
    else toast(`${ids.length}件のセッションを削除しました。Projectは保持されています。`, 'success')
  }

  const toggle = (path: string) => {
    const next = collapsed.includes(path) ? collapsed.filter((entry) => entry !== path) : [...collapsed, path]
    setCollapsed(next)
    writeCollapsed(next)
  }

  const connected = [
    accounts?.chatgpt.signedIn && 'ChatGPT',
    accounts?.claude.configured && 'Claude',
    accounts?.deepseek.configured && 'DeepSeek',
    accounts?.opencodeGo?.configured && 'OpenCode Go',
    accounts?.localLlm?.configured && 'ローカル LLM',
  ].filter(Boolean)
  const activeId = route.view === 'thread' || route.view === 'terminal' ? route.id : null
  const archivedCount = threads.filter((thread) => thread.archived && !thread.team?.childId).length
    + terminals.filter((terminal) => terminal.archived).length

  return (
    <aside className="sidebar" aria-label="タスク">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">›_</span>
          <span>Agent Desk</span>
        </div>
        <button type="button" className="icon-button" title="サイドバーを閉じる (Ctrl+B)" aria-label="サイドバーを閉じる" onClick={() => setState({ sidebarOpen: false })}>
          <PanelLeftClose size={16} />
        </button>
      </div>
      <button type="button" className="nav-button" onClick={() => navigate({ view: 'home' })}>
        <SquarePen size={15} />
        <span>新しいタスク</span>
        <kbd>Ctrl N</kbd>
      </button>
      <label className="search">
        <Search size={14} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="タスクを検索" aria-label="タスクを検索" />
      </label>

      <div className="tasks-head">
        {archived
          ? (
            <button type="button" className="tasks-back" onClick={() => setArchived(false)}>
              <ArrowLeft size={13} /> アーカイブ
            </button>
          )
          : <span>タスク</span>}
        <span className="tasks-head-actions">
          <button type="button" className={`icon-button small ${selecting ? 'on' : ''}`}
            title="複数選択（Shiftクリックで範囲選択）" aria-label="セッションを複数選択" aria-pressed={selecting}
            disabled={deleting} onClick={() => selecting ? clearSelection() : setSelecting(true)}>
            <CheckSquare size={14} />
          </button>
          {!archived && (
            <button type="button" className="icon-button small" title="プロジェクトを作成" aria-label="プロジェクトを作成" onClick={openProjectDialog}>
              <FolderPlus size={14} />
            </button>
          )}
        <button
          type="button"
          className={`icon-button small ${archived ? 'on' : ''}`}
          title={archived ? 'タスクに戻る' : `アーカイブ済みを表示${archivedCount ? `（${archivedCount}）` : ''}`}
          aria-label="アーカイブ済みのタスク"
          aria-pressed={archived}
          onClick={() => setArchived(!archived)}
        >
          <Archive size={14} />
        </button>
        </span>
      </div>

      {selecting && (
        <div className="thread-selection-bar" aria-label="セッションの一括操作" aria-busy={deleting}>
          <div>
            <strong aria-live="polite">{deleting ? '削除中…' : `${selectedIds.length}件を選択`}</strong>
            <button type="button" className="icon-button small" aria-label="選択モードを終了" disabled={deleting} onClick={clearSelection}><X size={14} /></button>
          </div>
          <p>クリックで選択 · Shiftで範囲選択</p>
          <div>
            <button type="button" className="button" disabled={deleting || visibleIds.length === 0}
              onClick={() => setSelected([...visibleIds])}>表示中を全選択</button>
            <button type="button" className="button danger" disabled={deleting || selectedIds.length === 0}
              onClick={() => setConfirming([...selectedIds])}><Trash2 size={13} /> 削除</button>
          </div>
        </div>
      )}
      {confirming && (
        <ConfirmDialog title={`${confirming.length}件のセッションを削除しますか？`}
          body={<><p>選択したセッションの履歴を削除します。この操作は元に戻せません。実行中のセッションは停止します。</p><p><strong>Project本体と作業フォルダは削除しません。</strong></p></>}
          confirmLabel={`${confirming.length}件を削除`} danger
          onClose={() => setConfirming(null)} onConfirm={() => void removeSelected(confirming)} />
      )}

      <nav ref={tree} className={`task-tree ${selecting ? 'selecting' : ''}`} onScroll={(event) => { taskTreeScroll = event.currentTarget.scrollTop }}>
        {groups.length === 0 && (
          <p className="empty-note">
            {needle ? '一致するタスクはありません' : archived ? 'アーカイブしたタスクはありません' : 'タスクはまだありません'}
          </p>
        )}
        {groups.map((group) => (
          <TaskGroup
            key={group.path}
            group={group}
            collapsed={collapsed.includes(group.path)}
            onToggle={() => toggle(group.path)}
            draftHere={!archived && !needle && route.view === 'home' && draftWorkspace === group.path}
            activeId={activeId}
            searching={Boolean(needle)}
            selection={selection}
          />
        ))}
      </nav>

      <div className="sidebar-bottom">
        <UsageSummaryButton />
        <button
          type="button"
          className="nav-button"
          // On a phone the sidebar would stay open behind the dialog.
          onClick={() => setState({ settingsOpen: updateOffered ? 'about' : 'accounts', ...(isNarrow() ? { sidebarOpen: false } : {}) })}
        >
          <Settings size={15} />
          <span>設定</span>
          {updateOffered && <span className="update-dot" aria-label="更新があります" />}
          <span className="account-summary">{connected.length ? connected.join(' · ') : '未接続'}</span>
        </button>
      </div>
    </aside>
  )
}
