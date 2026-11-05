import { stripTypeScriptTypes } from 'node:module'

// Node's parser codeframe uses display columns. Support only widths we can
// map unambiguously; tabs, emoji and combining sequences retain the fallback.
function sourceOffset(source, displayColumn) {
  let display = 0
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index)
    const width = code >= 0x20 && code <= 0x7e ? 1
      : (code >= 0x3041 && code <= 0x3096) || (code >= 0x30a1 && code <= 0x30fa) || (code >= 0x4e00 && code <= 0x9fff) ? 2 : 0
    // A zero-width unsupported character can occupy the caret boundary.
    if (!width) return null
    if (display === displayColumn) return index
    if (display + width > displayColumn) return null
    display += width
  }
  return display === displayColumn ? source.length : null
}

function safeExcerpt(text) {
  // A bounded slice can split a surrogate pair; terminal controls must not run.
  return text.toWellFormed().replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '�')
}

/** Keep Node's parse location, not its internal stack or an entire program. */
export function ptcSyntaxMessage(error, program, wrapperLines = 0) {
  if (error?.code !== 'ERR_INVALID_TYPESCRIPT_SYNTAX' || typeof error.stack !== 'string') return error?.message
  const frame = /^:(\d+)\r?\n/.exec(error.stack)
  if (!frame) return error.message
  const lines = program.split(/\r\n|\r|\n/)
  const line = Number(frame[1]) - wrapperLines
  if (line < 1) return error.message
  if (line > lines.length) return error.message + ' (end of program after line ' + lines.length + ')'
  const source = lines[line - 1]
  const frameLines = error.stack.split(/\r?\n/)
  const markers = frameLines.flatMap((value, index) => value === source && /^[\t ]*\^+[\t ]*$/.test(frameLines[index + 1] ?? '') ? [frameLines[index + 1]] : [])
  const displayColumn = markers.length === 1 ? markers[0].indexOf('^') : -1
  const column = displayColumn >= 0 ? sourceOffset(source, displayColumn) : null
  if (column === null) {
    const excerpt = source.length > 96 ? source.slice(0, 48) + ' ... ' + source.slice(-48) : source
    return error.message + ' (line ' + line + ')\n' + safeExcerpt(excerpt)
  }
  const from = Math.max(0, column - 48)
  const to = Math.min(source.length, column + 24)
  const leading = from ? '...' : ''
  const excerpt = leading + source.slice(from, to) + (to < source.length ? '...' : '')
  // Widths before the caret are known to sourceOffset, including in the excerpt.
  const before = source.slice(from, column)
  const wide = [...before].filter(char => char.charCodeAt(0) > 0x7e).length
  return error.message + ' (line ' + line + ', column ' + (column + 1) + ')\n'
    + safeExcerpt(excerpt) + '\n' + ' '.repeat(leading.length + before.length + wide) + '^'
}

export function stripPtcTypes(source, program = source, wrapperLines = 0) {
  try { return stripTypeScriptTypes(source) } catch (error) {
    if (error?.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX') error.message = ptcSyntaxMessage(error, program, wrapperLines)
    throw error
  }
}
