import { stripTypeScriptTypes } from 'node:module'

/** Keep Node's parse location, not its internal stack or an entire program. */
export function ptcSyntaxMessage(error, program, wrapperLines = 0) {
  if (error?.code !== 'ERR_INVALID_TYPESCRIPT_SYNTAX' || typeof error.stack !== 'string') return error?.message
  const frame = /^:(\d+)\r?\n/.exec(error.stack)
  if (!frame) return error.message
  const lines = program.split(/\r?\n/)
  const line = Number(frame[1]) - wrapperLines
  if (line < 1) return error.message
  if (line > lines.length) return error.message + ' (end of program after line ' + lines.length + ')'
  const source = lines[line - 1]
  const frameLines = error.stack.split(/\r?\n/)
  const markers = frameLines.flatMap((value, index) => value === source && /^[\t ]*\^+[\t ]*$/.test(frameLines[index + 1] ?? '') ? [frameLines[index + 1]] : [])
  const column = markers.length === 1 ? markers[0].indexOf('^') : -1
  // Node's caret uses display/byte columns for tabs and wide characters; do not invent a source column.
  if (column < 0 || column > source.length || /[^\x20-\x7e]/.test(source)) {
    const excerpt = source.length > 96 ? source.slice(0, 48) + ' ... ' + source.slice(-48) : source
    return error.message + ' (line ' + line + ')\n' + excerpt
  }
  const from = Math.max(0, column - 48)
  const to = Math.min(source.length, column + 24)
  const leading = from ? '...' : ''
  const excerpt = leading + source.slice(from, to) + (to < source.length ? '...' : '')
  return error.message + ' (line ' + line + ', column ' + (column + 1) + ')\n'
    + excerpt + '\n' + ' '.repeat(leading.length + column - from) + '^'
}

export function stripPtcTypes(source, program = source, wrapperLines = 0) {
  try { return stripTypeScriptTypes(source) } catch (error) {
    if (error?.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX') error.message = ptcSyntaxMessage(error, program, wrapperLines)
    throw error
  }
}
