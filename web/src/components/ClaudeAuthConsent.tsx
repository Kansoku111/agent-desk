import { useEffect, useState } from 'react'
import { act } from '../store'
import type { ClaudeAuthInspection } from '../types'
import { authConsentState, type AuthConsentState } from '../team-auth-consent'

const MODE_LABEL = {
  subscription: 'Claude サブスクリプション',
  api: 'Anthropic API（従量課金）',
  cloud: 'クラウドプロバイダー（契約先への課金）',
  unknown: '判別できません（従量課金の可能性があります）',
  'logged-out': 'Claude Code にログインしていません',
}
const CLOUD_LABEL: Record<string, string> = { bedrock: 'Amazon Bedrock', vertex: 'Google Cloud Vertex AI', foundry: 'Microsoft Foundry' }

/** Inspects CLI metadata without making a model request; never prechecks consent. */
export function ClaudeAuthConsent({ workspace, teamId, onChange }: {
  workspace: string
  teamId?: string
  onChange: (state: AuthConsentState) => void
}) {
  const [inspection, setInspection] = useState<ClaudeAuthInspection | null>(null)
  const [loading, setLoading] = useState(true)
  const [accepted, setAccepted] = useState(false)
  const [revision, setRevision] = useState(0)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let active = true
    setLoading(true)
    setInspection(null)
    setAccepted(false)
    onChange({ ready: false })
    void act<ClaudeAuthInspection>('team.claudeAuth', { workspace, teamId }).then((result) => {
      if (!active) return
      setInspection(result)
      setExpanded(!result?.confirmed)
      setLoading(false)
      onChange(authConsentState(result))
    })
    return () => { active = false }
  }, [workspace, teamId, revision, onChange])

  const descriptor = inspection?.descriptor
  const unknown = descriptor?.mode === 'unknown'
  const canConfirm = Boolean(inspection?.challenge && descriptor?.mode !== 'logged-out')
  const accept = (checked: boolean) => {
    setAccepted(checked)
    onChange(authConsentState(inspection, checked))
  }
  return (
    <details className="account-card claude-auth-consent" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)} aria-label="Claude Code の課金方式の確認">
      <summary>Claude Code の課金方式<span className="muted">{loading ? '確認中…' : inspection?.confirmed ? '確認済み' : '確認が必要'}</span></summary>
      <div className="claude-auth-consent-body">
      <p className="muted">このチームのリーダー・子が使う Claude Code 自身の認証です。Agent Desk に登録した API キーとは別です。確認ではモデルへの依頼を送りません。</p>
      <p role="status">{loading ? '認証方式を確認しています…' : descriptor ? MODE_LABEL[descriptor.mode] : '確認に失敗しました。再確認してください。'}
        {descriptor?.mode === 'cloud' && CLOUD_LABEL[descriptor.apiProvider] && ` — ${CLOUD_LABEL[descriptor.apiProvider]}`}
      </p>
      {descriptor?.mode === 'logged-out' && <p className="team-warning">ターミナルで Claude Code 自身のログインを完了してから再確認してください。</p>}
      {descriptor && descriptor.mode !== 'logged-out' && (
        <p className="team-warning">API・クラウド経由では利用者の契約先に課金されます。サブスクリプションでも追加利用の設定により課金される場合があります。課金先のアカウントや金額上限はこの確認では保証できません。並列実行・長い会話の費用と、契約先の利用上限を確認してください。</p>
      )}
      {inspection?.confirmed ? <p>この認証方式は確認済みです。同じ方式なら、ほかのチームでも再確認は要りません。</p> : canConfirm && (
        <label>
          <input type="checkbox" checked={accepted} onChange={(event) => accept(event.target.checked)} />{' '}
          {unknown
            ? '課金方式を判別できず、API・クラウド料金が発生する可能性を理解し、この認証方式でのチーム利用を許可します（同じ方式なら次回以降は確認しません）。'
            : '表示された認証方式と課金の可能性を確認し、この認証方式でのチーム利用を許可します（同じ方式なら次回以降は確認しません）。'}
        </label>
      )}
      <p className="muted">起動のたびに認証方式を確認し、変わった場合は再確認が必要です。確認済みでも、同じ方式の別アカウントへの変更は検出できない場合があります。認証や請求先を変えたら再確認してください。実行方式を勝手に切り替えません。</p>
      <button type="button" className="button" disabled={loading} onClick={() => { onChange({ ready: false }); setRevision((value) => value + 1) }}>再確認</button>
      </div>
    </details>
  )
}
