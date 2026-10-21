// The message a report becomes for the leader: which child it came from, what
// the work was, and what the leader can do next.
import { PREFIX } from './teams-prompts.js'

/** What a message to the leader is marked with after PREFIX; claude-hook.js reports the marks a prompt carries. */
export const markOf = (item) => item.id.slice(0, 8)

/** One item from a team's queue, as the leader reads it (`labelOf` names a child's model and tier). */
export function reportMessage(team, item, labelOf) {
  const child = team.children.find((entry) => entry.id === item.childId)
  const who = child ? `子「${child.name}」（${labelOf(child)}）` : '子'
  const rest = team.queue.length ? `（このあとに ${team.queue.length} 件が待っています）` : ''
  const task = child ? `業務: ${child.title}` : null
  // A turn the leader did not send: the child went on by itself, or the user asked it directly.
  const unasked = item.unasked ? '（あなたが送った指示とは別に、子が自分で続けた作業か、ユーザーが子に直接頼んだ作業の結果です）' : ''
  const head = `${PREFIX} #${markOf(item)}`
  const lines = {
    report: [`${head} ${who}から${unasked ? '追加の' : ''}報告が届きました${rest}${unasked}`, task, '---', item.text, '---',
      '合格なら close、直してほしい点や追加の作業は send で同じ子に送ってください。'],
    error: [`${head} ${who}がエラーで止まりました${rest}${unasked}`, task, '---', item.text, '---',
      '続けるなら send で指示を送ってください（例: 「続けて」）。'],
    cancelled: [`${head} ${who}の作業が途中で止められました（ユーザーが停止した可能性があります）${rest}`, task,
      '続けるなら send で指示を送ってください。'],
    approval: [`${head} ${who}が承認待ちで止まっています${rest}`, task, `操作: ${item.text}`,
      '許可するなら approve（allow: true）、拒否するなら allow: false と理由を送ってください。あなたにも判断できないときは ask_user でユーザーに確認してください。'],
  }[item.kind] ?? [`${head} ${item.text}`]
  // Handed over before the app stopped: the leader may have taken it already.
  const again = item.resent ? ['（Agent Desk の再起動の前に渡しかけた報告です。すでに受け取っていれば、この内容は無視してください。）'] : []
  return [...again, ...lines].filter((line) => line !== null).join('\n')
}
