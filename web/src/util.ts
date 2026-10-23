// Formatting helpers and the Codex-style one-line summaries of tool calls.
import { diffLines } from 'diff'
import type { PermissionMode, ToolItem, Turn } from './types'

export function basename(target: string | null | undefined) {
  if (!target) return ''
  const parts = target.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.at(-1) || target
}

/** Shows a path relative to the workspace when it lives inside it. */
function relativePath(target: string, workspace?: string | null) {
  if (!workspace) return target
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = norm(workspace)
  const file = norm(target)
  if (file.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return file.slice(base.length + 1)
  return target
}

export function relativeTime(timestamp: number, now = Date.now()) {
  const diff = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'たった今'
  if (diff < hour) return `${Math.floor(diff / minute)}分前`
  if (diff < day) return `${Math.floor(diff / hour)}時間前`
  if (diff < 2 * day) return '昨日'
  if (diff < 7 * day) return `${Math.floor(diff / day)}日前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes}分${rest ? ` ${String(rest).padStart(2, '0')}秒` : ''}`
  return `${Math.floor(minutes / 60)}時間 ${minutes % 60}分`
}

export function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

/** When a limit window resets, relative and absolute (「3日後（10/15 23:15）」). */
export function resetLabel(at: number | null, now = Date.now()) {
  if (!at) return ''
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  const relative = minutes < 60 ? `${minutes}分後` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}時間後` : `${Math.round(minutes / 1440)}日後`
  const date = new Date(at)
  const absolute = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${relative}（${absolute}）`
}

/** Precise token counts for tooltips (12,345). */
export function formatTokensExact(value: number) {
  return value.toLocaleString('en-US')
}

/** A USD amount with enough digits to tell small turns apart. */
export function formatUsd(value: number) {
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(4)}`
}

export const PERMISSION_INFO: Record<PermissionMode, { label: string; description: string }> = {
  'read-only': {
    label: '読み取り専用',
    description: 'ファイルの読み取りのみ。変更やコマンドの書き込みは毎回承認が必要です。',
  },
  'workspace-write': {
    label: 'ワークスペース',
    description: 'ワークスペース内の編集とコマンドは自動で実行し、範囲外は承認を求めます。',
  },
  'danger-full-access': {
    label: 'フルアクセス',
    description: '制限も承認もありません。信頼できる環境でのみ使ってください。',
  },
}

const EFFORT_LABELS: Record<string, string> = {
  '': '標準',
  off: 'オフ',
  none: 'なし',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '最高',
  max: '最大',
}

export function effortLabel(value: string, fallback?: string) {
  return EFFORT_LABELS[value] ?? fallback ?? value
}

/** Reasoning levels from lightest to deepest (dsh names). */
const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** The levels the picker offers, as Codex does: low up to max. */
const PICKABLE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_EFFORT = 'medium'

/** The model's levels the picker shows, lightest first. */
export function pickableEfforts<T extends { value: string }>(efforts: T[]): T[] {
  return efforts
    .filter((effort) => PICKABLE_EFFORTS.includes(effort.value))
    .sort((a, b) => EFFORT_ORDER.indexOf(a.value) - EFFORT_ORDER.indexOf(b.value))
}

/**
 * The offered level closest to the wanted one (mirrors the server): the level
 * itself, else the deepest offered below it, else the lightest above it.
 */
export function nearestEffort(wanted: string, offered: string[]): string {
  if (!offered.length) return wanted
  const target = EFFORT_ORDER.includes(wanted) ? wanted : DEFAULT_EFFORT
  if (offered.includes(target)) return target
  const rank = EFFORT_ORDER.indexOf(target)
  const below = offered.filter((value) => EFFORT_ORDER.indexOf(value) < rank)
  const pool = below.length ? below : offered
  return [...pool].sort((a, b) => below.length
    ? EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a)
    : EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))[0]
}

/** How a workspace is named in the UI: My PC, the project's name, or the folder name. */
/** The turn whose restore can still be undone: the latest one, with no message sent after it. */
export function undoableRestore(turns: Turn[]): string | null {
  let latest: Turn | null = null
  for (const turn of turns) if (turn.restore && (!latest || turn.restore.at > latest.restore!.at)) latest = turn
  return latest && turns.length === latest.restore!.turns ? latest.id : null
}

export function workspaceLabel(workspace: string, myPc: string | null | undefined, names?: Record<string, string> | null) {
  if (myPc && workspace === myPc) return 'My PC'
  return names?.[workspace] || basename(workspace)
}

export function parseModel(value: string | null | undefined): { provider: string; id: string } | null {
  if (!value) return null
  try {
    const [provider, id] = JSON.parse(value)
    if (typeof provider === 'string' && typeof id === 'string') return { provider, id }
  } catch {}
  return null
}

/** A fast-mode note in Japanese; the Codex model list words it like "1.5x speed, increased usage". */
export function fastNote(note: string) {
  const parts = note.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const speed = /^(\d+(?:\.\d+)?)x speed$/i.exec(part)
    if (speed) return `${speed[1]} 倍速`
    if (/^increased usage$/i.test(part)) return '利用上限の減りが早い'
    return part
  })
  return parts.join('・') || '高速'
}

// ------------------------------------------------------------------ tools

export type ToolIcon = 'terminal' | 'edit' | 'create' | 'read' | 'search' | 'web' | 'desktop' | 'agent' | 'plan' | 'image' | 'tool'

interface ToolSummary {
  icon: ToolIcon
  verb: string
  target: string
  added?: number
  removed?: number
  detail?: { kind: 'diff'; lines: DiffLine[] } | { kind: 'code'; text: string } | null
  /** Attachment files to show under the row (generated images). */
  images?: string[]
  /** Where the tool saved its file, relative to the workspace. */
  savedPath?: string
}

const PREVIEW_LINE = /^\[agent-desk-preview\] ([a-f0-9-]+\.(?:png|jpg|webp))$/gm

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'gap'
  text: string
}

const str = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value))

function firstLine(text: string, max = 120) {
  const line = text.split(/\r?\n/).find((part) => part.trim()) ?? ''
  const more = text.trim().includes('\n') ? ' …' : ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line + more
}

/** Unified diff lines for one replacement, with nearby context collapsed. */
function diffFor(before: string, after: string, context = 3): { lines: DiffLine[]; added: number; removed: number } {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  for (const part of diffLines(before, after)) {
    const rows = part.value.replace(/\n$/, '').split('\n')
    if (part.added) {
      added += rows.length
      rows.forEach((text) => lines.push({ type: 'add', text }))
    } else if (part.removed) {
      removed += rows.length
      rows.forEach((text) => lines.push({ type: 'del', text }))
    } else {
      rows.forEach((text) => lines.push({ type: 'ctx', text }))
    }
  }
  // Collapse long unchanged runs.
  const keep = lines.map((line, index) => line.type !== 'ctx'
    || lines.slice(Math.max(0, index - context), index + context + 1).some((other) => other.type !== 'ctx'))
  const collapsed: DiffLine[] = []
  lines.forEach((line, index) => {
    if (keep[index]) collapsed.push(line)
    else if (collapsed.at(-1)?.type !== 'gap') collapsed.push({ type: 'gap', text: '' })
  })
  return { lines: collapsed, added, removed }
}

function filePath(input: Record<string, unknown>) {
  return str(input.file_path ?? input.path ?? input.filePath ?? input.target_file ?? '')
}

const BROWSER_VERBS: Record<string, string> = {
  new_page: 'ブラウザで開く',
  navigate_page: 'ページを移動',
  select_page: 'タブを切り替え',
  close_page: 'タブを閉じる',
  list_pages: 'タブ一覧',
  take_snapshot: 'ページを読み取り',
  take_screenshot: 'スクリーンショット',
  click: 'クリック',
  hover: 'ホバー',
  drag: 'ドラッグ',
  fill: '入力',
  fill_form: 'フォームに入力',
  type_text: '文字を入力',
  press_key: 'キー入力',
  upload_file: 'ファイルを添付',
  handle_dialog: 'ダイアログに応答',
  wait_for: '表示を待つ',
  evaluate_script: 'スクリプトを実行',
  list_console_messages: 'コンソールを確認',
  get_console_message: 'コンソールを確認',
  list_network_requests: '通信を確認',
  get_network_request: '通信を確認',
  emulate: 'エミュレート',
  resize_page: 'サイズを変更',
}

const DESKTOP_VERBS: Record<string, string> = {
  screenshot: '画面を確認',
  zoom: '画面を拡大',
  click: 'クリック',
  move_mouse: 'マウスを移動',
  drag: 'ドラッグ',
  scroll: 'スクロール',
  type_text: '文字を入力',
  press_keys: 'キー入力',
  list_windows: 'ウィンドウ一覧',
  focus_window: 'ウィンドウを切り替え',
  wait: '待機',
}

const summaries = new WeakMap<ToolItem, { workspace: string | null | undefined; summary: ToolSummary }>()

/**
 * The one-line summary of a tool call. A turn's items are not changed once
 * received, and the store hands back the same object for an item that did not
 * change, so the summary (and its diff) is computed once per item.
 */
export function summarizeTool(item: ToolItem, workspace?: string | null): ToolSummary {
  const cached = summaries.get(item)
  if (cached && cached.workspace === workspace) return cached.summary
  const summary = computeSummary(item, workspace)
  summaries.set(item, { workspace, summary })
  return summary
}

function computeSummary(item: ToolItem, workspace?: string | null): ToolSummary {
  const input = (item.input ?? {}) as Record<string, unknown>
  const name = item.name.toLowerCase()
  const output = item.output ?? ''

  // The browser tool (chrome-devtools-mcp, mounted as the "chrome" MCP server).
  if (name.startsWith('mcp__chrome__')) {
    const action = name.slice('mcp__chrome__'.length)
    const verb = BROWSER_VERBS[action] ?? `ブラウザ: ${action}`
    const target = str(input.url ?? input.value ?? input.key ?? input.text ?? input.uid ?? '')
    const script = str(input.function ?? '')
    const text = [script, output].filter(Boolean).join('\n\n')
    return { icon: 'web', verb, target: firstLine(target), detail: text ? { kind: 'code', text } : null }
  }

  // The desktop tool (desktop-mcp.js, mounted as the "desktop" MCP server).
  if (name.startsWith('mcp__desktop__')) {
    const action = name.slice('mcp__desktop__'.length)
    const verb = DESKTOP_VERBS[action] ?? `デスクトップ: ${action}`
    const x = input.x ?? input.start_x
    const y = input.y ?? input.start_y
    const at = x !== undefined && y !== undefined ? `(${str(x)}, ${str(y)})` : ''
    const target = str(input.text ?? input.keys ?? input.title ?? input.direction ?? '') || at
    return { icon: 'desktop', verb, target: firstLine(target), detail: output ? { kind: 'code', text: output } : null }
  }

  // The image tool (imagegen-mcp.js, mounted as the "imagegen" MCP server).
  if (name === 'mcp__imagegen__generate_image') {
    const images = [...output.matchAll(PREVIEW_LINE)].map((match) => match[1])
    const text = output.replace(PREVIEW_LINE, '').trim()
    const savedPath = /^Saved the image to (.+?) \(/m.exec(output)?.[1]
    return { icon: 'image', verb: '画像を生成', target: firstLine(str(input.prompt ?? '')), detail: text ? { kind: 'code', text } : null, images, savedPath }
  }

  if (['bash', 'pwsh', 'shell', 'powershell', 'terminal_send', 'terminal_open', 'run_code'].includes(name) || 'command' in input) {
    const command = str(input.command ?? input.code ?? input.input ?? input.text)
    return {
      icon: 'terminal',
      verb: name === 'run_code' ? 'コードを実行' : '実行',
      target: firstLine(command || item.name),
      detail: { kind: 'code', text: `${name === 'run_code' ? '' : '$ '}${command}${output ? `\n\n${output}` : ''}` },
    }
  }
  if (name === 'edit' || name === 'str_replace_editor' || name === 'multi_edit') {
    const path = relativePath(filePath(input), workspace)
    const before = str(input.old_string ?? input.old_str)
    const after = str(input.new_string ?? input.new_str ?? input.file_text)
    if (before || after) {
      const diff = diffFor(before, after)
      return { icon: 'edit', verb: '編集', target: path, added: diff.added, removed: diff.removed, detail: { kind: 'diff', lines: diff.lines } }
    }
    return { icon: 'edit', verb: '編集', target: path, detail: output ? { kind: 'code', text: output } : null }
  }
  if (name === 'write') {
    const path = relativePath(filePath(input), workspace)
    const content = str(input.content)
    const lines = content ? content.replace(/\n$/, '').split('\n') : []
    return {
      icon: 'create',
      verb: '書き込み',
      target: path,
      added: lines.length,
      removed: 0,
      detail: { kind: 'diff', lines: lines.slice(0, 400).map((text) => ({ type: 'add' as const, text })) },
    }
  }
  if (name === 'read' || name === 'read_image' || name === 'view') {
    return { icon: name === 'read_image' ? 'image' : 'read', verb: '読み込み', target: relativePath(filePath(input), workspace), detail: output ? { kind: 'code', text: output } : null }
  }
  if (name === 'glob' || name === 'grep' || name.includes('search') && !name.includes('web')) {
    const pattern = str(input.pattern ?? input.query ?? input.glob)
    return { icon: 'search', verb: '検索', target: pattern, detail: output ? { kind: 'code', text: output } : null }
  }
  if (name.includes('web') || name.includes('fetch') || name.includes('browse')) {
    return { icon: 'web', verb: 'Web', target: str(input.url ?? input.query ?? ''), detail: output ? { kind: 'code', text: output } : null }
  }
  if (name.includes('agent') || name.includes('subagent') || name === 'task') {
    const verb = name === 'subagent_claude' ? 'サブエージェント（Claude）' : name === 'subagent_gpt' ? 'サブエージェント（GPT）' : 'サブエージェント'
    return { icon: 'agent', verb, target: firstLine(str(input.description ?? input.prompt ?? '')), detail: output ? { kind: 'code', text: output } : null }
  }
  if (name.includes('plan') || name.includes('todo') || name.includes('goal')) {
    return { icon: 'plan', verb: '計画', target: firstLine(str(input.title ?? input.objective ?? '')), detail: output ? { kind: 'code', text: output } : null }
  }
  const args = Object.keys(input).length ? JSON.stringify(input, null, 2) : ''
  return {
    icon: 'tool',
    verb: item.name,
    target: '',
    detail: args || output ? { kind: 'code', text: [args, output].filter(Boolean).join('\n\n') } : null,
  }
}

interface FileChange {
  path: string
  added: number
  removed: number
  created: boolean
}

/** Files a turn changed, aggregated across write and edit tool calls. */
export function fileChanges(turn: Turn, workspace?: string | null): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const item of turn.items) {
    if (item.type !== 'tool' || item.status !== 'completed') continue
    const summary = summarizeTool(item, workspace)
    if (summary.icon !== 'edit' && summary.icon !== 'create') continue
    if (!summary.target) continue
    const entry = byPath.get(summary.target) ?? { path: summary.target, added: 0, removed: 0, created: false }
    entry.added += summary.added ?? 0
    entry.removed += summary.removed ?? 0
    if (summary.icon === 'create') entry.created = true
    byPath.set(summary.target, entry)
  }
  return [...byPath.values()]
}

/**
 * Copies text. The Clipboard API needs a secure context, which a phone's
 * plain-HTTP tailnet address is not, so that case selects a hidden field.
 */
export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text)
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  area.setSelectionRange(0, text.length)
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('copy failed')
}
