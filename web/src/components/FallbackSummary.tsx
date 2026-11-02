import { setState } from '../store'
import type { AppState } from '../types'

const effortNames: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '最高', max: '最大', minimal: '最小', off: 'オフ' }
function targetName(server: AppState, value: string) {
  if (value.startsWith('claude:')) {
    const id = value.slice(7)
    const name = ({ opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' } as Record<string, string>)[id]
      ?? server.catalog.models.find((model) => model.provider === 'anthropic' && model.id === id)?.name ?? id
    return 'Claude Code / ' + name
  }
  const entry = server.catalog.models.find((model) => model.value === value)
  return entry ? (server.catalog.providers?.[entry.provider] ?? entry.provider) + ' / ' + entry.name : value
}

/** A read-only view of the effective policy; editing has one shared entry point. */
export function FallbackSummary({ server, value, effort, shared, sourceSelected = true, disabled = false, frozen = false }: {
  server: AppState; value: string; effort: string; shared: boolean; sourceSelected?: boolean; disabled?: boolean; frozen?: boolean
}) {
  return <div className="account-card">
    <div><strong>利用上限時のフォールバック</strong> <span className="muted">（{shared ? '共通設定' : '従来の設定'}）</span></div>
    <p className="muted">{!sourceSelected && shared ? 'リーダーを選ぶと切り替え先が決まります。'
      : value ? <>切り替え先: <strong>{targetName(server, value)}</strong>（推論: {effortNames[effort] ?? (effort || '既定')}）</>
        : '切り替え先はありません。'}</p>
    {!shared && <p className="muted">従来の選択はそのまま使います。共通設定を保存すると、新しい実行から共通設定に切り替わります。</p>}
    {frozen && <p className="muted">このチームは開始時の設定を使います。共通設定の変更は新しい実行から適用します。</p>}
    <button type="button" className="link-button" disabled={disabled} onClick={() => setState({ settingsOpen: 'models' })}>設定 → モデルを開く</button>
  </div>
}
