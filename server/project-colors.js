// The tint each project's group gets in the sidebar, by folder path. A color is
// an index into the web's PROJECT_HUES (web/src/projectColors.ts); -1 is no tint.
export const PROJECT_COLOR_COUNT = 12

export function isProjectColor(value) {
  return Number.isInteger(value) && value >= -1 && value < PROJECT_COLOR_COUNT
}

/** Where a project's color search starts, so the same path tends to get the same color. */
export function preferredColor(path) {
  let hash = 0
  for (const char of String(path)) hash = (hash * 31 + char.codePointAt(0)) >>> 0
  return hash % PROJECT_COLOR_COUNT
}

/**
 * Gives every project without a color the least-used one, so the sidebar shows
 * as many different colors as it can. Colors already chosen are kept.
 * @returns {Record<string, number> | null} the new map, or null when nothing changed
 */
export function assignProjectColors(colors, paths) {
  const next = { ...colors }
  const used = new Array(PROJECT_COLOR_COUNT).fill(0)
  for (const value of Object.values(next)) if (value >= 0) used[value]++
  let changed = false
  for (const path of new Set(paths)) {
    if (isProjectColor(next[path])) continue
    const start = preferredColor(path)
    let best = start
    for (let step = 1; step < PROJECT_COLOR_COUNT; step++) {
      const candidate = (start + step) % PROJECT_COLOR_COUNT
      if (used[candidate] < used[best]) best = candidate
    }
    next[path] = best
    used[best]++
    changed = true
  }
  return changed ? next : null
}
