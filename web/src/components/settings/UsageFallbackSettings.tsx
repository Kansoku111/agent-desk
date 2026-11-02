import { useState } from 'react'
import { act } from '../../store'
import type { AppState, Settings } from '../../types'
import { ModelField, modelGroups } from '../WorkflowModelField'
import { ClaudeAuthConsent } from '../ClaudeAuthConsent'
import type { AuthConsentState } from '../../team-auth-consent'
import { fallbackProvider } from '../../../../shared/usage-fallback.js'
import { workflowEffort, workflowEffortSupported, workflowLevels, workflowOptions } from '../../../../shared/workflow-effort.js'

type Route = { model: string; effort: string }
type Saved = Route[] | null
const copy = (value: Saved): Saved => value === null ? null : value.map((route) => ({ ...route }))

/** Changes take effect only on explicit save; a running workflow keeps its snapshot. */
export function UsageFallbackSettings({ server }: { server: AppState }) {
  const current = server.settings.usageFallbackRoutes ?? null
  const [base, setBase] = useState<Saved>(() => copy(current))
  const [routes, setRoutes] = useState<Route[]>(() => copy(current) ?? [])
  const [saving, setSaving] = useState(false)
  const [auth, setAuth] = useState<AuthConsentState>({ ready: false })
  const [authRevision, setAuthRevision] = useState(0)
  const workspace = server.settings.lastWorkspace ?? server.app.myPc
  const usesClaude = routes.some((route) => route.model.startsWith('claude:'))
  const groups = modelGroups(server)
  const providers = routes.map((route) => fallbackProvider(route.model))
  const available = (model: string) => groups.some((group) => group.models.some((entry) => entry.value === model))
  const valid = routes.every((route, index) => providers[index] && providers.indexOf(providers[index]) === index && available(route.model)
    && workflowEffortSupported(route.effort, workflowLevels(server.catalog, route.model)))
  const stale = JSON.stringify(current) !== JSON.stringify(base)
  const setRoute = (index: number, route: Route) => setRoutes((previous) => previous.map((entry, i) => i === index ? route : entry))
  const move = (index: number, delta: number) => setRoutes((previous) => {
    const next = [...previous], target = index + delta
    if (target < 0 || target >= next.length) return previous
    ;[next[index], next[target]] = [next[target], next[index]]
    return next
  })
  const reload = () => { setBase(copy(current)); setRoutes(copy(current) ?? []) }
  const save = async () => {
    if (saving || stale || !valid || (usesClaude && !auth.ready)) return
    setSaving(true)
    try {
      if (usesClaude && !await act('fallback.confirmClaude', { workspace, confirmation: auth.confirmation })) return
      const result = await act<{ settings: Settings }>('settings.update', { patch: { usageFallbackRoutes: routes, usageFallbackRoutesBase: base } })
      if (result) {
        setBase(copy(result.settings.usageFallbackRoutes ?? null))
        setRoutes(copy(result.settings.usageFallbackRoutes ?? null) ?? [])
        if (usesClaude) { setAuth({ ready: false }); setAuthRevision((value) => value + 1) }
      }
    } finally { setSaving(false) }
  }
  const dirty = JSON.stringify(routes) !== JSON.stringify(base ?? [])
  const status = current === null ? 'モード別の従来設定を使用中' : current.length ? '候補 ' + current.length + ' 件' : '自動切り替えオフ'
  return <section className="account-card fallback-settings">
    <details>
      <summary className="fallback-settings-summary">
        <span><strong>利用上限時の切り替え</strong><small>{status}{stale ? ' · 設定が更新されました' : dirty ? ' · 編集中' : ''}</small></span>
        <span className="muted">設定</span>
      </summary>
      <div className="fallback-settings-body">
        <p className="muted">上から順に、上限になった接続先以外の候補を一度試します。</p>
        {base === null && <p className="team-warning">保存すると、従来のモード別設定の代わりにこの一覧を使います。</p>}
        {!routes.length && <p className="muted">候補がありません。空のまま保存すると自動切り替えはオフになります。</p>}
        {routes.map((route, index) => <div className="fallback-route" key={index}>
          <ModelField label={'優先 ' + (index + 1)} value={route.model} groups={groups} disabled={saving}
            effort={route.effort} efforts={workflowOptions(route.effort, workflowLevels(server.catalog, route.model))} allowClearUnavailableEffort
            onChange={(model) => setRoute(index, { model, effort: workflowEffort('', workflowLevels(server.catalog, model), true) })}
            onEffort={(effort) => setRoute(index, { ...route, effort })} />
          <div className="fallback-route-actions">
            <button type="button" className="icon-button" disabled={saving || index === 0} onClick={() => move(index, -1)} aria-label={'優先 ' + (index + 1) + ' を上へ'} title="上へ">↑</button>
            <button type="button" className="icon-button" disabled={saving || index === routes.length - 1} onClick={() => move(index, 1)} aria-label={'優先 ' + (index + 1) + ' を下へ'} title="下へ">↓</button>
            <button type="button" className="icon-button" disabled={saving} onClick={() => setRoutes((previous) => previous.filter((_, i) => i !== index))} aria-label={'優先 ' + (index + 1) + ' を削除'} title="削除">×</button>
          </div>
          {route.model && !available(route.model) && <p className="team-warning">利用できないモデル: <code>{route.model}</code>。再選択するか削除してください。</p>}
          {providers[index] && providers.indexOf(providers[index]) !== index && <p className="team-warning">同じ接続先は1つだけ選べます。</p>}
        </div>)}
        {usesClaude && <ClaudeAuthConsent key={authRevision} workspace={workspace} fallback onChange={setAuth} />}
        <div className="fallback-settings-actions">
          <button type="button" className="button" disabled={saving || routes.length >= 20} onClick={() => setRoutes((previous) => [...previous, { model: '', effort: '' }])}>候補を追加</button>
          <button type="button" className="button primary" disabled={saving || stale || !valid || (usesClaude && !auth.ready)} onClick={() => void save()}>保存</button>
        </div>
        {stale && <div className="team-warning" role="alert">別の画面で設定が変更されました。編集内容を控えてから読み直してください。 <button type="button" className="button" disabled={saving} onClick={reload}>最新の設定を読み直す</button></div>}
        <details className="fallback-settings-help">
          <summary>切り替えの条件と注意点</summary>
          <p>Claude Code と Claude（API）は別の接続先です。APIには利用料金が発生します。一般的な429や認証エラーでは切り替えません。</p>
          <p>通常タスクからClaude Codeへはフルアクセス時のみ切り替えます。モデルや推論レベルの変更、画像・Plan・ゴールなどを安全に引き継げない場合は停止します。Claude Codeからの切り替え先は読み取り専用で始まります。会話は抜粋で、操作の重複は完全には防げません。</p>
        </details>
      </div>
    </details>
  </section>
}
