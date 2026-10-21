// Pure helpers that fold ACP session updates into the transcript shape the UI
// renders. A thread is a list of turns; a turn is one user prompt plus every
// message, thought and tool call the agent produced for it.

export const MAX_TOOL_OUTPUT = 24_000

/** Keeps the head and tail of very long text so transcripts stay small. */
export function clip(text, max = MAX_TOOL_OUTPUT) {
  if (typeof text !== 'string' || text.length <= max) return text
  const half = Math.floor(max / 2)
  const dropped = text.length - max
  return `${text.slice(0, half)}\n… (${dropped.toLocaleString('en-US')} 文字省略) …\n${text.slice(-half)}`
}

export function newTurn({ id, text, images = [], now = Date.now() }) {
  return { id, startedAt: now, endedAt: null, status: 'running', stopReason: null, error: null, user: { text, images }, items: [] }
}

function contentText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'content' && block.content?.type === 'text') parts.push(block.content.text)
    else if (block?.type === 'diff') parts.push(`--- ${block.path}\n${block.newText ?? ''}`)
    else if (block?.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

function upsertText(turn, type, id, text) {
  const itemId = id ?? `${type}-${turn.items.length}`
  const last = turn.items.at(-1)
  // Chunks without a message id continue the previous item of the same type.
  const existing = id ? turn.items.find((item) => item.type === type && item.id === id)
    : last?.type === type ? last : null
  if (existing) existing.text += text
  else turn.items.push({ type, id: itemId, text })
}

/**
 * Applies one ACP `session/update` payload to a turn.
 * @returns {{ usage?: object, configOptions?: object[], title?: string }} side data for the thread
 */
export function applyUpdate(turn, update) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content?.type === 'text') upsertText(turn, 'agent', update.messageId, update.content.text)
      return {}
    case 'agent_thought_chunk':
      if (update.content?.type === 'text') upsertText(turn, 'thought', update.messageId, update.content.text)
      return {}
    case 'tool_call': {
      const existing = turn.items.find((item) => item.type === 'tool' && item.id === update.toolCallId)
      const item = existing ?? { type: 'tool', id: update.toolCallId, output: '' }
      item.name = update.title ?? item.name ?? 'tool'
      item.kind = update.kind ?? item.kind ?? 'other'
      item.status = update.status ?? item.status ?? 'pending'
      if (update.rawInput !== undefined) item.input = update.rawInput
      if (update.content) item.output = clip(contentText(update.content))
      if (update.locations) item.locations = update.locations
      item.startedAt ??= Date.now()
      if (!existing) turn.items.push(item)
      return {}
    }
    case 'tool_call_update': {
      let item = turn.items.find((entry) => entry.type === 'tool' && entry.id === update.toolCallId)
      if (!item) {
        item = { type: 'tool', id: update.toolCallId, name: update.title ?? 'tool', kind: update.kind ?? 'other', status: 'pending', output: '', startedAt: Date.now() }
        turn.items.push(item)
      }
      if (update.title) item.name = update.title
      if (update.status) item.status = update.status
      if (update.rawInput !== undefined) item.input = update.rawInput
      if (update.content) item.output = clip(contentText(update.content))
      if (update.locations) item.locations = update.locations
      if (update.status === 'completed' || update.status === 'failed') item.endedAt = Date.now()
      return {}
    }
    case 'plan':
      turn.items = turn.items.filter((item) => item.type !== 'plan')
      turn.items.push({ type: 'plan', id: 'plan', entries: update.entries ?? [] })
      return {}
    case 'usage_update':
      return { usage: { used: update.used, size: update.size } }
    case 'config_option_update':
      return { configOptions: update.configOptions }
    case 'session_info_update':
      return typeof update.title === 'string' ? { title: update.title } : {}
    default:
      return {}
  }
}

/** Marks tool calls that never reported an end state when the turn ends. */
export function settleTurn(turn, { status, stopReason = null, error = null, now = Date.now() }) {
  turn.status = status
  turn.stopReason = stopReason
  turn.error = error
  turn.endedAt = now
  for (const item of turn.items) {
    if (item.type === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
      item.status = status === 'done' ? 'completed' : 'failed'
      item.endedAt = now
    }
    if (item.permission) delete item.permission
  }
  return turn
}

/** Short single-line title from the first prompt. */
export function titleFrom(text, max = 48) {
  const line = String(text ?? '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? ''
  if (!line) return '新しいタスク'
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const DATED = /-\d{8}$/

/**
 * Normalizes ACP config options into the model catalog the UI shows.
 * Dated snapshot ids (e.g. claude-…-20250929) are hidden behind their alias.
 */
export function parseConfigOptions(configOptions = []) {
  const modelOption = configOptions.find((option) => option.id === 'model')
  const effortOption = configOptions.find((option) => option.id === 'reasoning_effort')
  const models = []
  for (const group of modelOption?.options ?? []) {
    const entries = Array.isArray(group.options) ? group.options : [group]
    for (const entry of entries) {
      let provider = group.group ?? null
      let id = entry.value
      try {
        const parsed = JSON.parse(entry.value)
        if (Array.isArray(parsed)) [provider, id] = parsed
      } catch {}
      if (DATED.test(id)) continue
      models.push({ value: entry.value, provider, id, name: entry.name ?? id, description: entry.description ?? null })
    }
  }
  const efforts = (effortOption?.options ?? []).map((entry) => ({ value: entry.value, name: entry.name }))
  return {
    models,
    efforts,
    currentModel: modelOption?.currentValue ?? null,
    currentEffort: effortOption?.currentValue ?? '',
  }
}

/** Reasoning levels from lightest to deepest, as dsh names them. */
export const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The level used when none is chosen; Codex starts at medium too. */
export const DEFAULT_EFFORT = 'medium'

/**
 * The offered level closest to the wanted one: the wanted level itself, else
 * the deepest offered level below it, else the lightest above it. An empty
 * wish means {@link DEFAULT_EFFORT}. A model with no levels gets ''.
 * @param {string} wanted
 * @param {{ value: string }[]} efforts - the levels the model offers.
 */
export function nearestEffort(wanted, efforts) {
  const offered = efforts.map((effort) => effort.value).filter((value) => EFFORT_ORDER.includes(value))
  if (!offered.length) return efforts.some((effort) => effort.value === wanted) ? wanted : ''
  const target = EFFORT_ORDER.includes(wanted) ? wanted : DEFAULT_EFFORT
  if (offered.includes(target)) return target
  const rank = EFFORT_ORDER.indexOf(target)
  const below = offered.filter((value) => EFFORT_ORDER.indexOf(value) < rank)
  if (below.length) return below.sort((a, b) => EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a))[0]
  return offered.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))[0]
}

export function modelValue(provider, id) {
  return JSON.stringify([provider, id])
}
