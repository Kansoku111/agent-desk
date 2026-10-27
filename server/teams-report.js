// The message a report becomes for the leader: which child it came from, what
// the work was, and what the leader can do next. Reports that waited together
// go as one message, with the next steps said once.
import { PREFIX } from './teams-prompts.js'

/** What a message to the leader is marked with after PREFIX; claude-hook.js reports the marks a prompt carries. */
export const markOf = (item) => item.id.slice(0, 8)

/** Missing metadata in older saves cannot establish that the original report was complete. */
export function reportText(entry, previewOnly = false) {
  const notes = []
  if (previewOnly && entry.preview === true) notes.push('（保持対象外のため短縮版のみです。read_report でも省略部分は復元できません。）')
  else if (previewOnly && entry.preview === undefined) notes.push('（保持対象外のため、キューに残る本文のみです。read_report でも追加の本文は取得できません。）')
  if (entry.truncated === true) notes.push('（本文は保存上限の40,000文字で省略されています。read_report でも上限より先は取得できません。）')
  else if (entry.truncated !== false) notes.push('（旧保存データのため、本文の省略状態は不明です。）')
  // Old queued previews promised access even after the retained body was lost.
  const text = entry.childId && entry.preview === undefined ? entry.text.replace(/\n（続きは read_report で読めます）$/, '') : entry.text
  return [...notes, text].join('\n')
}

/** One item's lines, and the next steps that follow them (null: none). */
function parts(team, item, labelOf, rest) {
  const child = team.children.find((entry) => entry.id === item.childId)
  const who = child ? `子「${child.name}」（${labelOf(child)}）` : '子'
  const task = child ? `業務: ${child.title}` : null
  // A turn the leader did not send: the child went on by itself, or the user asked it directly.
  const unasked = item.unasked ? '（あなたが送った指示とは別に、子が自分で続けた作業か、ユーザーが子に直接頼んだ作業の結果です）' : ''
  const head = `${PREFIX} #${markOf(item)}`
  const retained = child?.reports?.find((entry) => entry.at === item.at)
  const text = child && item.kind !== 'approval'
    ? reportText(item, !retained) + (retained && retained.text.length > item.text.length
      ? '\n（保存済みの続きは read_report で読めます。保存上限があります。）' : '')
    : item.text
  const [lines, next] = {
    report: [[`${head} ${who}から${unasked ? '追加の' : ''}報告が届きました${rest}${unasked}`, task, '---', text, '---'],
      team.execution
        ? '依頼・完了条件と変更内容（調査は報告の根拠）を確認し、合格なら確認箇所・結果を reason に書いて close。テスト成功だけでは合格にしないでください。修正は send。'
        : '合格なら close、直してほしい点や追加の作業は send で同じ子に送ってください。'],
    error: [[`${head} ${who}がエラーで止まりました${rest}${unasked}`, task, '---', text, '---'],
      item.noTask ? '同じ作業を続けるなら spawn で任せ直してください。' : '止まった子を続けるなら send で指示を送ってください（例: 「続けて」）。'],
    cancelled: item.byUser
      ? [[`${head} ${who}の作業を、ユーザーが全停止で止めました${rest}`, task],
        'ユーザーが止めた子には、ユーザーから指示があるまで続きの指示を送らないでください。']
      : [[`${head} ${who}の作業が途中で止められました（ユーザーが停止した可能性があります）${rest}`, task],
        '止められた子を続けるなら send で指示を送ってください。'],
    approval: [[`${head} ${who}が承認待ちで止まっています${rest}`, task, `操作: ${item.text}`],
      '承認は、許可するなら approve（allow: true）、拒否するなら allow: false と理由を送ってください。あなたにも判断できないときは ask_user でユーザーに確認してください。'],
  }[item.kind] ?? [[`${head} ${item.text}`], null]
  // Handed over before the app stopped: the leader may have taken it already.
  const again = item.resent ? ['（Agent Desk の再起動の前に渡しかけた報告です。すでに受け取っていれば、この内容は無視してください。）'] : []
  return { lines: [...again, ...lines].filter((line) => line !== null), next }
}

/** One item from a team's queue, as the leader reads it (`labelOf` names a child's model and tier). */
export function reportMessage(team, item, labelOf) {
  return reportsMessage(team, [item], labelOf)
}

/** Items from a team's queue as one message: each item, then the next steps once. */
export function reportsMessage(team, items, labelOf) {
  const rest = team.queue.length ? `（このあとに ${team.queue.length} 件が待っています）` : ''
  if (items.length === 1) {
    const { lines, next } = parts(team, items[0], labelOf, rest)
    return [...lines, ...(next ? [next] : [])].join('\n')
  }
  const all = items.map((item) => parts(team, item, labelOf, ''))
  const next = [...new Set(all.map((entry) => entry.next).filter(Boolean))]
  return [
    `${PREFIX} ${items.length} 件がまとめて届きました${rest}。`,
    ...all.map((entry) => entry.lines.join('\n')),
    next.join('\n'),
  ].filter(Boolean).join('\n\n')
}
