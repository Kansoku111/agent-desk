import type { Turn } from './types'

/** Whether two parsed-JSON values are equal all the way down. */
export function sameJson(a: any, b: any): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}

/**
 * A turn arrives whole on every update. The items that did not change keep their
 * previous objects, so what renders them (memo) and what was computed from them
 * (tool summaries) can be reused; a turn with nothing changed stays as it was.
 */
export function shareTurn(previous: Turn | undefined, next: Turn): Turn {
  if (!previous) return next
  const before = new Map(previous.items.map((item) => [`${item.type}-${item.id}`, item]))
  const items = next.items.map((item) => {
    const old = before.get(`${item.type}-${item.id}`)
    return old && sameJson(old, item) ? old : item
  })
  const shared = { ...next, items }
  if (items.length === previous.items.length && items.every((item, i) => item === previous.items[i]) && sameJson({ ...previous, items: null }, { ...shared, items: null })) return previous
  return shared
}

/** The turns with one turn's speed replaced; null when nothing changes. */
export function withSpeed(turns: Turn[] | undefined, turnId: string, speed: Turn['outputSpeed'] | null): Turn[] | null {
  const index = turns?.findIndex((turn) => turn.id === turnId) ?? -1
  if (!turns || index < 0) return null
  const turn = turns[index]
  if (sameJson(turn.outputSpeed ?? null, speed)) return null
  const { outputSpeed: _old, ...rest } = turn
  return turns.map((entry, i) => (i === index ? (speed ? { ...rest, outputSpeed: speed } : rest) : entry))
}
