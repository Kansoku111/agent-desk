import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import type { UsageScore } from '../types'
import { formatEquivalentCost, isUsdJpyRate, SCORE_NOTE, SCORE_PARTIAL_NOTE } from '../../../shared/usage-score.js'
import { Modal } from './Modal'

export function UsageCost({ score, detail }: { score?: UsageScore | null; detail?: string }) {
  const settings = useStore((state) => state.server?.settings)
  const [open, setOpen] = useState(false)
  const partial = !score || score.unpriced > 0
  const amount = formatEquivalentCost(score, settings)
  const jpy = settings?.usageCurrency === 'JPY'
  const explanation = [
    SCORE_NOTE,
    partial ? SCORE_PARTIAL_NOTE : null,
    jpy ? `USD換算額（累計） ${formatEquivalentCost(score)}` : null,
    jpy ? isUsdJpyRate(settings.usdJpyRate) ? `手動レート 1 USD = ${settings.usdJpyRate} JPY` : '手動レートが未設定です。設定 → 一般で入力してください。' : null,
    detail,
  ].filter(Boolean).join('\n')
  return <>
    <button type="button" className="usage-cost" aria-haspopup="dialog" aria-expanded={open}
      title={`${SCORE_NOTE}${partial ? `\n${SCORE_PARTIAL_NOTE}` : ''}`} onClick={() => setOpen(true)}>
      API換算 {amount}
    </button>
    {open && createPortal(<Modal title="使用量の詳細" onClose={() => setOpen(false)} width={440}>
      <div className="usage-detail">
        <p className="usage-detail-total">API換算（累計） {amount}</p>
        <div className="usage-detail-text">{explanation}</div>
      </div>
    </Modal>, document.body)}
  </>
}
