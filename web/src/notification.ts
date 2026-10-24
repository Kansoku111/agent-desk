export interface TaskNotification {
  kind: string; threadId: string; title: string; status?: string; terminal?: boolean; ab?: boolean
}

export function notificationRoute(frame: TaskNotification): { view: 'ab' | 'terminal' | 'thread'; id: string } {
  return { view: frame.ab ? 'ab' : frame.terminal ? 'terminal' : 'thread', id: frame.threadId }
}

export function notificationText(frame: TaskNotification) {
  const ab: Record<string, string> = {
    'ab-approval': 'ABの案を確認してください', 'ab-completed': 'ABの実装報告が届きました',
    'ab-reviewed': 'ABのレビュー報告が届きました', 'ab-attention': 'ABに未実行の操作があります',
    'ab-error': 'ABがエラーで停止しました',
  }
  const prefix = frame.ab && ab[frame.kind]
  if (prefix) return `${prefix}: ${frame.title}`
  return frame.kind === 'approval-needed' ? `承認待ち: ${frame.title}`
    : frame.kind === 'team-ask' ? `チームのリーダーが確認を求めています: ${frame.title}`
      : frame.status === 'error' ? `エラーで停止: ${frame.title}`
        : frame.status === 'cancelled' ? `停止しました: ${frame.title}` : `完了しました: ${frame.title}`
}
