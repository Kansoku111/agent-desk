// Stop pathological JSON padding, not whitespace inside a code/string argument.
// The observed runaway kept emitting padding for tens of minutes, so an idle
// timeout cannot catch it. Never truncate the arguments or execute a partial call.
//
// A second runaway shape: a call breaks its JSON (one lost "new_string": key)
// and then repeats one short unit, e.g. `}]} (sic) ` for 181k characters over
// 27 minutes, until the backend cuts the stream. It is not whitespace, so the
// padding rule never sees it, and data keeps arriving, so the idle limit never
// fires either. A tail of WINDOW characters that is one unit of at most
// MAX_PERIOD characters repeated is a runaway too. Replaying 152,778 logged
// calls flagged only real loops (docs/investigations/dsh-vs-codex-harness-20261112.md).
// Whitespace inside a string (blank lines are `\n\n...` in JSON) and a run of
// one character stay allowed, as the padding rule allows them.
export const SIWC_ARGUMENT_WHITESPACE_LIMIT = 8192
export const SIWC_ARGUMENT_RUNAWAY = 'SIWC_TOOL_ARGUMENT_RUNAWAY'
const WINDOW = 8192
const MAX_PERIOD = 64
const CHECK_EVERY = 1024
// Unlike padding, a repetition loop is retried: the backend already cut every
// observed loop after 3-37 minutes and dsh retried that interruption. Stopping
// early keeps that outcome without the wait.
export const SIWC_ARGUMENT_REPEAT = 'SIWC_TOOL_ARGUMENT_REPEAT'

/** The repeating unit's length when `tail` is one short unit repeated, else 0. */
export function repeatingPeriod(tail) {
  if (tail.slice(1) === tail.slice(0, -1)) return 0
  for (let period = 2; period <= MAX_PERIOD; period++) {
    if (tail.slice(period) !== tail.slice(0, tail.length - period)) continue
    // The window can start inside an escape, so the unit may be `n\` rather than `\n`.
    return tail.slice(-period).replace(/[\\nrt\s]/g, '') ? period : 0
  }
  return 0
}

function runaway() {
  const error = new Error(SIWC_ARGUMENT_RUNAWAY + ': ツール引数で空白のみの出力が続いたため停止しました。自動再送は行いません。')
  error.code = SIWC_ARGUMENT_RUNAWAY
  return error
}

function repetition(period) {
  const error = new Error(`${SIWC_ARGUMENT_REPEAT}: ツール引数で${period}文字の同じ並びが繰り返されたため、この応答を止めて再試行します。`)
  error.code = SIWC_ARGUMENT_REPEAT
  return error
}

export class SiwcArgumentGuard {
  constructor() { this.calls = new Map() }

  observe(event) {
    if (!event || typeof event !== 'object') return
    const key = event.item_id ?? event.output_index ?? 0
    if (event.type === 'response.function_call_arguments.done' || event.type === 'response.custom_tool_call_input.done') {
      this.calls.delete(key)
      return
    }
    const json = event.type === 'response.function_call_arguments.delta'
    if ((!json && event.type !== 'response.custom_tool_call_input.delta') || typeof event.delta !== 'string') return
    let state = this.calls.get(key)
    if (!state) {
      state = { quoted: false, escaped: false, padding: 0, tail: '', sinceCheck: 0 }
      this.calls.set(key, state)
    }
    if (json) {
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
          if (++state.padding > SIWC_ARGUMENT_WHITESPACE_LIMIT) throw runaway()
        } else state.padding = 0
      }
    }
    state.tail = (state.tail + event.delta).slice(-WINDOW)
    state.sinceCheck += event.delta.length
    if (state.tail.length < WINDOW || state.sinceCheck < CHECK_EVERY) return
    state.sinceCheck = 0
    const period = repeatingPeriod(state.tail)
    if (period) throw repetition(period)
  }
}
