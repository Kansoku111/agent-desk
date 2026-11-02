// The observer uses the same user-facing message and interruption paths as a
// person addressing a task directly. It never uses the leader's send tool.
import { randomUUID } from 'node:crypto'

// Invalidate a steer still in flight when the observer stops its recipient.
const stopVersions = new WeakMap()

function destination(manager, teamId, target) {
  const team = manager.teams.get(teamId)
  if (!team || team.execution) throw new Error('TMのチームが見つかりません')
  if (target === 'leader') return { team, child: null, id: team.leaderId, kind: team.leaderKind, name: 'リーダー' }
  if (typeof target !== 'string' || !target) throw new Error('宛先を指定してください')
  const child = team.children.find((entry) => entry.id === target)
  if (!child?.taskId || !['thread', 'agent'].includes(child.kind)) throw new Error('この子は見つかりません')
  return { team, child, id: child.taskId, kind: child.kind, name: child.name }
}

/** Send only on an explicit user request; the MCP instructions impose that rule. */
export async function observerSend(manager, teamId, target, message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 20_000) throw new Error('送る内容は1〜20,000文字で指定してください')
  const dest = destination(manager, teamId, target)
  const text = '[ユーザーからの指示（観測者経由）]\n' + message.trim()
  const recipient = dest.child ?? dest.team
  const stopVersion = stopVersions.get(recipient) ?? 0
  const teamStopVersion = dest.team.stopVersion ?? 0
  const guard = () => {
    if ((stopVersions.get(recipient) ?? 0) !== stopVersion || (dest.child && (dest.team.stopVersion ?? 0) !== teamStopVersion)) throw new Error('停止されたため送信しませんでした')
    if (manager.teams.get(teamId) !== dest.team || (dest.child ? !dest.team.children.includes(dest.child) || dest.child.taskId !== dest.id : dest.team.leaderId !== dest.id)) {
      throw new Error('宛先が変更されたため送信しませんでした')
    }
  }
  const send = async () => {
    guard()
    let delivery = 'sent'
    if (dest.kind === 'agent') {
      const result = manager.observerMessageAgent(teamId, dest.child.id, text)
      delivery = result.delivery
      if (delivery === 'uncertain') return { target: dest.name, text, delivery, method: 'steer' }
    } else if (dest.kind === 'terminal') {
      await manager.terminals.sendMessage(dest.id, text, undefined, guard)
    } else {
      const thread = manager.threads.threads.get(dest.id)
      if (!thread) throw new Error('宛先のタスクが見つかりません')
      if (thread.status === 'running' && !(!dest.child && manager.fallingBack?.has(teamId))) {
        const result = await manager.threads.steer(dest.id, { text, messageId: randomUUID() }, { userInitiated: true, guard })
        if (result?.status === 'uncertain') return { target: dest.name, text, delivery: 'uncertain' }
        if (result?.status === 'accepted' && result.steered) return { target: dest.name, text, delivery: 'sent', method: 'steer' }
        if (result?.steered !== false) throw new Error('割り込みの受領結果を確認できませんでした。再送前に宛先の会話を確認してください')
        guard()
        await manager.observerQueueThread(teamId, dest.child?.id ?? null, text)
        return { target: dest.name, text, delivery: 'queued' }
      }
      if (dest.child?.awaiting || (!dest.child && manager.fallingBack?.has(teamId))) {
        await manager.observerQueueThread(teamId, dest.child?.id ?? null, text)
        return { target: dest.name, text, delivery: 'queued' }
      }
      const result = await manager.threads.send(dest.id, { text, messageId: randomUUID() }, { userInitiated: true, guard })
      if (result?.status === 'uncertain') return { target: dest.name, text, delivery: 'uncertain' }
      if (result?.status !== 'accepted') throw new Error('送信の受領結果を確認できませんでした。再送前に宛先の会話を確認してください')
    }
    return { target: dest.name, text, delivery }
  }
  return dest.child ? manager.observerUserChild(teamId, dest.child.id, send) : send()
}

/** Interrupt a single recipient through its normal user-facing stop path. */
export async function observerStop(manager, teamId, target) {
  const dest = destination(manager, teamId, target)
  const recipient = dest.child ?? dest.team
  stopVersions.set(recipient, (stopVersions.get(recipient) ?? 0) + 1)
  await manager.observerCancelPending(teamId, dest.child?.id ?? null)
  const current = destination(manager, teamId, target)
  if (current.id !== dest.id || current.kind !== dest.kind) throw new Error('宛先が変更されたため停止しませんでした')
  if (dest.kind === 'agent') manager.stopChild(teamId, dest.child.id)
  else if (dest.kind === 'thread') await manager.threads.cancel(dest.id)
  else if (!manager.terminals.interrupt(dest.id, null)) throw new Error('リーダーは動いていません')
  return { target: dest.name, requested: true }
}
