import { memo, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Bot, ChevronDown, ChevronRight, FilePen, FilePlus2, FileText, Globe, Image as ImageIcon,
  Info, ListChecks, Loader2, MonitorCog, Search, ShieldQuestion, SquareTerminal, Wrench, X,
} from 'lucide-react'
import { act, attachmentUrl, isImageAttachment, setSubagentPanel, useStore, type State } from '../store'
import type { ImageRef, NoticeItem, PlanItem, SteerItem, SubagentInfo, TextItem, ToolItem, Turn, TurnItem, TurnUsage, UsageScore } from '../types'
import { UsageCost } from './UsageCost'
import { duration, fileChanges, formatTokens, formatTokensExact, formatUsd, summarizeTool, type DiffLine, type ToolIcon } from '../util'
import { CopyButton, Markdown } from './Markdown'
import { FileRef } from './FileRef'
import { RestoreControls } from './Restore'
import { turnAnswer } from '../turn-answer'

const ICONS: Record<ToolIcon, typeof Wrench> = {
  terminal: SquareTerminal,
  edit: FilePen,
  create: FilePlus2,
  read: FileText,
  search: Search,
  web: Globe,
  desktop: MonitorCog,
  agent: Bot,
  plan: ListChecks,
  image: ImageIcon,
  tool: Wrench,
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="diff">
      {lines.map((line, index) => line.type === 'gap'
        ? <div key={index} className="diff-gap">⋯</div>
        : (
          <div key={index} className={`diff-line diff-${line.type}`}>
            <span className="diff-sign">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
            <span className="diff-text">{line.text || ' '}</span>
          </div>
        ))}
    </div>
  )
}

function ApprovalCard({ item, workspace }: { item: ToolItem; workspace: string }) {
  const summary = summarizeTool(item, workspace)
  const input = (item.input ?? {}) as Record<string, unknown>
  const justification = typeof input.justification === 'string' ? input.justification : null
  const options = item.permission?.options ?? []
  const [busy, setBusy] = useState(false)
  const respond = async (optionId: string | null) => {
    setBusy(true)
    await act('permission.respond', { requestId: item.permission!.requestId, optionId })
    setBusy(false)
  }
  const label = (kind: string, name: string) => ({
    allow_once: '許可',
    allow_always: '常に許可',
    reject_once: '拒否',
    reject_always: '常に拒否',
  } as Record<string, string>)[kind] ?? name
  return (
    <div className="approval-card" role="alertdialog" aria-label="実行の承認">
      <div className="approval-head">
        <ShieldQuestion size={16} />
        <span>この操作を許可しますか？</span>
      </div>
      {justification && <p className="approval-reason">{justification}</p>}
      <pre className="approval-command">{summary.detail?.kind === 'code' ? summary.detail.text.split('\n\n')[0] : `${summary.verb} ${summary.target}`}</pre>
      <div className="approval-actions">
        {options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            disabled={busy}
            className={option.kind.startsWith('allow') ? 'button primary' : 'button'}
            onClick={() => respond(option.optionId)}
          >
            {label(option.kind, option.name)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The subagent a tool call started, once its log has been read. */
function startedSubagent(state: State, item: ToolItem): SubagentInfo | null {
  if (!item.name.startsWith('subagent')) return null
  for (const list of Object.values(state.subagents)) {
    const found = list.find((entry) => entry.callId === item.id)
    if (found) return found
  }
  return null
}

const ToolRow = memo(function ToolRow({ item, workspace }: { item: ToolItem; workspace: string }) {
  const [open, setOpen] = useState(false)
  const subagent = useStore((state) => startedSubagent(state, item))
  const summary = summarizeTool(item, workspace)
  const Icon = ICONS[summary.icon]
  const running = item.status === 'in_progress' || item.status === 'pending'
  const failed = item.status === 'failed'
  const expandable = Boolean(summary.detail)
  return (
    <div className={`tool-row ${failed ? 'failed' : ''}`}>
      <div className="tool-head">
        <button
          type="button"
          className="tool-line"
          onClick={() => expandable && setOpen(!open)}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
        >
          <span className="tool-icon">{running ? <Loader2 size={14} className="spin" /> : <Icon size={14} />}</span>
          <span className="tool-verb">{summary.verb}</span>
          {summary.target && <code className="tool-target">{summary.target}</code>}
          {summary.added !== undefined && (summary.added > 0 || (summary.removed ?? 0) > 0) && (
            <span className="tool-counts">
              <span className="plus">+{summary.added}</span>
              {(summary.removed ?? 0) > 0 && <span className="minus">−{summary.removed}</span>}
            </span>
          )}
          {item.decision === 'rejected' && <span className="badge danger">拒否</span>}
          {failed && item.decision !== 'rejected' && <span className="badge danger">失敗</span>}
          {expandable && <ChevronRight size={14} className={`chev ${open ? 'open' : ''}`} />}
        </button>
        {subagent && (
          <button
            type="button"
            className="subagent-link"
            title="このサブエージェントの作業を右のパネルで表示"
            onClick={() => setSubagentPanel(true, subagent.id)}
          >
            <Bot size={12} />
            {subagent.modelName ?? subagent.model ?? 'サブエージェント'}
          </button>
        )}
      </div>
      {summary.images && summary.images.length > 0 && (
        <div className="tool-images">
          {summary.images.map((file) => (
            <FileRef key={file} refText={summary.savedPath} workspace={workspace}>
              <img src={attachmentUrl(file)} alt="生成した画像" loading="lazy" />
            </FileRef>
          ))}
        </div>
      )}
      {open && summary.detail && (
        <div className="tool-detail">
          {summary.detail.kind === 'diff'
            ? <DiffView lines={summary.detail.lines} />
            : (
              <div className="tool-output">
                <div className="tool-output-bar"><CopyButton text={summary.detail.text} /></div>
                <pre>{summary.detail.text}</pre>
              </div>
            )}
        </div>
      )}
    </div>
  )
})

function Thought({ item }: { item: TextItem }) {
  const [open, setOpen] = useState(false)
  const first = item.text.replace(/\*\*/g, '').split('\n').find((line) => line.trim()) ?? '考え中'
  return (
    <div className="thought">
      <button type="button" className="thought-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="thought-title">{first.length > 90 ? `${first.slice(0, 89)}…` : first}</span>
        <ChevronRight size={14} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && <div className="thought-body"><Markdown text={item.text} /></div>}
    </div>
  )
}

function Notice({ item }: { item: NoticeItem }) {
  return (
    <div className={`notice notice-${item.level}`}>
      {item.level === 'warning' ? <AlertTriangle size={14} /> : <Info size={14} />}
      <span>{item.text}</span>
    </div>
  )
}

function Plan({ item }: { item: PlanItem }) {
  return (
    <div className="plan">
      <div className="plan-title"><ListChecks size={14} /> 計画</div>
      <ul>
        {item.entries.map((entry, index) => (
          <li key={index} className={`plan-${entry.status}`}>{entry.content}</li>
        ))}
      </ul>
    </div>
  )
}

function UserBubble({ text, images, note }: { text: string; images: ImageRef[]; note?: string }) {
  const pictures = (images ?? []).filter(isImageAttachment)
  const files = (images ?? []).filter((entry) => !isImageAttachment(entry))
  return (
    <div className="user-row">
      <div className="user-bubble">
        {pictures.length > 0 && (
          <div className="user-images">
            {pictures.map((image) => (
              <img key={image.file} src={attachmentUrl(image.file)} alt={image.name || '添付画像'} />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="user-files">
            {files.map((file) => (
              <span key={file.file} className="user-file" title={file.name}><FileText size={13} />{file.name || 'ファイル'}</span>
            ))}
          </div>
        )}
        {text && <div className="user-text">{text}</div>}
        {note && <div className="user-note">{note}</div>}
      </div>
    </div>
  )
}

/** A message the user sent into the running turn. */
function Steer({ item }: { item: SteerItem }) {
  return <UserBubble text={item.text} images={item.images} note="作業中に送信" />
}

export const Item = memo(function Item({ item, workspace }: { item: TurnItem; workspace: string }) {
  switch (item.type) {
    case 'agent':
      return <div className="agent-text"><Markdown text={item.text} workspace={workspace} /></div>
    case 'thought':
      return <Thought item={item} />
    case 'tool':
      return <ToolRow item={item} workspace={workspace} />
    case 'notice':
      return <Notice item={item} />
    case 'plan':
      return <Plan item={item} />
    case 'steer':
      return <Steer item={item} />
  }
})

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <>{duration(now - since)}</>
}

function FileChanges({ turn, workspace }: { turn: Turn; workspace: string }) {
  const changes = useMemo(() => fileChanges(turn, workspace), [turn, workspace])
  const [open, setOpen] = useState(false)
  if (!changes.length) return null
  const added = changes.reduce((sum, change) => sum + change.added, 0)
  const removed = changes.reduce((sum, change) => sum + change.removed, 0)
  const edits = turn.items.filter((item): item is ToolItem => item.type === 'tool' && item.status === 'completed')
  return (
    <div className="changes-card">
      <button type="button" className="changes-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{changes.length} 個のファイルを変更</span>
        <span className="tool-counts"><span className="plus">+{added}</span>{removed > 0 && <span className="minus">−{removed}</span>}</span>
        <ChevronDown size={14} className={`chev-down ${open ? 'open' : ''}`} />
      </button>
      <ul className="changes-list">
        {changes.map((change) => (
          <li key={change.path}>
            {change.created ? <FilePlus2 size={13} /> : <FilePen size={13} />}
            <FileRef refText={change.path} workspace={workspace}><code>{change.path}</code></FileRef>
            <span className="tool-counts"><span className="plus">+{change.added}</span>{change.removed > 0 && <span className="minus">−{change.removed}</span>}</span>
          </li>
        ))}
      </ul>
      {open && (
        <div className="changes-diffs">
          {edits.map((item) => {
            const summary = summarizeTool(item, workspace)
            if ((summary.icon !== 'edit' && summary.icon !== 'create') || summary.detail?.kind !== 'diff') return null
            return (
              <div key={item.id} className="changes-diff">
                <div className="changes-diff-path">{summary.target}</div>
                <DiffView lines={summary.detail.lines} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The same compact readout while streaming and in the finished usage footer. */
function OutputSpeed({ speed }: { speed: Turn['outputSpeed'] }) {
  if (!speed || speed.state === 'paused' || !Number.isFinite(speed.tokensPerSecond) || speed.tokensPerSecond <= 0) return null
  const state = speed.state
  const detail = 'この応答の平均出力速度（本文・受信できる思考から推定）'
  return (
    <span
      className={`output-speed ${state}`}
      title={`${detail}。通信のまとめ送りやモデルのトークン分割により誤差があります。`}
      aria-label={`この応答の平均推定出力速度 毎秒${speed.tokensPerSecond}トークン`}
    >
      ≈ {speed.tokensPerSecond.toLocaleString('en-US', { maximumFractionDigits: 1 })} t/s
    </span>
  )
}

/** Per-turn tokens with cumulative API-equivalent USD; metered estimates stay in the detail. */
function UsageLine({ usage, taskCost, speed, score }: { usage: TurnUsage; taskCost: number | null; speed: Turn['outputSpeed']; score?: UsageScore | null }) {
  const inputTotal = usage.input + usage.cacheRead + usage.cacheWrite
  const detail = [
    `リクエスト ${usage.requests} 回`,
    `入力 ${formatTokensExact(usage.input)}`,
    usage.cacheRead ? `キャッシュ読み込み ${formatTokensExact(usage.cacheRead)}` : null,
    usage.cacheWrite ? `キャッシュ書き込み ${formatTokensExact(usage.cacheWrite)}` : null,
    `出力 ${formatTokensExact(usage.output)}`,
    usage.reasoning ? `うち推論 ${formatTokensExact(usage.reasoning)}` : null,
    usage.models.length ? `モデル: ${usage.models.map((model) => model.split('/')[1]).join(', ')}` : null,
    usage.cost !== null ? `このターンの従量課金概算 ${formatUsd(usage.cost)}` : null,
    usage.cost !== null && taskCost !== null && taskCost > usage.cost ? `このセッションの従量課金概算累計 ${formatUsd(taskCost)}` : null,
    usage.cost !== null ? 'モデルの単価に基づく概算です。正確な請求額は各社の管理画面で確認してください。' : null,
    usage.cost !== null && usage.models.some((model) => model.startsWith('deepseek-official/'))
      ? 'DeepSeek は公式料金表と応答記録の時刻でピーク／オフピーク料金を適用します。' : null,
  ].filter(Boolean).join('\n')
  return (
    <div className="usage-line" title={detail}>
      <UsageCost score={score} detail={detail} />
      <span>· 入力 {formatTokens(inputTotal)}</span>
      {usage.cacheRead > 0 && <span className="usage-sub">（キャッシュ {formatTokens(usage.cacheRead)}）</span>}
      <span>· 出力 {formatTokens(usage.output)}</span>
      <OutputSpeed speed={speed} />
    </div>
  )
}

export const TurnView = memo(function TurnView({ turn, workspace, taskCost = null, taskScore, threadId, threadBusy, undoable, hideUser = false }: {
  turn: Turn
  /** Leave out the request bubble, when the request is shown elsewhere. */
  hideUser?: boolean
  workspace: string
  taskCost?: number | null
  taskScore?: UsageScore | null
  threadId: string
  /** The task is working, so its files cannot be restored now. */
  threadBusy: boolean
  /** This turn holds the restore that can still be undone. */
  undoable: boolean
}) {
  const running = turn.status === 'running'
  const [expanded, setExpanded] = useState(false)
  // When the turn ends with an answer, earlier steps fold into "worked for…".
  const answer = running ? [] : turnAnswer(turn.items)
  const finalAnswer = answer.length > 0
  const steps = finalAnswer ? turn.items.filter((item) => !answer.includes(item as TextItem)) : turn.items
  const notices = steps.filter((item) => item.type === 'notice')
  // Notices have their own slot above the steps, including while the turn is running.
  const work = steps.filter((item) => item.type !== 'notice')
  const steers = steps.filter((item): item is SteerItem => item.type === 'steer')
  const pending = turn.items.filter((item): item is ToolItem => item.type === 'tool' && Boolean(item.permission))
  const toolCount = turn.items.filter((item) => item.type === 'tool').length
  const showSteps = running || !finalAnswer || expanded
  const foldable = finalAnswer && work.length > 0
  // Every finished turn shows how long it took, even with nothing to fold.
  const workedLabel = !running && turn.endedAt ? (
    <>
      <span>{duration(turn.endedAt - turn.startedAt)} 作業しました</span>
      {toolCount > 0 && <span className="worked-meta">· ツール {toolCount} 回</span>}
    </>
  ) : null

  return (
    <section className="turn">
      {!hideUser && <UserBubble text={turn.user.text} images={turn.user.images} />}

      {notices.map((item) => <Notice key={item.id} item={item as NoticeItem} />)}
      {/* Folded steps still show what the user added during the turn. */}
      {!showSteps && steers.map((item) => <Steer key={item.id} item={item} />)}

      {workedLabel && (foldable ? (
        <button type="button" className="worked" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {workedLabel}
          <ChevronRight size={14} className={`chev ${expanded ? 'open' : ''}`} />
        </button>
      ) : (
        <div className="worked static">{workedLabel}</div>
      ))}

      {showSteps && work.length > 0 && (
        <div className={`steps ${finalAnswer ? 'folded' : ''}`}>
          {work.map((item) => <Item key={`${item.type}-${item.id}`} item={item} workspace={workspace} />)}
        </div>
      )}

      {pending.map((item) => <ApprovalCard key={item.permission!.requestId} item={item} workspace={workspace} />)}

      {running && (
        <div className="working">
          <span className="shimmer">{pending.length ? '承認を待っています' : '作業中'}</span>
          <span className="working-time"><Elapsed since={turn.startedAt} /></span>
          <OutputSpeed speed={turn.outputSpeed} />
        </div>
      )}

      {finalAnswer && (
        <div className="answer">
          {answer.map((item) => (
            <div key={item.id} className="agent-text"><Markdown text={item.text} workspace={workspace} /></div>
          ))}
          <div className="answer-actions"><CopyButton text={answer.map((item) => item.text).join('\n\n')} label="回答をコピー" /></div>
        </div>
      )}

      {!running && <FileChanges turn={turn} workspace={workspace} />}

      {turn.status === 'cancelled' && (
        <div className="turn-status"><X size={13} /> 停止しました</div>
      )}
      {turn.status === 'error' && turn.error && <TurnError error={turn.error} />}
      {!running && turn.usage && <UsageLine usage={turn.usage} taskCost={taskCost} speed={turn.outputSpeed} score={taskScore ?? turn.totalScore ?? turn.usage.score} />}
      {!running && !turn.usage && <div className="usage-line"><UsageCost score={taskScore ?? turn.totalScore} /><OutputSpeed speed={turn.outputSpeed} /></div>}
      {!running && <RestoreControls threadId={threadId} turn={turn} busy={threadBusy} undoable={undoable} />}
    </section>
  )
})

function TurnError({ error }: { error: NonNullable<Turn['error']> }) {
  const [open, setOpen] = useState(false)
  const chatgptPlanLimit = /subscription_sharing_usage_limit_exceeded/i.test(
    `${error.message}\n${error.detail ?? ''}`,
  )
  return (
    <div className="turn-error" role="alert">
      <div className="turn-error-head">
        <AlertTriangle size={15} />
        <span>{error.message}</span>
        {error.detail && error.detail !== error.message && (
          <button type="button" className="link-button" onClick={() => setOpen(!open)}>{open ? '詳細を隠す' : '詳細'}</button>
        )}
      </div>
      {chatgptPlanLimit && (
        <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">
          ChatGPT Settings → Usage
        </a>
      )}
      {open && error.detail && <pre className="turn-error-detail">{error.detail}</pre>}
    </div>
  )
}
