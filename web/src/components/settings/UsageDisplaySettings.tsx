import { useState } from 'react'
import { request, useStore } from '../../store'
import { isUsdJpyRate } from '../../../../shared/usage-score.js'

/** Display preferences only: never change recorded usage or metered billing totals. */
export function UsageDisplaySettings() {
  const settings = useStore((state) => state.server?.settings)
  const saved = { currency: settings?.usageCurrency ?? 'USD', rate: String(settings?.usdJpyRate ?? '') }
  const [draft, setDraft] = useState(saved)
  const [base, setBase] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Follow another window's updates only while this form is clean.
  if (saved.currency !== base.currency || saved.rate !== base.rate) {
    if (draft.currency === base.currency && draft.rate === base.rate) setDraft(saved)
    setBase(saved)
  }
  const jpy = draft.currency === 'JPY'
  const rate = Number(draft.rate)
  const valid = !jpy || isUsdJpyRate(rate)
  const dirty = draft.currency !== saved.currency || (jpy && rate !== settings?.usdJpyRate)
  const save = async () => {
    if (!valid || !dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      await request('settings.update', { patch: { usageCurrency: draft.currency, ...(jpy ? { usdJpyRate: rate } : {}) } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setSaving(false)
  }
  return <div className="setting usage-display-setting">
    <h3>回答末尾のAPI換算額</h3>
    <div>
      <form className="usage-display-controls" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <select aria-label="API換算額の表示通貨" value={draft.currency} disabled={saving}
          onChange={(event) => { setDraft({ ...draft, currency: event.target.value as 'USD' | 'JPY' }); setError(null) }}>
          <option value="USD">USD（ドル）</option>
          <option value="JPY">JPY（円）</option>
        </select>
        {jpy && <label className="usage-rate">1 USD =
          <input type="number" inputMode="decimal" step="any" min="0" required aria-label="1 USDあたりの円"
            value={draft.rate} disabled={saving} onChange={(event) => { setDraft({ ...draft, rate: event.target.value }); setError(null) }} /> 円
        </label>}
        <button type="submit" className="button" disabled={!dirty || !valid || saving}>{saving ? '保存中…' : '保存'}</button>
      </form>
      {jpy && draft.rate !== '' && !valid && <p className="form-error" role="alert">正の数を入力してください。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  </div>
}
