import type { AbRun, CodexTaskSummary, TerminalSummary, ThreadSummary } from './types'

export const VISIBLE_ROWS = 3
export const MAX_ROWS = 10

/** Mixed tasks in one project: pinned first, then most recently used. */
export function groupRows(group: { threads: ThreadSummary[]; terminals: TerminalSummary[]; ab: AbRun[]; codex?: CodexTaskSummary[] }) {
  return [
    ...group.threads.map((thread) => ({ id: thread.id, updatedAt: thread.updatedAt, pinned: Boolean(thread.pinned), thread, terminal: null, ab: null, codex: null })),
    ...group.terminals.map((terminal) => ({ id: terminal.id, updatedAt: terminal.updatedAt, pinned: Boolean(terminal.pinned), thread: null, terminal, ab: null, codex: null })),
    ...group.ab.map((ab) => ({ id: ab.id, updatedAt: ab.updatedAt, pinned: Boolean(ab.pinned), thread: null, terminal: null, ab, codex: null })),
    ...(group.codex ?? []).map((codex) => ({ id: codex.id, updatedAt: codex.updatedAt, pinned: Boolean(codex.pinned), thread: null, terminal: null, ab: null, codex })),
  ].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}

/** Pins never use up the recent-task quota or disappear behind the row cap. */
export function visibleRows(rows: ReturnType<typeof groupRows>, expanded: boolean, searching: boolean, activeId: string | null) {
  if (searching) return rows
  const limit = expanded ? MAX_ROWS : VISIBLE_ROWS
  let recent = 0
  return rows.filter((row) => row.pinned || ++recent <= limit || row.id === activeId)
}
