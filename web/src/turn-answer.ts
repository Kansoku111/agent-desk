import type { TextItem, TurnItem } from './types'

/**
 * The reply a finished turn ends with: every message written after the last tool call.
 * A message followed by tool calls is narration ("…を確認します") and folds away with the work.
 * One followed by none is part of what the agent tells the user, even when the model split
 * it into several messages (a conclusion, then a note on it). Empty while the turn does not
 * end with a message.
 */
export function turnAnswer(items: readonly TurnItem[]): TextItem[] {
  if (items.at(-1)?.type !== 'agent') return []
  const lastTool = items.findLastIndex((item) => item.type === 'tool')
  return items.slice(lastTool + 1).filter((item): item is TextItem => item.type === 'agent')
}
