// Sidebar tints for projects. The server stores an index into this list per
// folder (server/project-colors.js keeps the same count); -1 is no tint.
export const PROJECT_HUES = [210, 145, 28, 275, 340, 175, 48, 0, 235, 95, 305, 192]

/** Same start as the server's preferredColor, for a folder it has not colored. */
function preferredColor(path: string) {
  let hash = 0
  for (const char of path) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return hash % PROJECT_HUES.length
}

export function projectColor(colors: Record<string, number> | undefined, path: string) {
  const value = colors?.[path]
  return typeof value === 'number' && value >= -1 && value < PROJECT_HUES.length ? value : preferredColor(path)
}

/** The color one wheel step away; the cycle passes through "no tint" after the last hue. */
export function stepColor(color: number, step: number) {
  const stops = PROJECT_HUES.length + 1
  return ((color + 1 + step) % stops + stops) % stops - 1
}
