/** Wheel travel (px) that starts a move; small touchpad deltas add up to it. */
const STEP_PX = 40
const NOTCH_PX = 100

let travel = 0
let lastTarget: EventTarget | null = null

/**
 * Lets every dropdown (model, reasoning level, ...) change with the mouse
 * wheel while the pointer is over it: down picks the next enabled entry, up
 * the previous, stopping at either end. Open dropdowns scroll their own list.
 */
export function installSelectWheel() {
  document.addEventListener('wheel', (event) => {
    const select = (event.target as Element | null)?.closest?.('select')
    if (!select || select.disabled || select.multiple || select === document.activeElement) return
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    const options = [...select.options]
    const enabled = options.filter((option) => !option.disabled)
    if (enabled.length < 2) return
    event.preventDefault()
    if (lastTarget !== select || Math.sign(event.deltaY) !== Math.sign(travel)) travel = 0
    lastTarget = select
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1
    travel += event.deltaY * scale
    if (Math.abs(travel) < STEP_PX) return
    const step = Math.sign(travel) * Math.max(1, Math.round(Math.abs(travel) / NOTCH_PX))
    travel = 0
    const from = enabled.indexOf(options[select.selectedIndex])
    const next = enabled[Math.min(enabled.length - 1, Math.max(0, (from === -1 ? (step > 0 ? -1 : enabled.length) : from) + step))]
    if (!next || next.value === select.value) return
    select.value = next.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }, { passive: false })
}
