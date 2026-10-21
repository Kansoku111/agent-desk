/** Range selection only includes rows in the current visible ordering. */
export function selectThreadRange(selected: readonly string[], visible: readonly string[], anchor: string | null, target: string, range: boolean): string[] {
  if (!visible.includes(target)) return [...selected]
  const start = anchor === null ? -1 : visible.indexOf(anchor)
  const end = visible.indexOf(target)
  if (range && start >= 0) {
    return [...new Set([...selected, ...visible.slice(Math.min(start, end), Math.max(start, end) + 1)])]
  }
  return selected.includes(target) ? selected.filter((id) => id !== target) : [...selected, target]
}
