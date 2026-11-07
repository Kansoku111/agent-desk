// Retention is a preference, not a reason to skip pressure relief forever.
// A large imported first message can consume the entire retained-tail budget.
// In that case condense the smallest balanced prefix and keep the largest
// possible recent tail. Transactions, summaries and persistence stay upstream.
export function patchCompactionSource(source) {
  const start = source.indexOf('function selectCompactableRange(session, measurement, retainTokens) {')
  const end = source.indexOf('\n}', start)
  if (start < 0 || end < 0) return null
  const original = source.slice(start, end + 2)
  const anchor = '\tconst firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;'
  const skip = '\tif (keepFromIdx <= firstIdx) return null;'
  if (!original.includes(anchor) || original.split(skip).length !== 3
    || !original.includes('toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])')) return null
  const fallback = [
    anchor,
    '\t// Keep at least one recent node and never cut a tool-call/result pair.',
    '\tconst fallbackRange = () => {',
    '\t\tfor (let index = firstIdx + 1; index < surfaceNodes.length; index += 1) {',
    '\t\t\tif (toolPairingBalancedBefore(session, surfaceNodes[index])) return {',
    '\t\t\t\tstart: surfaceNodes[firstIdx], end: surfaceNodes[index - 1]',
    '\t\t\t};',
    '\t\t}',
    '\t\treturn null;',
    '\t};',
  ].join('\n')
  const patched = original.replace(anchor, fallback).replaceAll(skip, '\tif (keepFromIdx <= firstIdx) return fallbackRange();')
  return source.slice(0, start) + patched + source.slice(end + 2)
}
