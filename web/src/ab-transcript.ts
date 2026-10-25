import type { AbJob, AbRun } from './types'

type Entry = { kind: 'job'; job: AbJob; key: string } | { kind: 'message'; text: string; key: string }

/** Job anchors avoid ambiguous timestamp ties. Old strings preceded successive leader revisions. */
export function abTimeline(run: Pick<AbRun, 'jobs' | 'messages'>): Entry[] {
  const entries: Entry[] = []
  const emitted = new Set<number>()
  const legacy = run.messages.map((message, index) => ({ message, index })).filter((entry) => typeof entry.message === 'string')
  let leader = 0
  const add = (index: number) => {
    const message = run.messages[index]
    entries.push({ kind: 'message', text: typeof message === 'string' ? message : message.text, key: `message-${index}` })
    emitted.add(index)
  }
  for (const job of run.jobs) {
    if (job.role === 'leader' && leader++ > 0) {
      const entry = legacy[leader - 2]
      if (entry) add(entry.index)
    }
    entries.push({ kind: 'job', job, key: job.id })
    run.messages.forEach((message, index) => {
      if (typeof message !== 'string' && message.afterJobId === job.id) add(index)
    })
  }
  run.messages.forEach((_, index) => { if (!emitted.has(index)) add(index) })
  return entries
}

export function abMarkdown(run: AbRun): string {
  return [`# ${run.title}`, `## ユーザー\n\n${run.text}`, ...abTimeline(run).map((entry) => entry.kind === 'message'
    ? `## ユーザー\n\n${entry.text}`
    : `## ${entry.job.role} — ${entry.job.model}${entry.job.effort ? ` (${entry.job.effort})` : ''}\n\n${[entry.job.report, entry.job.error, entry.job.stopError].filter(Boolean).join('\n\n') || '報告なし'}`)].join('\n\n')
}
