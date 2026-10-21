import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({ title, onClose, children, width = 520, className }: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  width?: number
  className?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panel}
        className={`modal ${className ?? ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="閉じる" onClick={onClose}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onClose }: {
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title={title} onClose={onClose} width={420}>
      <div className="modal-body">{body}</div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>キャンセル</button>
        <button
          type="button"
          className={`button ${danger ? 'danger' : 'primary'}`}
          autoFocus
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
