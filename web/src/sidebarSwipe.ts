import { useEffect } from 'react'
import { getState, isNarrow, setState } from './store'

// A swipe right opens the sidebar on a phone, a swipe left closes it.
const MIN_DISTANCE = 64
// Sideways travel must dominate: a diagonal drag is a scroll.
const MAX_SLOPE = 0.5
const MAX_DURATION = 800

/** Which way a sideways scroller under the finger can still pan: fingerRight shows what is to its left. */
function panning(from: EventTarget | null) {
  const can = { fingerRight: false, fingerLeft: false }
  for (let element = from instanceof Element ? from : null; element; element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth + 1) continue
    const overflow = getComputedStyle(element).overflowX
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    if (element.scrollLeft > 0) can.fingerRight = true
    if (element.scrollLeft + element.clientWidth < element.scrollWidth - 1) can.fingerLeft = true
  }
  return can
}

function dialogOpen() {
  const { settingsOpen, projectDialog, teamStart } = getState()
  return settingsOpen !== null || projectDialog || teamStart !== null
}

export function useSidebarSwipe() {
  useEffect(() => {
    let start: { x: number; y: number; time: number; can: ReturnType<typeof panning> } | null = null

    const onStart = (event: TouchEvent) => {
      start = null
      if (event.touches.length !== 1 || !isNarrow() || dialogOpen()) return
      // A pinch-zoomed page pans under the finger.
      if (window.visualViewport && window.visualViewport.scale > 1.01) return
      const { target } = event
      // Dragging in a text field moves the caret or selects.
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return
      const touch = event.touches[0]
      start = { x: touch.clientX, y: touch.clientY, time: event.timeStamp, can: panning(target) }
    }
    const onEnd = (event: TouchEvent) => {
      const from = start
      start = null
      if (!from || event.touches.length) return
      const touch = event.changedTouches[0]
      const dx = touch.clientX - from.x
      const dy = touch.clientY - from.y
      if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dy) > Math.abs(dx) * MAX_SLOPE || event.timeStamp - from.time > MAX_DURATION) return
      const open = getState().sidebarOpen
      if (dx > 0 && !open && !from.can.fingerRight) setState({ sidebarOpen: true })
      else if (dx < 0 && open && !from.can.fingerLeft) setState({ sidebarOpen: false })
    }
    const cancel = () => {
      start = null
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', cancel, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', cancel)
    }
  }, [])
}
