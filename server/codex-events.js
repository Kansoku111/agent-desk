// Fold Codex app-server item notifications into the shared transcript. The
// caller owns turn lifecycle, usage and approval handling.
const text = (value) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2)
const lines = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join('\n\n') : ''

function patchInput(changes) {
  const list = Array.isArray(changes) ? changes : []
  const first = list[0] ?? {}
  const diff = typeof first.diff === 'string' ? first.diff : ''
  // UI edit summaries accept old/new strings rather than unified diffs.
  const before = [], after = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('\\')) continue
    if (line.startsWith('-')) before.push(line.slice(1))
    else if (line.startsWith('+')) after.push(line.slice(1))
    else if (line.startsWith(' ')) { before.push(line.slice(1)); after.push(line.slice(1)) }
  }
  return { path: first.path ?? '', old_string: before.join('\n'), new_string: after.join('\n'), changes: list }
}

function normalize(item, completed, previous, now) {
  const id = item.id
  if (item.type === 'agentMessage') return { type: 'agent', id, text: text(item.text) }
  if (item.type === 'reasoning') return { type: 'thought', id, text: lines(item.summary) || lines(item.content) }
  let name, kind = 'other', input = {}, output = ''
  switch (item.type) {
    case 'commandExecution':
      name = 'shell'; kind = 'execute'; input = { command: item.command ?? '', cwd: item.cwd ?? '', exitCode: item.exitCode ?? null }; output = text(item.aggregatedOutput); break
    case 'fileChange':
      name = 'edit'; kind = 'edit'; input = patchInput(item.changes); output = (item.changes ?? []).map((change) => `${change.path}\n${change.diff}`).join('\n\n'); break
    case 'mcpToolCall':
      name = `mcp__${item.server}__${item.tool}`; input = item.arguments ?? {}; output = text(item.error ?? item.result); break
    case 'dynamicToolCall':
      name = item.tool ?? 'tool'; input = item.arguments ?? {}; output = text(item.contentItems); break
    case 'webSearch':
      name = 'web_search'; kind = 'search'; input = { query: item.query ?? '', action: item.action ?? null }; output = text(item.results); break
    case 'imageView':
      name = 'read_image'; kind = 'read'; input = { path: item.path ?? '' }; break
    case 'contextCompaction':
      name = 'contextCompaction'; break
    case 'userMessage': return null
    default:
      if (typeof item.type !== 'string' || !item.type) return null
      name = item.type; input = {}; output = text(item); break
  }
  const failed = item.status === 'failed' || item.status === 'declined' || item.success === false || Boolean(item.error)
    || (item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0)
  const status = failed ? 'failed' : completed ? 'completed' : 'in_progress'
  return { type: 'tool', id, name, kind, status, input, output,
    startedAt: previous?.startedAt ?? item.startedAtMs ?? now,
    endedAt: completed ? (previous?.endedAt ?? item.completedAtMs ?? now) : null }
}

/** Mutates only the supplied turn; returns whether a notification was applied. */
export function applyCodexEvent(turn, method, params, now = Date.now()) {
  if (!turn || !Array.isArray(turn.items) || !params || typeof params !== 'object') return false
  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item
    if (!item || typeof item.id !== 'string' || !item.id) return false
    const index = turn.items.findIndex((entry) => entry.id === item.id)
    const previous = index < 0 ? null : turn.items[index]
    const normalized = normalize(item, method === 'item/completed', previous, now)
    if (!normalized) return false
    if (index < 0) turn.items.push(normalized)
    else turn.items[index] = normalized
    return true
  }
  const deltaTypes = {
    'item/agentMessage/delta': ['agent', 'text'],
    'item/reasoning/summaryTextDelta': ['thought', 'text'],
    'item/reasoning/textDelta': ['thought', 'text'],
    'item/commandExecution/outputDelta': ['tool', 'output'],
    'item/fileChange/outputDelta': ['tool', 'output'],
  }
  const spec = deltaTypes[method]
  if (!spec || typeof params.itemId !== 'string' || !params.itemId || typeof params.delta !== 'string') return false
  const [type, field] = spec
  const index = turn.items.findIndex((entry) => entry.id === params.itemId)
  const previous = index < 0 ? null : turn.items[index]
  if (previous && previous.type !== type) return false
  const item = previous ? { ...previous } : type === 'tool'
    ? { type, id: params.itemId, name: method.startsWith('item/fileChange/') ? 'edit' : 'shell', kind: 'other', status: 'in_progress', input: {}, output: '', startedAt: now, endedAt: null }
    : { type, id: params.itemId, text: '' }
  item[field] += params.delta
  if (index < 0) turn.items.push(item)
  else turn.items[index] = item
  return true
}
