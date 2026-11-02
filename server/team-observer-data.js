// Read-only data for the TM observer. These functions never message an agent or
// consume a report from the delivery queue. Tool authentication belongs to the
// observer's eventual transport, not the leader's MCP server.

const MAX_TURNS = 10
const MAX_TEXT = 2000
const MAX_OUTPUT = 12000

function teamFor(manager, teamId) {
  const team = manager.teams.get(teamId)
  if (!team || team.execution) throw new Error('TMのチームが見つかりません')
  return team
}

/** A compact snapshot; the absence of recent activity is not a diagnosis. */
export function observerStatus(manager, teamId) {
  const team = teamFor(manager, teamId)
  const summary = manager.summary(team)
  const leader = team.leaderKind === 'thread'
    ? manager.threads.threads.get(team.leaderId)
    : manager.terminals.status(team.leaderId)
  const leaderRecord = team.leaderKind === 'terminal' ? manager.terminals.records?.get(team.leaderId) : leader
  const queue = [...(manager.delivering?.get(teamId)?.items ?? []), ...(team.queue ?? [])]
  return {
    leader: {
      kind: team.leaderKind,
      state: team.leaderKind === 'thread' ? leader?.status ?? null : leader?.state ?? null,
      activity: team.leaderKind === 'terminal' ? leader?.activity ?? null : null,
      updatedAt: leaderRecord?.updatedAt ?? null,
      approval: Boolean(leader?.pendingApproval || leader?.activity === 'approval'),
    },
    children: summary.children.map(({ id, name, title, state, updatedAt, lastReport, pending, kind, taskId }) => {
      const record = kind === 'thread' ? manager.threads.threads.get(taskId) : kind === 'agent' ? manager.agents.get?.(taskId) : null
      const recorded = [updatedAt, record?.updatedAt].filter(Number.isFinite)
      return { id, name, title, state, updatedAt: recorded.length ? Math.max(...recorded) : null, lastReport, pending }
    }),
    delivery: summary.delivery,
    queue: queue.slice(-20).map(({ id, childId, kind, at, text }) => ({ id, childId, kind, at, preview: typeof text === 'string' ? text.slice(0, 300) : null })),
    queueCount: queue.length,
    queueOmitted: Math.max(0, queue.length - 20),
    observerOutbox: (team.observerOutbox ?? []).slice(-20).map(({ childId, state, at, text, error }) => ({ target: childId ?? 'leader', state, at, preview: text.slice(0, 300), ...(error ? { error } : {}) })),
    observerOutboxCount: (team.observerOutbox ?? []).length,
    observerOutboxOmitted: Math.max(0, (team.observerOutbox ?? []).length - 20),
    approvals: summary.approvals,
    asks: summary.asks.slice(-10).map(({ id, at, text, childId }) => ({ id, at, childId, preview: typeof text === 'string' ? text.slice(0, 300) : null })),
    asksCount: summary.asks.length,
    asksOmitted: Math.max(0, summary.asks.length - 10),
  }
}

/** Only the observer's own recent chat follows an explicit runtime change. */
export function observerCarryover(turns) {
  const messages = turns.slice(-6).map((turn) => {
    const answer = (turn.items ?? []).filter((item) => item.type === 'agent' && typeof item.text === 'string').at(-1)?.text ?? ''
    return 'User: ' + String(turn.user?.text ?? '').slice(0, 800) + '\nObserver: ' + answer.slice(0, 800)
  }).join('\n\n')
  return messages ? '[Previous observer chat: context only, not a new authorization to send or stop.]\n' + messages : ''
}

/** The newest retained user/agent messages for one child, bounded in both turns and characters. */
export async function observerChildTurns(manager, teamId, childId, limit = 5) {
  const team = teamFor(manager, teamId)
  if (typeof childId !== 'string' || !childId) throw new Error('子を指定してください')
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TURNS) throw new Error('件数は1〜10で指定してください')
  const child = team.children.find((entry) => entry.id === childId)
  if (!child || !child.taskId) throw new Error('この子の会話は見つかりません')
  const taskId = child.taskId
  let turns
  if (child.kind === 'thread') turns = (await manager.threads.get(taskId)).turns
  else if (child.kind === 'agent') turns = manager.agents.turns(taskId)
  if (!Array.isArray(turns)) throw new Error('この子の会話を読み取れません')
  if (manager.teams.get(teamId) !== team || !team.children.includes(child) || child.taskId !== taskId) throw new Error('この子の会話は見つかりません')

  // Bound each turn before enforcing the aggregate limit, so one long tool
  // response or thought cannot expose the whole transcript to the observer.
  let remaining = MAX_OUTPUT
  let truncated = false
  const text = (value) => {
    if (typeof value !== 'string') return ''
    const take = Math.min(MAX_TEXT, remaining)
    if (value.length > take) truncated = true
    const result = value.slice(0, take)
    remaining -= result.length
    return result
  }
  const selected = turns.slice(-limit).reverse().map((turn) => {
    const messages = (turn.items ?? []).filter((item) => item.type === 'agent' && typeof item.text === 'string')
    if (messages.length > MAX_TURNS) truncated = true
    return {
      id: turn.id,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      status: turn.status,
      user: text(turn.user?.text),
      messages: messages.slice(-MAX_TURNS).reverse().map((item) => text(item.text)).filter(Boolean).reverse(),
    }
  }).reverse()
  return { child: { id: child.id, name: child.name }, turns: selected, retained: turns.length, limited: turns.length > limit || truncated }
}
