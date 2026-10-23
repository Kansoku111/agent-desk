import { memo, useState } from 'react'
import {
  ArrowLeft, CheckCircle2, ChevronRight, CircleDot, CircleSlash, Crown, Gauge, Loader2, MessageCircleQuestion, Network, RefreshCw, ShieldAlert, SlidersHorizontal, Square, Users, X, XCircle,
} from 'lucide-react'
import { act, navigate, openTeamChild, setTeamPanel, useStore } from '../store'
import type { AppState, TeamChild, TeamChildState, TeamSummary, TerminalSummary, ThreadSummary } from '../types'
import { effortLabel, relativeTime, resetLabel } from '../util'
import { ChatGptLimits } from './ChatGptUsage'
import { ConfirmDialog, Modal } from './Modal'
import { TeamConfigDialog } from './TeamSettings'
import { claudeModelName } from './TerminalPickers'

const STATE_LABEL: Record<TeamChildState, string> = {
  running: '作業中',
  approval: '承認待ち',
  idle: '待機中',
  closed: '完了',
  error: 'エラー',
  stopped: '停止中',
  removed: '削除済み',
  resuming: '再開待ち',
}
const PROVIDER_LABEL = { gpt: 'GPT', claude: 'Claude', claudeApi: 'Claude API', deepseek: 'DeepSeek', local: 'ローカル' }

const isActive = (state: TeamChildState) => state === 'running' || state === 'approval'
/** What 全停止 stops: work under way, and work about to go on by itself. */
const isStoppable = (state: TeamChildState) => isActive(state) || state === 'resuming'

/** An idle child whose last turn ended in a report is waiting for the leader's audit. */
export function stateLabel(child: TeamChild) {
  if (child.state === 'idle' && child.lastReport?.kind === 'report') return '報告済み'
  return STATE_LABEL[child.state]
}

export function StateIcon({ state, size = 14 }: { state: TeamChildState; size?: number }) {
  if (state === 'running') return <Loader2 size={size} className="spin" />
  if (state === 'approval') return <ShieldAlert size={size} />
  if (state === 'resuming') return <RefreshCw size={size} />
  if (state === 'closed') return <CheckCircle2 size={size} />
  if (state === 'error') return <XCircle size={size} />
  if (state === 'idle') return <CircleDot size={size} />
  return <CircleSlash size={size} />
}

/** The leader's state in the same words as a child's. */
function leaderState(leader: TerminalSummary | ThreadSummary | undefined): TeamChildState {
  if (!leader) return 'stopped'
  if ('activity' in leader) {
    if (leader.state !== 'running') return 'stopped'
    if (leader.activity === 'approval') return 'approval'
    return leader.activity === 'running' ? 'running' : 'idle'
  }
  if (leader.pendingApproval) return 'approval'
  if (leader.status === 'running') return 'running'
  return leader.status === 'error' ? 'error' : 'idle'
}

/** A team's leader task: a Claude Code task, or a GPT (dsh) task. */
function useLeader(team: TeamSummary | undefined) {
  return useStore((state) => (!team ? undefined
    : team.leaderKind === 'thread'
      ? state.server?.threads.find((entry) => entry.id === team.leaderId)
      : state.server?.terminals.find((entry) => entry.id === team.leaderId)))
}

/** The leader as the diagram shows it: its model and what runs it. */
function leaderModel(server: AppState | null, leader: TerminalSummary | ThreadSummary | undefined) {
  if (!leader) return ''
  if ('activity' in leader) return claudeModelName(server, leader.model ?? leader.modelInUse) ?? 'Claude Code の既定'
  return server?.catalog.models.find((model) => model.value === leader.model)?.name ?? 'GPT'
}

/** The view a team's leader opens in. */
const leaderRoute = (team: TeamSummary) => ({ view: team.leaderKind === 'thread' ? 'thread' as const : 'terminal' as const, id: team.leaderId })

export function useTeam(teamId: string | null | undefined) {
  return useStore((state) => (teamId ? state.server?.teams?.find((team) => team.id === teamId) : undefined))
}

/** The team a Claude Code task leads, if any. */
export function useLedTeam(terminalId: string) {
  return useStore((state) => state.server?.teams?.find((team) => team.leaderId === terminalId))
}

/** Whether a team needs the user: an approval nobody decided yet, or a question from the leader. */
export const teamNeedsUser = (team: TeamSummary | undefined) => Boolean(team && (team.approvals.length || team.asks.length || team.delivery === 'failed'))

/** First in a child's header: one button back to the team's leader (stays on a narrow screen, unlike the chips). */
export function BackToLeader({ teamId, childId }: { teamId: string; childId?: string }) {
  const team = useTeam(teamId)
  const leader = useLeader(team)
  const child = team?.children.find((entry) => entry.id === childId)
  if (!team) return null
  return (
    <button
      type="button"
      className="button ghost back-to-leader"
      title={`${child ? `チームの子「${child.name}」。` : ''}リーダー「${leader?.title ?? ''}」の会話に戻ります`}
      onClick={() => navigate(leaderRoute(team))}
    >
      <ArrowLeft size={14} />
      <span>リーダーに戻る</span>
      {teamNeedsUser(team) && <span className="team-attention" aria-label="確認が必要です" />}
    </button>
  )
}

/** In a leader's header: shows or hides the team panel once the leader started children. */
export function TeamToggle({ team }: { team: TeamSummary | undefined }) {
  const open = useStore((state) => state.teamPanel)
  if (!team?.children.length) return null
  const running = team.children.filter((child) => isActive(child.state)).length
  return (
    <button
      type="button"
      className={`button ghost subagent-toggle ${open ? 'active' : ''}`}
      aria-pressed={open}
      title={open ? 'チームのパネルを閉じる' : 'チームのパネルを開く'}
      onClick={() => setTeamPanel(!open)}
    >
      <Users size={14} />
      <span>{running > 0 ? `${running} 作業中` : team.children.length}</span>
      {running > 0 && <span className="subagent-dot" aria-hidden="true" />}
      {teamNeedsUser(team) && <span className="team-attention" aria-label="確認が必要です" />}
    </button>
  )
}

function Notices({ team }: { team: TeamSummary }) {
  const nameOf = (childId: string | null) => team.children.find((child) => child.id === childId)?.name
  const waiting = team.queue.length
  return (
    <>
      {team.asks.map((ask) => (
        <div key={ask.id} className="team-notice ask" role="status">
          <MessageCircleQuestion size={15} />
          <div className="team-notice-body">
            <strong>リーダーからの確認{nameOf(ask.childId) ? `（子「${nameOf(ask.childId)}」について）` : ''}</strong>
            <p>{ask.text}</p>
            <p className="muted">この会話でリーダーに答えてください。</p>
          </div>
          <button type="button" className="icon-button small" title="対応済みにする" aria-label="対応済みにする"
            onClick={() => void act('team.dismissAsk', { teamId: team.id, askId: ask.id })}>
            <X size={14} />
          </button>
        </div>
      ))}
      {team.approvals.map((approval) => (
        <div key={approval.id} className="team-notice approval" role="status">
          <ShieldAlert size={15} />
          <div className="team-notice-body">
            <strong>子「{nameOf(approval.childId) ?? '?'}」が承認待ち</strong>
            <p className="team-notice-tool">{approval.tool}</p>
            <p className="muted">リーダーが判断します。ここで代わりに決めることもできます。</p>
            <div className="team-notice-actions">
              <button type="button" className="button primary"
                onClick={() => void act('team.approve', { teamId: team.id, approvalId: approval.id, allow: true })}>許可</button>
              <button type="button" className="button"
                onClick={() => void act('team.approve', { teamId: team.id, approvalId: approval.id, allow: false })}>拒否</button>
            </div>
          </div>
        </div>
      ))}
      {team.delivery === 'failed' && (
        <div className="team-notice error" role="status">
          <XCircle size={15} />
          <div className="team-notice-body">
            <strong>報告をリーダーに渡せませんでした</strong>
            <p className="muted">
              {team.leaderKind === 'thread' ? 'リーダーのタスクが受け付けませんでした。'
                : '2 分待っても Claude Code が受け付けませんでした。入力欄に残っていれば、Enter で送ると続きの報告も届きます。'}
              {waiting ? `報告 ${waiting} 件が待っています。` : ''}
            </p>
            <div className="team-notice-actions">
              <button type="button" className="button" onClick={() => void act('team.deliver', { teamId: team.id })}><RefreshCw size={13} /> もう一度渡す</button>
            </div>
          </div>
        </div>
      )}
      {team.delivery === 'leader-stopped' && (
        <div className="team-notice" role="status">
          <CircleSlash size={15} />
          <div className="team-notice-body">
            <strong>リーダーが終了しています</strong>
            <p className="muted">会話を再開すると、待っている報告 {waiting} 件を順に届けます。</p>
          </div>
        </div>
      )}
      {(team.delivery === 'waiting' || team.delivery === 'delivering') && waiting > 0 && (
        <p className="team-queue-note">
          {team.delivery === 'delivering' ? '報告をリーダーに渡しています…' : `報告 ${waiting} 件が、リーダーの手が空くのを待っています。`}
        </p>
      )}
    </>
  )
}

function ChildCard({ child }: { child: TeamChild }) {
  const quiet = !isActive(child.state)
  const opens = Boolean(child.taskId) && child.state !== 'removed'
  return (
    <button
      type="button"
      className={`subagent-card team-card state-${child.state} ${quiet ? 'quiet' : ''}`}
      onClick={() => openTeamChild(child)}
      disabled={!opens}
      title={opens ? `${child.name} の作業を開く` : undefined}
    >
      <div className="subagent-card-head">
        <span className="team-card-status" title={stateLabel(child)}><StateIcon state={child.state} /></span>
        <span className="team-card-name">{child.name}</span>
        <span className={`team-provider ${child.provider}`}>{PROVIDER_LABEL[child.provider]}</span>
        <span className="subagent-time">{stateLabel(child)}</span>
      </div>
      <div className="subagent-card-title">{child.title}</div>
      <div className="subagent-card-activity">
        {child.modelName}{child.effort ? `・${effortLabel(child.effort)}` : ''}
        {child.pending > 0 && ` · 指示 ${child.pending} 件が待機中`}
      </div>
      {opens && <ChevronRight size={14} className="subagent-card-chev" />}
    </button>
  )
}

/**
 * The Claude subscription's limits as the team's last Claude run reported them.
 * Nothing refreshes them on its own: they update whenever a team's Claude works.
 */
function ClaudeLimitsCard() {
  const limits = useStore((state) => state.server?.claudeLimits ?? null)
  const now = Date.now()
  if (!limits || limits.windows.length === 0) {
    return (
      <div className="limits team-limits">
        <div className="limits-head"><span>Claude サブスクリプションの利用上限</span></div>
        <p className="fine-print">まだ取得していません。Claude Code が上限情報を出力すると表示されます。API・クラウドの料金や残高ではありません。</p>
      </div>
    )
  }
  return (
    <div className="limits team-limits">
      <div className="limits-head"><span>Claude サブスクリプションの利用上限</span></div>
      {limits.windows.map((window) => {
        const reset = window.resetAt !== null && window.resetAt <= now
        const left = Math.max(0, 100 - Math.round(window.usedPercent))
        return (
          <div key={window.seconds} className="limit-row">
            <div className="limit-label">
              <span>{window.label}</span>
              <span className="limit-value">{reset ? 'リセット済み' : `残り ${left}%`}</span>
            </div>
            {!reset && (
              <div className="limit-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label={`${window.label}の残り`}>
                <span className={left <= 20 ? 'low' : ''} style={{ width: `${left}%` }} />
              </div>
            )}
            {window.resetAt !== null && !reset && <span className="limit-reset">{resetLabel(window.resetAt)}にリセット</span>}
          </div>
        )
      })}
      <span className="limit-reset">{relativeTime(limits.fetchedAt)}に取得 · Claude Code が上限情報を出力したときに更新</span>
      <p className="fine-print">直近に取得したサブスクリプションの情報です。現在のチームの課金方式や API・クラウドの料金・残高を示すものではありません。</p>
    </div>
  )
}

/** Both subscriptions' limits, opened from the team panel's usage button. */
function UsageDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="使用量" onClose={onClose} width={440}>
      <ClaudeLimitsCard />
      <ChatGptLimits />
    </Modal>
  )
}

/** The right-hand panel beside a team's leader: its children, live, and what needs the user. */
export const TeamPanel = memo(function TeamPanel({ team }: { team: TeamSummary }) {
  const [diagram, setDiagram] = useState(false)
  const [editing, setEditing] = useState(false)
  const [usage, setUsage] = useState(false)
  const [stopping, setStopping] = useState(false)
  const running = team.children.filter((child) => isActive(child.state)).length
  const stoppable = team.children.filter((child) => isStoppable(child.state)).length
  const children = [...team.children].sort((a, b) => a.createdAt - b.createdAt)
  return (
    <>
      <div className="subagent-backdrop" aria-hidden="true" onClick={() => setTeamPanel(false)} />
      <aside className="subagent-panel team-panel" aria-label="チーム">
        <div className="subagent-panel-head">
          <Users size={15} />
          <span className="subagent-panel-title">チーム</span>
          <span className="subagent-panel-count">{running > 0 ? `作業中 ${running} / ${children.length}` : `${children.length} 人`}</span>
          <button type="button" className="icon-button small" aria-label="パネルを閉じる" title="パネルを閉じる" onClick={() => setTeamPanel(false)}>
            <X size={15} />
          </button>
        </div>
        <div className="subagent-list">
          <div className="team-panel-actions">
            <button type="button" className="button team-diagram-button" onClick={() => setDiagram(true)}>
              <Network size={14} /> 図を開く
            </button>
            <button type="button" className="button team-diagram-button" onClick={() => setEditing(true)} title="子の枠のモデルと、同時に動かせる子の数を変える">
              <SlidersHorizontal size={14} /> このチームの設定
            </button>
          </div>
          <div className="team-panel-actions">
            <button type="button" className="button team-diagram-button" onClick={() => setUsage(true)} title="Claude と GPT（Codex）の利用上限を見る">
              <Gauge size={14} /> 使用量
            </button>
            <button type="button" className="button team-diagram-button" onClick={() => setStopping(true)} disabled={stoppable === 0}
              title={stoppable === 0 ? '作業中の子はいません' : '作業中の子をすべて止める'}>
              <Square size={13} /> 全停止
            </button>
          </div>
          <Notices team={team} />
          {children.map((child) => <ChildCard key={child.id} child={child} />)}
        </div>
      </aside>
      {diagram && <TeamDiagram team={team} onClose={() => setDiagram(false)} />}
      {editing && <TeamConfigDialog team={team} onClose={() => setEditing(false)} />}
      {usage && <UsageDialog onClose={() => setUsage(false)} />}
      {stopping && (
        <ConfirmDialog title="作業中の子をすべて止めますか？" confirmLabel={`${running} 人を止める`} danger
          body={`作業中の子 ${running} 人の作業を止めます。会話は残り、リーダーには止められたことが伝わります。あとから send で続きを頼めます。`}
          onConfirm={() => void act('team.stopAll', { teamId: team.id })} onClose={() => setStopping(false)} />
      )}
    </>
  )
})

// ---------------------------------------------------------------- the diagram

const BOX_W = 184
const BOX_H = 100
const GAP_X = 20
const GAP_Y = 56
const LEADER_W = 248
const LEADER_H = 76
const PAD = 20
/** Children per row. Even, so the trunk down to later rows runs in the gap between the middle boxes. */
const COLUMNS = 4

/** Where each box goes: the leader centered on top, its children in rows below, each row centered. */
function layout(count: number) {
  const cols = Math.max(1, Math.min(COLUMNS, count))
  const rows = Math.ceil(count / cols)
  const width = Math.max(cols * BOX_W + (cols - 1) * GAP_X, LEADER_W) + PAD * 2
  const cx = width / 2
  const rowY = (row: number) => PAD + LEADER_H + GAP_Y + row * (BOX_H + GAP_Y)
  const boxes = Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / cols)
    const inRow = row < rows - 1 ? cols : count - cols * (rows - 1)
    const start = cx - (inRow * BOX_W + (inRow - 1) * GAP_X) / 2
    const x = start + (index % cols) * (BOX_W + GAP_X)
    return { x, y: rowY(row), row, center: x + BOX_W / 2 }
  })
  const height = count ? rowY(rows - 1) + BOX_H + PAD : PAD * 2 + LEADER_H
  const busY = (row: number) => rowY(row) - GAP_Y / 2
  return { width, height, cx, boxes, rows, busY }
}

/** The team as a tree: the leader on top and a box per child with its model, job and state. */
function TeamDiagram({ team, onClose }: { team: TeamSummary; onClose: () => void }) {
  const server = useStore((state) => state.server)
  const leader = useLeader(team)
  const children = [...team.children].sort((a, b) => a.createdAt - b.createdAt)
  const { width, height, cx, boxes, rows, busY } = layout(children.length)
  const lead = leaderState(leader)
  const model = leaderModel(server, leader)
  const trunkEnd = children.length ? busY(rows - 1) : PAD + LEADER_H
  // Lines to working children are drawn last, over the quiet ones they share a bus with.
  const order = children.map((child, index) => ({ child, box: boxes[index] }))
    .sort((a, b) => Number(isActive(a.child.state)) - Number(isActive(b.child.state)))
  return (
    <Modal title="チームの構成" onClose={onClose} width={Math.max(440, Math.min(width + 60, 980))} className="team-diagram-modal">
      <div className="team-diagram-scroll">
        <div className="team-diagram" style={{ width, height }}>
          <svg className="team-lines" width={width} height={height} aria-hidden="true">
            {children.length > 0 && (
              <path className={`team-line ${lead === 'running' || children.some((child) => isActive(child.state)) ? 'live' : ''}`}
                d={`M ${cx} ${PAD + LEADER_H} V ${trunkEnd}`} />
            )}
            {order.map(({ child, box }) => (
              <path key={child.id} className={`team-line state-${child.state} ${isActive(child.state) ? 'live' : ''}`}
                d={`M ${cx} ${busY(box.row)} H ${box.center} V ${box.y}`} />
            ))}
          </svg>
          <div className={`team-node leader state-${lead}`}
            style={{ left: cx - LEADER_W / 2, top: PAD, width: LEADER_W, height: LEADER_H }}>
            <div className="team-node-head">
              <Crown size={14} />
              <span className="team-node-model">リーダー · {model}</span>
            </div>
            <div className="team-node-title">{leader?.title}</div>
            <div className="team-node-foot"><span>{team.leaderKind === 'thread' ? 'GPT' : 'Claude Code'}</span><span>{lead === 'stopped' ? '終了' : STATE_LABEL[lead]}</span></div>
          </div>
          {children.map((child, index) => {
            const box = boxes[index]
            const opens = Boolean(child.taskId) && child.state !== 'removed'
            return (
              <button
                key={child.id}
                type="button"
                className={`team-node provider-${child.provider} state-${child.state} ${isActive(child.state) ? 'live' : 'quiet'}`}
                style={{ left: box.x, top: box.y, width: BOX_W, height: BOX_H }}
                disabled={!opens}
                title={`${child.name}: ${child.title}`}
                onClick={() => {
                  onClose()
                  openTeamChild(child)
                }}
              >
                <div className="team-node-head">
                  <StateIcon state={child.state} size={13} />
                  <span className="team-node-model">{child.modelName}</span>
                </div>
                <div className="team-node-title">{child.title}</div>
                <div className="team-node-foot">
                  <span>{child.name}</span>
                  <span>{stateLabel(child)}</span>
                </div>
              </button>
            )
          })}
        </div>
      </div>
      <div className="team-legend">
        <span className="state-running"><Loader2 size={12} />作業中</span>
        <span className="state-approval"><ShieldAlert size={12} />承認待ち</span>
        <span className="state-idle"><CircleDot size={12} />待機中・報告済み</span>
        <span className="state-closed"><CheckCircle2 size={12} />完了</span>
        <span className="state-error"><XCircle size={12} />エラー</span>
      </div>
    </Modal>
  )
}
