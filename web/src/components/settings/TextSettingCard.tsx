import { useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { request, toast, useStore } from '../../store'
import type { Settings } from '../../types'

type TextKey = { [K in keyof Settings]-?: NonNullable<Settings[K]> extends string ? K : never }[keyof Settings]

/** One free-text setting, edited here and saved as written (カスタム指示, the team harnesses). */
export function TextSettingCard({ setting, title, label = title, description, max, placeholder, rows, head, children }: {
  setting: TextKey; title: string; label?: string; description?: string; max: number; placeholder: string; rows: number
  /** Beside the title (a switch). */
  head?: ReactNode
  /** Under the card (a note). */
  children?: ReactNode
}) {
  const saved = useStore((state) => (state.server?.settings[setting] as string | undefined) ?? '')
  const [draft, setDraft] = useState(saved)
  const [base, setBase] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Saved elsewhere (another window, a phone): follow it unless there are unsaved edits here.
  if (saved !== base) {
    setBase(saved)
    if (draft === base) setDraft(saved)
  }
  const dirty = draft !== saved
  const tooLong = draft.length > max

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await request('settings.update', { patch: { [setting]: draft } })
      toast(draft.trim() ? `${label}を保存しました` : `${label}を消去しました`, 'success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setSaving(false)
  }

  return (
    <section className="account-card">
      <div className="account-head">
        <div>
          <h3>{title}</h3>
          {description && <p className="muted">{description}</p>}
        </div>
        {head}
      </div>
      <textarea
        className="instructions-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && dirty && !tooLong && !saving) {
            event.preventDefault()
            void save()
          }
        }}
        placeholder={placeholder}
        aria-label={title}
        rows={rows}
        spellCheck={false}
      />
      <div className="instructions-footer">
        <span className={tooLong ? 'form-error' : 'fine-print'}>
          {draft.length.toLocaleString()} / {max.toLocaleString()} 文字
        </span>
        <div className="instructions-actions">
          {dirty && (
            <button type="button" className="button" onClick={() => setDraft(saved)} disabled={saving}>
              元に戻す
            </button>
          )}
          <button type="button" className="button primary" onClick={() => void save()} disabled={!dirty || tooLong || saving}>
            {saving && <Loader2 size={14} className="spin" />} 保存
          </button>
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      {children}
    </section>
  )
}
