import { useEffect, useState } from 'react'
import { Gauge, RefreshCw } from 'lucide-react'
import { act, setState, useStore } from '../store'
import type { ChatGptUsageWindow } from '../types'
import { resetLabel } from '../util'

function remaining(window: ChatGptUsageWindow) {
  return Math.max(0, 100 - Math.round(window.usedPercent))
}

function windowLine(window: ChatGptUsageWindow) {
  const reset = resetLabel(window.resetAt)
  return `${window.label}の上限: 残り ${remaining(window)}%${reset ? ` · ${reset}にリセット` : ''}`
}

/** The subscription's limit windows as bars, for the ChatGPT account card. */
export function ChatGptLimits() {
  const usage = useStore((state) => state.server?.chatgptUsage ?? null)
  const [loading, setLoading] = useState(false)
  const refresh = async (maxAgeMs: number) => {
    setLoading(true)
    await act('chatgpt.usage', { maxAgeMs })
    setLoading(false)
  }
  useEffect(() => {
    void refresh(60_000)
  }, [])

  return (
    <div className="limits">
      <div className="limits-head">
        <span>Codex の利用上限（SIWC のアプリ別使用枠とは別）</span>
        <button type="button" className="icon-button small" title="最新の状態に更新" aria-label="利用上限を更新" onClick={() => void refresh(0)} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
        </button>
      </div>
      {!usage && <p className="fine-print">確認しています…</p>}
      {usage?.status === 'signed-out' && <p className="fine-print">画像生成と利用上限（Codex）にサインインしてください。</p>}
      <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">ChatGPT Settings → Usage</a>
      {usage?.status === 'expired' && <p className="fine-print">ログインの有効期限が切れています。次にタスクを実行すると更新されます。</p>}
      {usage?.status === 'error' && <p className="fine-print">取得できませんでした（{usage.message}）。</p>}
      {usage?.status === 'ok' && (
        <>
          {usage.limitReached && <p className="form-warning">Codex の上限に達しています。公式 SIWC のアプリ別使用枠とは異なります。</p>}
          {usage.windows.length === 0 && <p className="fine-print">このプランでは上限の情報がありません。</p>}
          {usage.windows.map((window) => (
            <div key={window.seconds} className="limit-row">
              <div className="limit-label">
                <span>{window.label}</span>
                <span className="limit-value">残り {remaining(window)}%</span>
              </div>
              <div className="limit-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining(window)} aria-label={`${window.label}の残り`}>
                <span className={remaining(window) <= 20 ? 'low' : ''} style={{ width: `${remaining(window)}%` }} />
              </div>
              {window.resetAt && <span className="limit-reset">{resetLabel(window.resetAt)}にリセット</span>}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

/** A compact "remaining" chip for the composer while a GPT model is selected. */
export function ChatGptLimitChip() {
  const usage = useStore((state) => state.server?.chatgptUsage ?? null)
  if (usage?.status !== 'ok' || usage.windows.length === 0) return null
  const tightest = usage.windows.reduce((low, window) => (remaining(window) < remaining(low) ? window : low))
  const left = usage.limitReached ? 0 : remaining(tightest)
  return (
    <button
      type="button"
      className={`limit-chip ${left <= 20 ? 'low' : ''}`}
      title={[...usage.windows.map(windowLine), 'クリックで詳細'].join('\n')}
      onClick={() => setState({ settingsOpen: 'accounts' })}
    >
      <Gauge size={13} />
      <span>Codex {tightest.label} 残り {left}%</span>
    </button>
  )
}
