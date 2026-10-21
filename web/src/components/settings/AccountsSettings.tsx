import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, KeyRound, Loader2 } from 'lucide-react'
import { act, openExternal, request, toast, useStore } from '../../store'
import { ChatGptConnections } from './ChatGptConnections'

function ChatGptCard() { return <ChatGptConnections /> }

type WorkspaceOption = { id: string; name: string }
type KeyCheck = { status: string; httpStatus?: number; workspaces?: WorkspaceOption[] | null }

/** Picks the workspace an unscoped Claude personal or service account key acts in. */
function ClaudeWorkspace({ current, choices, onDone }: {
  current: string | null
  choices: WorkspaceOption[] | null
  onDone: () => void
}) {
  const [value, setValue] = useState(current ?? choices?.[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const apply = async (workspaceId: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await request('account.setWorkspace', { workspaceId })
      toast(workspaceId ? 'ワークスペースを設定しました' : 'ワークスペースの指定を解除しました', 'success')
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setBusy(false)
  }
  return (
    <div className="workspace-field">
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          void apply(value.trim())
        }}
      >
        {choices?.length
          ? (
            <select value={value} onChange={(event) => setValue(event.target.value)} aria-label="Claude のワークスペース">
              {choices.map((option) => (
                <option key={option.id} value={option.id}>{option.name === option.id ? option.id : `${option.name}（${option.id}）`}</option>
              ))}
            </select>
          )
          : (
            <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="wrkspc_…" aria-label="Claude のワークスペース ID" />
          )}
        <button type="submit" className="button primary" disabled={!value.trim() || busy}>
          {busy && <Loader2 size={14} className="spin" />} 設定
        </button>
        {current && <button type="button" className="button ghost" disabled={busy} onClick={() => void apply(null)}>解除</button>}
      </form>
      {error && <p className="form-error">{error}</p>}
      {!choices?.length && (
        <p className="fine-print">
          ワークスペース ID は Claude Console の「Settings → Workspaces」の ID 列で確認できます（既定のワークスペースも含みます）。
        </p>
      )}
    </div>
  )
}

function ApiKeyCard({ provider, title, description, consoleUrl, placeholder, hint }: {
  provider: 'anthropic' | 'deepseek'
  title: string
  description: string
  consoleUrl: string
  placeholder: string
  hint?: string
}) {
  const account = useStore((state) => (provider === 'anthropic' ? state.server?.accounts.claude : state.server?.accounts.deepseek))
  const workspaceId = useStore((state) => state.server?.accounts.claude.workspaceId ?? null)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  // undefined: no picker; null: picker with a typed id; array: picker with choices.
  const [workspaceChoices, setWorkspaceChoices] = useState<WorkspaceOption[] | null | undefined>(undefined)
  const looksLikeKeyId = provider === 'anthropic' && /^\s*apikey_/i.test(key)
  const [verified, setVerified] = useState<string | null>(null)
  const [verifyTick, setVerifyTick] = useState(0)

  // Check the saved Claude key whenever the screen opens or its workspace changes.
  useEffect(() => {
    if (provider !== 'anthropic' || !account?.configured) return
    let live = true
    setVerified('checking')
    request<{ check: KeyCheck | null }>('account.verify', { provider })
      .then(({ check }) => {
        if (!live || !check) return
        setVerified(check.status)
        if (check.status === 'needs-workspace') setWorkspaceChoices(check.workspaces ?? null)
      })
      .catch(() => live && setVerified(null))
    return () => {
      live = false
    }
  }, [provider, account?.configured, account?.masked, workspaceId, verifyTick])

  const save = async (force = false) => {
    setSaving(true)
    setError(null)
    setWarning(null)
    setWorkspaceChoices(undefined)
    try {
      const result = await request<{ check: KeyCheck }>('account.setKey', { provider, key, force })
      setKey('')
      if (result.check.status === 'needs-workspace') {
        setWorkspaceChoices(result.check.workspaces ?? null)
        setWarning('キーを保存しました。このキーはワークスペースを限定しない個人キーのため、使うワークスペースを選んでください。')
      } else if (result.check.status === 'valid') toast(`${title} の API キーを保存しました`, 'success')
      else if (result.check.status === 'unreachable') setWarning('キーは保存しましたが、確認のための接続ができませんでした。ネットワークを確認してください。')
      else if (result.check.status === 'unknown') setWarning(`キーは保存しましたが、確認で予期しない応答（${result.check.httpStatus}）がありました。`)
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
          <p className="muted">{description}</p>
        </div>
        {account?.configured && <span className="badge success"><CheckCircle2 size={12} /> 設定済み</span>}
      </div>
      {account?.configured && (
        <div className="account-row">
          <code className="masked">{account.masked}</code>
          <button type="button" className="button" onClick={() => void act('account.removeKey', { provider })}>削除</button>
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
          placeholder={account?.configured ? '新しいキーで置き換える' : placeholder}
          aria-label={`${title} の API キー`}
        />
        <button type="submit" className="button primary" disabled={!key.trim() || saving || looksLikeKeyId}>
          {saving ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} 保存
        </button>
      </form>
      {looksLikeKeyId && (
        <p className="form-warning">
          「apikey_…」は Claude Console の一覧に表示されるキーの ID で、キー本体ではありません。
          キーを作成したときに一度だけ表示される「sk-ant-api…」を貼り付けてください。
        </p>
      )}
      {hint && !looksLikeKeyId && <p className="fine-print">{hint}</p>}
      {error && (
        <p className="form-error">
          {error}{' '}
          {/認証に失敗/.test(error) && <button type="button" className="link-button" onClick={() => void save(true)}>それでも保存する</button>}
        </p>
      )}
      {warning && <p className="form-warning">{warning}</p>}
      {provider === 'anthropic' && account?.configured && verified && (
        <p className={verified === 'valid' ? 'form-ok' : verified === 'checking' ? 'fine-print' : 'form-warning'}>
          {{
            checking: '接続を確認しています…',
            valid: '✓ このキーで Claude を使えます。',
            'needs-workspace': 'このキーはワークスペースを限定しない個人キーです。下の「ワークスペース」で、使うワークスペースの ID を設定してください。',
            'workspace-invalid': '設定したワークスペース ID が見つからないか、このキーで使う権限がありません。',
            invalid: 'このキーは認証に失敗しました。新しいキーを登録してください。',
            unreachable: 'Anthropic に接続できませんでした。ネットワークを確認してください。',
          }[verified] ?? `確認で予期しない応答がありました（${verified}）。`}
        </p>
      )}
      {provider === 'anthropic' && account?.configured && (
        <div className="account-subsection">
          <h4>ワークスペース{workspaceId ? '' : '（必要なキーのみ）'}</h4>
          <ClaudeWorkspace
            key={workspaceId ?? 'none'}
            current={workspaceId}
            choices={workspaceChoices ?? null}
            onDone={() => {
              setWorkspaceChoices(undefined)
              setWarning(null)
              setVerifyTick((tick) => tick + 1)
            }}
          />
          <button type="button" className="link-button" onClick={() => openExternal('https://platform.claude.com/settings/workspaces')}>
            <ExternalLink size={12} /> Claude Console でワークスペース ID を確認する
          </button>
        </div>
      )}
      <button type="button" className="link-button" onClick={() => openExternal(consoleUrl)}>
        <ExternalLink size={12} /> API キーを発行する
      </button>
    </section>
  )
}
export function AccountsSettings() {
  return (
    <div className="settings-section">
      <ChatGptCard />
      <ApiKeyCard
        provider="anthropic"
        title="Claude"
        description="Anthropic の API キーで Claude モデルを使います（従量課金）。"
        consoleUrl="https://platform.claude.com/settings/keys"
        placeholder="sk-ant-api…"
        hint="Claude Console でキーを作成したときに一度だけ表示される「sk-ant-api…」で始まる文字列を貼り付けます。"
      />
      <ApiKeyCard
        provider="deepseek"
        title="DeepSeek（任意）"
        description="DeepSeek の API キーで DeepSeek モデルも使えます。"
        consoleUrl="https://platform.deepseek.com/api_keys"
        placeholder="sk-…"
      />
    </div>
  )
}