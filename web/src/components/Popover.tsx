import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Check } from 'lucide-react'

interface DropdownProps {
  /** Renders the trigger; call `toggle` from its onClick. */
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  placement?: 'top' | 'bottom'
  align?: 'left' | 'right'
  width?: number
  className?: string
  /** Pins the panel to the screen instead of its trigger's box, for a trigger inside a scrolling list that would clip it. */
  fixed?: boolean
  /** Called when the panel closes, however it was closed. */
  onClose?: () => void
}

/** Gap between the trigger and the panel (matches `.menu-top`/`.menu-bottom`) plus room left at the screen edge. */
const MENU_GAP = 6
const MENU_EDGE = 8

/** A trigger plus a floating panel that closes on outside click or Escape. */
export function Dropdown({ trigger, children, placement = 'top', align = 'left', width, className, fixed, onClose }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const closed = useRef(onClose)
  closed.current = onClose
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !open) closed.current?.()
    wasOpen.current = open
  }, [open])
  // Where the panel actually fits: on a phone the composer can sit near the top of the screen, so a
  // `top` menu flips below the trigger, and either way it is capped to the room it has.
  const [fit, setFit] = useState<{ side: 'top' | 'bottom'; room: number; at?: CSSProperties } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) {
      setFit(null)
      return
    }
    const place = () => {
      const anchor = root.current?.getBoundingClientRect()
      const panel = menu.current
      if (!anchor || !panel) return
      const view = window.visualViewport
      const viewTop = view?.offsetTop ?? 0
      const viewBottom = viewTop + (view?.height ?? window.innerHeight)
      const room = {
        top: Math.floor(anchor.top - viewTop - MENU_GAP - MENU_EDGE),
        bottom: Math.floor(viewBottom - anchor.bottom - MENU_GAP - MENU_EDGE),
      }
      // Measure the panel at its natural height, without the cap from a previous placement.
      panel.style.maxHeight = 'none'
      const needed = panel.offsetHeight
      panel.style.maxHeight = ''
      const other = placement === 'top' ? 'bottom' : 'top'
      const side = needed <= room[placement] || room[placement] >= room[other] ? placement : other
      // A pinned panel is placed from the trigger's screen position; a scroll under it would leave it behind, so it closes.
      const at: CSSProperties | undefined = fixed
        ? {
          position: 'fixed',
          ...(side === 'top' ? { bottom: window.innerHeight - anchor.top + MENU_GAP } : { top: anchor.bottom + MENU_GAP }),
          ...(align === 'right' ? { right: document.documentElement.clientWidth - anchor.right } : { left: anchor.left }),
        }
        : undefined
      setFit((current) => (current?.side === side && current.room === room[side] && !fixed ? current : { side, room: room[side], at }))
    }
    place()
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    const onScroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false)
    }
    if (fixed) window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, placement, align, fixed])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    // Move focus into the panel for keyboard users.
    const first = root.current?.querySelector<HTMLElement>('.menu [role="menuitem"]:not([disabled]), .menu input')
    first?.focus()
  }, [open])

  const close = () => setOpen(false)
  return (
    <div className={`dropdown ${className ?? ''}`} ref={root}>
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open && (
        <div
          ref={menu}
          className={`menu menu-${fit?.side ?? placement} menu-${align}`}
          style={{ ...(width ? { width } : null), ...(fit ? { '--menu-room': `${Math.max(fit.room, 120)}px`, ...fit.at } : null) } as CSSProperties}
          role="menu"
          onKeyDown={(event) => {
            // An item's own keys (MenuItem `keys`) choose it, except while typing in the menu.
            const typing = (event.target as HTMLElement).closest('input, textarea')
            const shortcut = typing ? null : [...(root.current?.querySelectorAll<HTMLElement>('.menu [role="menuitem"][data-keys]:not([disabled])') ?? [])]
              .find((item) => item.dataset.keys!.split(' ').includes(event.key))
            if (shortcut) {
              event.preventDefault()
              shortcut.click()
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const items = [...(root.current?.querySelectorAll<HTMLElement>('.menu [role="menuitem"]:not([disabled])') ?? [])]
            const index = items.indexOf(document.activeElement as HTMLElement)
            const next = event.key === 'ArrowDown' ? index + 1 : index - 1
            items[(next + items.length) % items.length]?.focus()
          }}
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}

interface MenuItemProps {
  icon?: ReactNode
  label: ReactNode
  description?: ReactNode
  hint?: ReactNode
  selected?: boolean
  disabled?: boolean
  danger?: boolean
  /** Keys (`KeyboardEvent.key`) that choose the item while its menu is open. */
  keys?: string[]
  onSelect: () => void
}

export function MenuItem({ icon, label, description, hint, selected, disabled, danger, keys, onSelect }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item ${danger ? 'danger' : ''} ${selected ? 'selected' : ''}`}
      disabled={disabled}
      data-keys={keys?.join(' ')}
      onClick={onSelect}
    >
      {icon && <span className="menu-icon">{icon}</span>}
      <span className="menu-text">
        <span className="menu-label">{label}</span>
        {description && <span className="menu-description">{description}</span>}
      </span>
      {hint && <span className="menu-hint">{hint}</span>}
      {selected && <Check size={15} className="menu-check" />}
    </button>
  )
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="menu-heading">{children}</div>
}

export function MenuDivider() {
  return <div className="menu-divider" />
}
