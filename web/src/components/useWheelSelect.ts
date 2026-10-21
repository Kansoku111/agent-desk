import { useCallback, useEffect, useRef, useState } from 'react'

/** Wheel travel (px) that starts a move; small touchpad deltas add up to it. */
const STEP_PX = 40
/** One mouse-wheel notch; Chrome may merge fast notches into one event. */
const NOTCH_PX = 100
/** Quiet time after the last step before the choice is committed. */
const COMMIT_MS = 350
/** How long a committed choice may wait for the store to echo it back. */
const ECHO_TIMEOUT_MS = 3000

/**
 * Lets a picker's trigger change its value with the mouse wheel while the
 * pointer is over it: scrolling down moves to the next entry in menu order,
 * up to the previous, stopping at either end. The label follows each step at
 * once, and only the final choice is committed, so a fast scroll through many
 * entries sends a single update.
 * @param options - the selectable values in menu order.
 * @param value - the committed value.
 * @param onChange - commits a value.
 * @returns a callback ref for the trigger element and the value to display.
 */
export function useWheelSelect<T extends HTMLElement>(options: string[], value: string | null, onChange: (value: string) => void) {
  const [pending, setPending] = useState<string | null>(null)
  const latest = useRef({ options, value, onChange })
  latest.current = { options, value, onChange }
  const travel = useRef(0)
  // The entry the wheel is on; wheel events can arrive faster than renders.
  const cursor = useRef<string | null>(null)
  const commitTimer = useRef<number | undefined>(undefined)
  const echoTimer = useRef<number | undefined>(undefined)

  // The store caught up with the committed choice.
  useEffect(() => {
    if (pending !== null && value === pending) {
      window.clearTimeout(echoTimer.current)
      cursor.current = null
      setPending(null)
    }
  }, [value, pending])

  const detach = useRef<(() => void) | null>(null)
  const ref = useCallback((element: T | null) => {
    detach.current?.()
    detach.current = null
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if ((element as unknown as HTMLButtonElement).disabled) return
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      const { options: list, value: committed } = latest.current
      if (!list.length || (list.length === 1 && list[0] === (cursor.current ?? committed))) return
      event.preventDefault()
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1
      // A direction change starts a fresh step instead of first undoing the old travel.
      if (Math.sign(event.deltaY) !== Math.sign(travel.current)) travel.current = 0
      travel.current += event.deltaY * scale
      if (Math.abs(travel.current) < STEP_PX) return
      const step = Math.sign(travel.current) * Math.max(1, Math.round(Math.abs(travel.current) / NOTCH_PX))
      travel.current = 0
      const shown = cursor.current ?? committed
      const current = list.indexOf(shown ?? '')
      const from = current === -1 ? (step > 0 ? -1 : list.length) : current
      const next = list[Math.min(list.length - 1, Math.max(0, from + step))]
      if (next === undefined || next === shown) return
      cursor.current = next
      setPending(next)
      window.clearTimeout(commitTimer.current)
      commitTimer.current = window.setTimeout(() => {
        const { value: settled, onChange: commit } = latest.current
        travel.current = 0
        // Options may disappear while a wheel commit is waiting (for example,
        // another window hides a model). Never commit a removed choice.
        if (next === settled || !latest.current.options.includes(next)) {
          cursor.current = null
          setPending(null)
          return
        }
        commit(next)
        // If the update fails, fall back to the committed value.
        window.clearTimeout(echoTimer.current)
        echoTimer.current = window.setTimeout(() => {
          cursor.current = null
          setPending(null)
        }, ECHO_TIMEOUT_MS)
      }, COMMIT_MS)
    }
    // React's onWheel is passive, so the page would scroll too; this one may preventDefault.
    element.addEventListener('wheel', onWheel, { passive: false })
    detach.current = () => element.removeEventListener('wheel', onWheel)
  }, [])

  // The callback ref detaches the listener itself when the trigger unmounts.
  useEffect(() => () => {
    window.clearTimeout(commitTimer.current)
    window.clearTimeout(echoTimer.current)
  }, [])

  return { ref, shown: pending ?? value, pending: pending !== null }
}
