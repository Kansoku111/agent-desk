// Stop pathological JSON padding, not whitespace inside a code/string argument.
// The observed runaway kept emitting padding for tens of minutes, so an idle
// timeout cannot catch it. Never truncate the arguments or execute a partial call.
export const SIWC_ARGUMENT_WHITESPACE_LIMIT = 8192
export const SIWC_ARGUMENT_RUNAWAY = 'SIWC_TOOL_ARGUMENT_RUNAWAY'

export class SiwcArgumentGuard {
  constructor() { this.calls = new Map() }

  observe(event) {
    if (!event || typeof event !== 'object') return
    const key = event.item_id ?? event.output_index ?? 0
    if (event.type === 'response.function_call_arguments.done') {
      this.calls.delete(key)
      return
    }
    if (event.type !== 'response.function_call_arguments.delta' || typeof event.delta !== 'string') return
    let state = this.calls.get(key)
    if (!state) {
      state = { quoted: false, escaped: false, padding: 0 }
      this.calls.set(key, state)
    }
    for (const char of event.delta) {
      if (state.quoted) {
        if (state.escaped) state.escaped = false
        else if (char === '\\') state.escaped = true
        else if (char === '"') state.quoted = false
        state.padding = 0
      } else if (char === '"') {
        state.quoted = true
        state.padding = 0
      } else if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        if (++state.padding > SIWC_ARGUMENT_WHITESPACE_LIMIT) {
          const error = new Error(SIWC_ARGUMENT_RUNAWAY + ': ツール引数で空白のみの出力が続いたため停止しました。自動再送は行いません。')
          error.code = SIWC_ARGUMENT_RUNAWAY
          throw error
        }
      } else state.padding = 0
    }
  }
}
