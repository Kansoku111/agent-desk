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
// The window is 32,768 characters so legitimate repetitive content (a fixture,
// a separator line, a generated table) has room: the observed loops ran past
// 100,000 characters. At the slowest observed rate (about 75 characters a
// second) a full window takes about 7 minutes, against the 3-37 minutes the
// backend took to cut them.
// Whitespace inside a string (blank lines are `\n\n...` in JSON) and a run of
// one character stay allowed, as the padding rule allows them.
export const SIWC_ARGUMENT_WHITESPACE_LIMIT = 8192
export const SIWC_ARGUMENT_RUNAWAY = 'SIWC_TOOL_ARGUMENT_RUNAWAY'
export const SIWC_ARGUMENT_REPEAT_WINDOW = 32768
const WINDOW = SIWC_ARGUMENT_REPEAT_WINDOW
const MAX_PERIOD = 64
const CHECK_EVERY = 4096
// Unlike padding, a repetition loop is retried: the backend already cut every
// observed loop after 3-37 minutes and dsh retried that interruption. Stopping
// early keeps that outcome without the wait.
export const SIWC_ARGUMENT_REPEAT = 'SIWC_TOOL_ARGUMENT_REPEAT'

// A loop is not always exact. One observed loop turned `\u001b[0m` into
// `\u001b[0b` twice in 76,000 characters; requiring an exact match over the
// whole window waited until both slips had left it (77,800 characters and 15
// minutes instead of about 10,000), and slips more often than once a window
// would never be stopped. A slipped character breaks at most two comparisons,
// so a tail that matches itself one unit later in all but SLIPS places is still
// one unit repeated: 32 is 0.1% of the window.
const SLIPS = 32

function mismatches(tail, period) {
  let count = 0
  for (let at = period; at < tail.length; at++) if (tail.charCodeAt(at) !== tail.charCodeAt(at - period) && ++count > SLIPS) break
  return count
}

/** The repeating unit's length when `tail` is one short unit repeated, else 0. */
export function repeatingPeriod(tail) {
  if (mismatches(tail, 1) <= SLIPS) return 0
  for (let period = 2; period <= MAX_PERIOD; period++) {
    if (mismatches(tail, period) > SLIPS) continue
    // A slip or the end of a string can fall in any one unit, so the unit is
    // read at the start, middle and end of the tail and the majority decides.
    const blank = [0, (tail.length - period) >> 1, tail.length - period].filter(at => blankUnit(tail.slice(at, at + period))).length
    return blank >= 2 ? 0 : period
  }
  return 0
}

const BLANK = /^(?:\\[nrt]|\s)+$/
// Whitespace and JSON whitespace escapes only. The window can start inside an
// escape, so the unit may read `n\` for `\n`; any rotation of it may match.
function blankUnit(unit) {
  for (let at = 0; at < unit.length; at++) if (BLANK.test(unit.slice(at) + unit.slice(0, at))) return true
  return false
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
