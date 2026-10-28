import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { act, openExternal, request, toast, useStore } from '../store'
import type { ClaudeCostState, LocalUsage, UsageState, UsageTotals } from '../types'
import { formatTokens, formatTokensExact, formatUsd } from '../util'

const ADMIN_KEYS_URL = 'https://platform.claude.com/settings/admin-keys'
const COST_URL = 'https://platform.claude.com/cost'

const tokensOf = (totals: UsageTotals) => totals.input + totals.output + totals.cacheRead + totals.cacheWrite
const money = (value: number | null | undefined) => (value ? formatUsd(value) : '$0')
/** A metered cost: '≥' when some billed usage has no known price, '—' when none is priced. */
const priced = (cost: number | null, unpriced: number) => (unpriced > 0 ? (cost ? `≥ ${money(cost)}` : '—') : cost === null ? '—' : money(cost))
/** An estimate: '約' for a known amount (zero when no billed usage), otherwise as priced. */
const estimate = (cost: number | null, unpriced: number) => (unpriced > 0 ? priced(cost, unpriced) : `約 ${money(cost)}`)
const modelName = (model: string) => model.split('/').slice(1).join('/') || model
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`
const fetchedLabel = (at: number) => new Date(at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Refreshes the totals whenever a usage view opens. */
function useUsageRefresh() {
  const [loading, setLoading] = useState(false)
  const refresh = async (maxAgeMs?: number) => {
    setLoading(true)
    await act('usage.get', maxAgeMs === undefined ? {} : { maxAgeMs })
    setLoading(false)
  }
  useEffect(() => {
    void refresh()
  }, [])
  return { loading, refresh }
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="usage-tile">
      <span className="usage-tile-label">{label}</span>
      <span className="usage-tile-value">{value}</span>
      {sub && <span className="usage-tile-sub">{sub}</span>}
    </div>
  )
}

function Bars({ points, label }: { points: { key: string; label: string; value: number; title: string }[]; label: string }) {
  const max = Math.max(...points.map((point) => point.value), 0)
  return (
    <div className="usage-chart" role="img" aria-label={label}>
      <div className="usage-bars">
        {points.map((point) => (
          <span key={point.key} className="usage-bar" title={point.title}>
            <span style={{ height: max > 0 ? `${Math.max(point.value > 0 ? 3 : 0, (point.value / max) * 100)}%` : '0%' }} />
          </span>
        ))}
      </div>
      <div className="usage-axis">
        <span>{points[0]?.label}</span>
        <span>{points.at(-1)?.label}</span>
      </div>
    </div>
  )
}

/** Saving or removing the Admin API key that reads the organization's cost. */
function AdminKeyForm({ configured, masked }: { configured: boolean; masked: string | null }) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const result = await request<{ check: string }>('usage.setAdminKey', { key })
      setKey('')
      toast(result.check === 'ok' ? 'Admin API キーを保存しました' : 'キーを保存しましたが、確認のための接続ができませんでした', result.check === 'ok' ? 'success' : 'info')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setSaving(false)
  }
  return (
    <>
      {configured && (
        <div className="account-row">
          <span>Admin API キー <code className="masked">{masked}</code></span>
          <button type="button" className="button" onClick={() => void act('usage.removeAdminKey')}>削除</button>
        </div>
      )}
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={configured ? '新しいキーで置き換える' : 'sk-ant-admin…'}
          aria-label="Claude の Admin API キー"
        />
        <button type="submit" className="button primary" disabled={!key.trim() || saving}>
          {saving ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} 保存
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <button type="button" className="link-button" onClick={() => openExternal(ADMIN_KEYS_URL)}>
        <ExternalLink size={12} /> Claude Console で Admin API キーを作成
      </button>
    </>
  )
}

const COST_PROBLEM: Partial<Record<ClaudeCostState['status'], string>> = {
  invalid: 'Admin API キーの認証に失敗しました。キーを確認してください。',
  forbidden: 'このキーでは組織の使用量を読めません。',
  error: '請求額を取得できませんでした。',
}

/** The organization's billed cost from the Usage & Cost Admin API. */
function ClaudeCostCard({ claude, loading, onRefresh }: { claude: ClaudeCostState; loading: boolean; onRefresh: () => void }) {
  const admin = useStore((state) => state.server?.accounts.claudeAdmin) ?? { configured: false, masked: null }
  const summary = claude.summary
  return (
    <section className="account-card">
      <div className="account-head">
        <div>
          <h3>Claude の請求額</h3>
          <p className="muted">Agent Desk 以外の利用も含む実際の金額</p>
        </div>
        {claude.status === 'ok' && <span className="badge success"><CheckCircle2 size={12} /> 取得済み</span>}
      </div>

      {summary && (
        <>
          <div className="usage-tiles">
            <Tile label="今日" value={money(summary.today)} />
            <Tile label="今月" value={money(summary.month)} />
            <Tile label="過去 30 日" value={money(summary.last30)} />
            <Tile label="過去 1 年" value={money(summary.all)} sub={summary.since ? `${summary.since} から` : undefined} />
          </div>
          {summary.months.length > 1 && <h4 className="usage-caption">月ごとの請求額</h4>}
          {summary.months.length > 1 && (
            <Bars
              label="月ごとの請求額"
              points={summary.months.map((entry) => ({
                key: entry.month,
                label: `${Number(entry.month.slice(5))}月`,
                value: entry.amount,
                title: `${entry.month}: ${money(entry.amount)}`,
              }))}
            />
          )}
          {summary.models.length > 0 && (
            <table className="usage-table">
              <thead>
                <tr><th>モデル・項目</th><th>今月</th><th>過去 1 年</th></tr>
              </thead>
              <tbody>
                {summary.models.map((entry) => (
                  <tr key={entry.label}><td>{entry.label}</td><td>{money(entry.month)}</td><td>{money(entry.all)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {claude.status === 'none' && (
        <p className="muted">Claude の API キーか Admin API キーを設定すると、ここに請求額が表示されます。</p>
      )}
      {claude.status === 'needs-admin' && (
        <p className="muted">
          請求額の表示には<strong> Admin API キー</strong>（sk-ant-admin…）が必要です。
        </p>
      )}
      {COST_PROBLEM[claude.status] && (
        <p className={summary ? 'form-warning' : 'form-error'}>
          {COST_PROBLEM[claude.status]}{claude.message ? `（${claude.message}）` : ''}
          {summary && claude.fetchedAt ? ` ${fetchedLabel(claude.fetchedAt)} 時点の金額を表示しています。` : ''}
        </p>
      )}

      {(claude.status !== 'ok' || admin.configured) && <AdminKeyForm configured={admin.configured} masked={admin.masked} />}

      <div className="usage-foot">
        <p className="fine-print">
          UTC 基準。
          {claude.fetchedAt ? ` 最終取得: ${fetchedLabel(claude.fetchedAt)}。` : ''}
        </p>
        <span className="usage-foot-actions">
          <button type="button" className="link-button" onClick={() => openExternal(COST_URL)}>
            <ExternalLink size={12} /> Claude Console
          </button>
          {claude.status !== 'none' && (
            <button type="button" className="icon-button small" title="最新の金額を取得" aria-label="請求額を更新" onClick={onRefresh} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </span>
      </div>
    </section>
  )
}

/** Usage across every task, from dsh's logs, priced with the catalog rates. */
function LocalUsageCard({ local }: { local: LocalUsage }) {
  const [scope, setScope] = useState<'month' | 'all'>('month')
  const rows = local.models.filter((entry) => entry[scope].requests > 0)
  return (
    <section className="account-card">
      <div className="account-head">
        <div>
          <h3>Agent Desk での使用量（概算）</h3>
          <p className="muted">dsh のログから見積もった API 料金</p>
        </div>
      </div>

      <div className="usage-tiles">
        <Tile label="今日" value={estimate(local.today.cost, local.today.unpriced)} sub={`全モデルで ${formatTokens(tokensOf(local.today))} トークン`} />
        <Tile label="今月" value={estimate(local.month.cost, local.month.unpriced)} sub={`全モデルで ${formatTokens(tokensOf(local.month))} トークン`} />
        <Tile label="全期間" value={estimate(local.all.cost, local.all.unpriced)} sub={local.since ? `${local.since} から` : undefined} />
      </div>
      <h4 className="usage-caption">過去 30 日の API 概算料金</h4>
      <Bars
        label="過去 30 日の API 概算料金"
        points={local.daily.map((point) => ({
          key: point.day,
          label: shortDay(point.day),
          value: point.cost,
          title: `${point.day}: ${estimate(point.cost, point.unpriced)} · ${formatTokensExact(point.tokens)} トークン`,
        }))}
      />

      <div className="usage-table-head">
        <h4>モデル別</h4>
        <div className="segmented" role="tablist" aria-label="集計期間">
          <button type="button" role="tab" aria-selected={scope === 'month'} className={scope === 'month' ? 'on' : ''} onClick={() => setScope('month')}>今月</button>
          <button type="button" role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>全期間</button>
        </div>
      </div>
      {rows.length === 0
        ? <p className="fine-print">この期間の利用はありません。</p>
        : (
          <table className="usage-table">
            <thead>
              <tr><th>モデル</th><th>回数</th><th>入力</th><th>出力</th><th>概算</th></tr>
            </thead>
            <tbody>
              {rows.map((entry) => {
                const totals = entry[scope]
                return (
                  <tr key={entry.model}>
                    <td title={entry.model}>{modelName(entry.model)}</td>
                    <td>{totals.requests}</td>
                    <td title={`キャッシュ読み込み ${formatTokensExact(totals.cacheRead)} · 書き込み ${formatTokensExact(totals.cacheWrite)}`}>
                      {formatTokens(totals.input + totals.cacheRead + totals.cacheWrite)}
                    </td>
                    <td>{formatTokens(totals.output)}</td>
                    <td>{priced(totals.cost, totals.unpriced)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      <p className="fine-print">
        入力はキャッシュの読み書きを含みます。
      </p>
    </section>
  )
}

/** The settings tab with every usage total. */
export function UsagePanel() {
  const usage = useStore((state) => state.server?.usage) as UsageState | undefined
  const { loading, refresh } = useUsageRefresh()
  if (!usage) return null
  return (
    <div className="settings-section">
      <ClaudeCostCard claude={usage.claude} loading={loading} onRefresh={() => void refresh(0)} />
      {usage.local ? <LocalUsageCard local={usage.local} /> : <p className="fine-print"><Loader2 size={12} className="spin" /> 集計しています…</p>}
    </div>
  )
}
