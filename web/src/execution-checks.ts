/** The next `check-N` ID that no row uses. Typed IDs count too, trimmed as the server reads them. */
export function nextCheckId(checks: { id: string }[]) {
  const used = new Set(checks.map((check) => check.id.trim()))
  let n = 1
  while (used.has(`check-${n}`)) n++
  return `check-${n}`
}
