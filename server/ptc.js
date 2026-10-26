// Shared ACP extension names; importing these never loads dsh or installs hooks.
export const TOOL_MODE_CONFIG = 'agent_desk_tool_mode'
export const PTC_META = 'agentDesk/ptc'
export const TOOL_MODES = ['native', 'ptc']

export function assertToolMode(mode, { ab, team } = {}) {
  if (!TOOL_MODES.includes(mode)) throw new Error('不明なツール実行方式です')
  if (mode === 'ptc' && (ab || team)) throw new Error('PTCは通常のdshタスクでのみ利用できます')
}

export function toolModeOption(options) {
  return options?.find((option) => option.id === TOOL_MODE_CONFIG)
}

export function assertToolModeApplied(options, mode) {
  if (toolModeOption(options)?.currentValue !== mode) {
    throw new Error('PTC切り替えを実行環境で確認できません。dshとの互換性を確認してください（送信は停止しました）')
  }
}

/** Project only registered PTC tool dispatches; direct Node operations have no such events. */
export function ptcEventUpdate(event) {
  const data = event.data
  const started = event.type === 'tool/ptc-dispatch-start'
  return {
    sessionUpdate: started ? 'tool_call' : 'tool_call_update',
    toolCallId: data.subCallId,
    title: data.name,
    kind: 'other',
    status: started ? 'in_progress' : data.isError ? 'failed' : 'completed',
    rawInput: typeof data.arguments === 'string' ? parseArguments(data.arguments) : data.arguments,
    _meta: { [PTC_META]: { parentCallId: data.parentCallId, rootCallId: data.rootCallId } },
  }
}

function parseArguments(value) {
  try { return JSON.parse(value) } catch { return value }
}

/** Feed PTC content through ACP's existing attachment/content conversion. */
export function ptcResultEvent(event) {
  return { ...event, data: { message: {
    toolCallId: event.data.subCallId,
    isError: event.data.isError,
    content: event.data.content,
  } } }
}
