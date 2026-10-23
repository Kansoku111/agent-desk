import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, CheckCircle2, ChevronLeft, ChevronRight, CircleSlash, Loader2, MessageSquare, X, XCircle } from 'lucide-react'
import { setSubagentPanel, setState, useStore } from '../store'
import type { SubagentInfo, SubagentStatus, ThreadSummary, TurnItem } from '../types'
import { duration, formatTokens, formatUsd, summarizeTool } from '../util'
import { Markdown } from './Markdown'
import { Elapsed, Item } from './TurnView'

const STATUS_LABEL: Record<SubagentStatus, string> = {
  starting: '準備中',
  running: '実行中',
  done: '完了',
  error: 'エラー',
  cancelled: '停止',
  stopped: '中断',
}

const isActive = (subagent: SubagentInfo) => subagent.status === 'running' || subagent.status === 'starting'

function StatusIcon({ status }: { status: SubagentStatus }) {
  if (status === 'running' || status === 'starting') return <Loader2 size={14} className="spin" />
  if (status === 'done') return <CheckCircle2 size={14} />
  if (status === 'error') return <XCircle size={14} />
  return <CircleSlash size={14} />
}

/** The first line of Markdown as plain text (no heading, list or quote marks). */
function firstLine(text: string, max = 120) {
  const line = text.replace(/\*\*/g, '').split('\n').map((part) => part.replace(/^\s*(#{1,6}|[-*>])\s+/, '').trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** One line on what the subagent is doing now (or did last). */
function activity(subagent: SubagentInfo) {
  const last = subagent.items.at(-1)
  if (!last) return isActive(subagent) ? '考えています…' : ''
  switch (last.type) {
    case 'tool': {
      const summary = summarizeTool(last)
      return [summary.verb, summary.target].filter(Boolean).join(' ')
    }
    case 'agent':
    case 'thought':
      return firstLine(last.text)
    case 'steer':
      return 'メッセージを受け取りました'
    case 'notice':
      return last.text
    default:
      return ''
  }
}

function title(subagent: SubagentInfo) {
  return subagent.label || subagent.title || firstLine(subagent.prompt, 60) || 'サブエージェント'
}

function modelLabel(subagent: SubagentInfo) {
  return subagent.modelName ?? subagent.model ?? 'モデル不明'
}

function Took({ subagent }: { subagent: SubagentInfo }) {
  if (!subagent.startedAt) return null
  if (isActive(subagent)) return <Elapsed since={subagent.startedAt} />
  const end = subagent.endedAt ?? subagent.updatedAt
  return end ? <>{duration(end - subagent.startedAt)}</> : null
}

function Card({ subagent, onOpen }: { subagent: SubagentInfo; onOpen: () => void }) {
  const doing = activity(subagent)
  return (
    <button
      type="button"
      className={`subagent-card status-${subagent.status}`}
      style={{ marginLeft: (subagent.depth - 1) * 14 }}
      onClick={onOpen}
    >
      <div className="subagent-card-head">
        <span className="subagent-status" title={STATUS_LABEL[subagent.status]}><StatusIcon status={subagent.status} /></span>
        <span className="subagent-model">{modelLabel(subagent)}</span>
        {subagent.effort && <span className="subagent-effort">{subagent.effort}</span>}
        <span className="subagent-time"><Took subagent={subagent} /></span>
      </div>
      <div className="subagent-card-title">{title(subagent)}</div>
      {doing && <div className="subagent-card-activity">{doing}</div>}
      <ChevronRight size={14} className="subagent-card-chev" />
    </button>
  )
}

function List({ subagents }: { subagents: SubagentInfo[] }) {
  // Newest first, each child right under the subagent that started it.
  const ordered = useMemo(() => {
    const byParent = new Map<string | null, SubagentInfo[]>()
    for (const subagent of subagents) {
      const key = subagents.some((other) => other.id === subagent.parentId) ? subagent.parentId : null
      byParent.set(key, [...(byParent.get(key) ?? []), subagent])
    }
    const out: SubagentInfo[] = []
    const visit = (key: string | null) => {
      const level = [...(byParent.get(key) ?? [])].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      for (const subagent of level) {
        out.push(subagent)
        visit(subagent.id)
      }
    }
    visit(null)
    return out
  }, [subagents])
  const running = subagents.filter(isActive).length
  return (
    <>
      <div className="subagent-panel-head">
        <Bot size={15} />
        <span className="subagent-panel-title">サブエージェント</span>
        <span className="subagent-panel-count">{running > 0 ? `実行中 ${running} / ${subagents.length}` : `${subagents.length} 件`}</span>
        <button type="button" className="icon-button small" aria-label="パネルを閉じる" title="パネルを閉じる" onClick={() => setSubagentPanel(false)}>
          <X size={15} />
        </button>
      </div>
      <div className="subagent-list">
        {ordered.map((subagent) => (
          <Card key={subagent.id} subagent={subagent} onOpen={() => setState({ subagentFocus: subagent.id })} />
        ))}
      </div>
    </>
  )
}

/** A message the subagent received after its task: from its parent, or another agent. */
function Message({ item }: { item: Extract<TurnItem, { type: 'steer' }> }) {
  return (
    <div className="subagent-message">
      <div className="subagent-message-head"><MessageSquare size={12} />{item.from === 'agent' ? 'エージェントからのメッセージ' : '追加の指示'}</div>
      <div className="subagent-message-text">{item.text}</div>
    </div>
  )
}

function Detail({ subagent, workspace }: { subagent: SubagentInfo; workspace: string }) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showTask, setShowTask] = useState(false)
  const active = isActive(subagent)

  useEffect(() => {
    stick.current = true
  }, [subagent.id])

  // Follow new work while the reader stays at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [subagent])

  const { usage } = subagent
  return (
    <>
      <div className="subagent-panel-head">
        <button type="button" className="icon-button small" aria-label="一覧に戻る" title="一覧に戻る" onClick={() => setState({ subagentFocus: null })}>
          <ChevronLeft size={16} />
        </button>
        <span className="subagent-panel-title" title={title(subagent)}>{title(subagent)}</span>
        <button type="button" className="icon-button small" aria-label="パネルを閉じる" title="パネルを閉じる" onClick={() => setSubagentPanel(false)}>
          <X size={15} />
        </button>
      </div>
      <div
        className="subagent-detail"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
        }}
      >
        <div className="subagent-meta">
          <span className={`subagent-badge status-${subagent.status}`}><StatusIcon status={subagent.status} />{STATUS_LABEL[subagent.status]}</span>
          <span className="subagent-chip"><Bot size={12} />{modelLabel(subagent)}{subagent.effort ? ` · ${subagent.effort}` : ''}</span>
          <span className="subagent-chip"><Took subagent={subagent} /></span>
          {subagent.mode === 'continuable' && <span className="subagent-chip" title="バックグラウンドで動き、親からの追加の指示を受け取れます">継続型</span>}
        </div>
        {usage.requests > 0 && (
          <div className="subagent-usage">
            入力 {formatTokens(usage.input + usage.cacheRead + usage.cacheWrite)} · 出力 {formatTokens(usage.output)}
            {usage.cost !== null && ` · 約 ${formatUsd(usage.cost)}`}
          </div>
        )}
        {subagent.prompt && (
          <div className={`subagent-task ${showTask ? 'open' : ''}`}>
            <button type="button" className="subagent-task-head" onClick={() => setShowTask(!showTask)} aria-expanded={showTask}>
              <span>依頼内容</span>
              <ChevronRight size={13} className={`chev ${showTask ? 'open' : ''}`} />
            </button>
            <div className="subagent-task-text">{subagent.prompt}</div>
          </div>
        )}
        <div className="subagent-items">
          {subagent.items.map((item) => item.type === 'steer'
            ? <Message key={`steer-${item.id}`} item={item} />
            : item.type === 'agent'
              ? <div key={`agent-${item.id}`} className="agent-text"><Markdown text={item.text} workspace={workspace} /></div>
              : <Item key={`${item.type}-${item.id}`} item={item} workspace={workspace} />)}
        </div>
        {active && (
          <div className="working">
            <span className="shimmer">作業中</span>
          </div>
        )}
        {subagent.status === 'stopped' && <div className="turn-status">アプリか実行環境の終了で中断されました。</div>}
      </div>
    </>
  )
}

/** The right-hand panel: a task's subagents, live, and what each one is doing. */
export const SubagentPanel = memo(function SubagentPanel({ thread }: { thread: ThreadSummary }) {
  const subagents = useStore((state) => state.subagents[thread.id])
  const focus = useStore((state) => state.subagentFocus)
  const selected = subagents?.find((subagent) => subagent.id === focus)
  if (!subagents?.length) return null
  return (
    <>
      {/* On a phone the panel covers the task; a tap beside it closes it. */}
      <div className="subagent-backdrop" aria-hidden="true" onClick={() => setSubagentPanel(false)} />
      <aside className="subagent-panel" aria-label="サブエージェント">
        {selected ? <Detail subagent={selected} workspace={thread.workspace} /> : <List subagents={subagents} />}
      </aside>
    </>
  )
})
