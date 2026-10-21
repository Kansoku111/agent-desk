import type { ThreadSummary, ToolItem, Turn } from './types'

const TOOL_TARGET_KEYS = ['command', 'cmd', 'file_path', 'path', 'url', 'query', 'pattern', 'description', 'prompt']
/** How much of a failed tool's output to keep: usually enough to see the error. */
const FAILED_OUTPUT_LINES = 20

/** The start of a failed tool's output, fenced and indented under its list line. */
function failedOutput(output: string) {
  const all = output.trimEnd().split('\n')
  const kept = all.slice(0, FAILED_OUTPUT_LINES)
  if (all.length > kept.length) kept.push(`…（残り ${all.length - kept.length} 行を省略）`)
  // A fence longer than any backtick run inside, so the output cannot close it.
  const fence = '`'.repeat(Math.max(3, ...(output.match(/`+/g) ?? []).map((run: string) => run.length + 1)))
  return [fence, ...kept, fence].map((line) => `  ${line}`)
}

function toolLines(item: ToolItem) {
  const input = item.input ?? {}
  const key = TOOL_TARGET_KEYS.find((name) => typeof input[name] === 'string' && (input[name] as string).trim())
  let target = key ? (input[key] as string).trim().split('\n')[0] : ''
  if (target.length > 200) target = `${target.slice(0, 200)}…`
  const failed = item.status === 'failed' || item.decision === 'rejected'
  const line = `- ${item.name}${target ? `: \`${target.replace(/`/g, "'")}\`` : ''}${failed ? '（失敗）' : ''}`
  return failed && item.output?.trim() ? [line, ...failedOutput(item.output)] : [line]
}

/**
 * The task's conversation as Markdown, for pasting into another agent or chat.
 * Replies, user messages and plans are kept; tool calls shrink to one line
 * each (plus the start of the output when one failed) and thinking is left
 * out, so the text stays readable and short.
 */
export function threadMarkdown(thread: Pick<ThreadSummary, 'title' | 'workspace' | 'model'>, turns: readonly Turn[]) {
  const lines = [`# ${thread.title}`, '', `- 作業フォルダ: ${thread.workspace}`]
  if (thread.model) lines.push(`- モデル: ${thread.model}`)
  for (const turn of turns) {
    lines.push('', '## ユーザー', '', turn.user.text.trim() || '（テキストなし）')
    if (turn.user.images.length) lines.push('', `（画像 ${turn.user.images.length} 枚を添付）`)
    lines.push('', '## エージェント')
    let tools: string[] = []
    const flushTools = () => {
      if (tools.length) lines.push('', ...tools)
      tools = []
    }
    for (const item of turn.items) {
      if (item.type === 'tool') {
        tools.push(...toolLines(item))
        continue
      }
      flushTools()
      if (item.type === 'agent' && item.text.trim()) lines.push('', item.text.trim())
      else if (item.type === 'steer') lines.push('', `> （作業中のユーザーの追加指示）${item.text.trim().replace(/\n/g, '\n> ')}`)
      else if (item.type === 'plan' && item.entries.length) {
        lines.push('', '計画:', ...item.entries.map((entry) => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`))
      } else if (item.type === 'notice' && item.level === 'warning') lines.push('', `（注意）${item.text.trim()}`)
    }
    flushTools()
    if (turn.status === 'cancelled') lines.push('', '（ユーザーが中断）')
    if (turn.status === 'running') lines.push('', '（実行中）')
    if (turn.error) lines.push('', `（エラー）${turn.error.message}`)
  }
  return `${lines.join('\n')}\n`
}
