import { type ReactNode, useState } from 'react'
import { Check, Copy, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { act, openExternal, toast, useStore } from '../../store'
import type { PermissionMode, UpdateChannel, Updates } from '../../types'
import { copyText, PERMISSION_INFO } from '../../util'
import { dateTime } from './shared'

const UPDATE_CHANNELS: UpdateChannel[] = ['latest', 'next', 'alpha']
/** How long a newly added model shows in the updates card. */
const RECENT_MODELS_MS = 7 * 24 * 60 * 60 * 1000

function Versions({ installed, available, url, children }: { installed: string | null; available: string | null; url?: string | null; children?: ReactNode }) {
  return (
    <span className="update-versions">
      <code>{installed ?? '—'}</code>
      {available && (url
        ? <button type="button" className="link-button" onClick={() => openExternal(url)} title="リリースノート"><code>→ {available}</code></button>
        : <code>→ {available}</code>)}
      {children}
    </span>
  )
}

function Latest() {
  return <Check size={15} className="update-ok" aria-label="最新" />
}

function CopyPrompt({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await copyText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast('コピーできませんでした', 'error')
    }
  }
  return (
    <button type="button" className="button" onClick={() => void copy()} title={prompt}>
      {copied ? <Check size={14} /> : <Copy size={14} />} 指示をコピー
    </button>
  )
}

/** dsh, the bundled Codex, Claude Code and the model list: one place to see what is new. */
function UpdatesCard({ updates }: { updates: Updates }) {
  const channel = useStore((state) => state.server?.settings.dshUpdateChannel)
  const models = useStore((state) => state.server?.modelUpdate)
  const autoSync = useStore((state) => state.server?.settings.modelAutoUpdate) !== false
  const signedIn = useStore((state) => state.server?.accounts.chatgpt.signedIn)
  const [checking, setChecking] = useState(false)
  const busy = checking || updates.checking || models?.phase === 'checking'
  const recent = models?.lastAdded && Date.now() - models.lastAdded.at < RECENT_MODELS_MS ? models.lastAdded : null
  const { dsh, codex, claude, app } = updates

  const check = async () => {
    setChecking(true)
    try {
      await Promise.all([act('updates.check'), act('modelUpdate.check')])
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="account-card">
      <div className="account-head">
        <h3>更新</h3>
        <button type="button" className="icon-button small" disabled={busy} onClick={() => void check()} aria-label="今すぐ確認">
          {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      <div className="update-list">
        {app && (
          <div className="update-row">
            <span className="update-name">Agent Desk</span>
            <Versions installed={app.installed} available={app.available} url={app.url} />
            <span className="update-action">
              {app.available && app.method
                ? (
                  <button type="button" className="button" disabled={app.phase !== 'idle'} onClick={() => void act('updates.installApp')}>
                    {app.phase === 'idle' ? <Download size={14} /> : <Loader2 size={14} className="spin" />} 更新
                  </button>
                )
                : !app.available && updates.checkedAt && !app.error && <Latest />}
            </span>
            {app.error && <p className="form-error">{app.error}</p>}
          </div>
        )}
        <div className="update-row">
          <span className="update-name">dsh</span>
          <Versions installed={dsh.installed} available={dsh.available}>
            <select
              className="update-channel"
              value={channel}
              onChange={(event) => void act('settings.update', { patch: { dshUpdateChannel: event.target.value } })}
              aria-label="dsh の更新チャネル"
            >
              {UPDATE_CHANNELS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </Versions>
          <span className="update-action">{dsh.prompt ? <CopyPrompt prompt={dsh.prompt} /> : !dsh.available && updates.checkedAt && !dsh.error && <Latest />}</span>
          {dsh.error && <p className="form-error">{dsh.error}</p>}
        </div>
        <div className="update-row">
          <span className="update-name">Codex</span>
          <Versions installed={codex.installed} available={codex.available} />
          <span className="update-action">{codex.prompt ? <CopyPrompt prompt={codex.prompt} /> : !codex.available && updates.checkedAt && !codex.error && <Latest />}</span>
          {codex.error && <p className="form-error">{codex.error}</p>}
        </div>
        {(claude.installed || claude.error) && (
          <div className="update-row">
            <span className="update-name">Claude Code</span>
            <Versions installed={claude.installed} available={claude.available} />
            <span className="update-action">
              {claude.available
                ? (
                  <button type="button" className="button" disabled={claude.updating} onClick={() => void act('updates.updateClaude')}>
                    {claude.updating ? <Loader2 size={14} className="spin" /> : <Download size={14} />} 更新
                  </button>
                )
                : !claude.error && <Latest />}
            </span>
            {claude.error && <p className="form-error">{claude.error}</p>}
          </div>
        )}
        {models && (
          <div className="update-row">
            <span className="update-name">モデル</span>
            <span className="update-versions">
              {models.phase === 'checking' ? '確認中…' : recent ? recent.models.map((model) => model.name).join('、') : models.checkedAt ? '' : '未確認'}
            </span>
            <span className="update-action">{!busy && !models.error && models.account?.status !== 'error' && !models.opencodeGo?.error && models.checkedAt && <Latest />}</span>
            {models.error && <p className="form-error">{models.error}</p>}
            {autoSync && signedIn && models.account?.status === 'error' && (
              <p className="form-error">ChatGPT のモデル一覧を読み込めませんでした（前回の結果を使っています）</p>
            )}
            {models.opencodeGo?.error && (
              <p className="form-error">OpenCode Go のモデル一覧を読み込めませんでした（前回の結果を使っています）</p>
            )}
          </div>
        )}
      </div>
      {models && (
        <>
          <div className="setting compact">
            <div>
              <h3>モデル一覧を自動で同期する</h3>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={autoSync}
                onChange={(event) => void act('settings.update', { patch: { modelAutoUpdate: event.target.checked } })}
                aria-label="モデル一覧を自動で同期する"
              />
              <span />
            </label>
          </div>
          <details className="model-sync-details">
            <summary>同期の詳細</summary>
            <p className="muted">GPT はアカウントの一覧に、OpenCode Go はサービスの一覧に、Claude などは pi-ai の最新版に合わせます。</p>
            <p className="muted">
              モデル定義: {models.source ? <code>pi-ai {models.source}</code> : '同梱のもの'}
              {models.latest && models.source && models.latest !== models.source && <> （最新: <code>{models.latest}</code>）</>}
            </p>
            {autoSync && (
              <p className="muted">
                ChatGPT アカウントの一覧:{' '}
                {!signedIn || models.account?.status === 'signed-out'
                  ? 'ChatGPT にサインインすると照合できます'
                  : models.account?.status === 'error'
                    ? '読み込めませんでした（前回の結果を使っています）'
                    : models.account?.checkedAt ? `照合済み（${dateTime(models.account.checkedAt)}）` : '未確認'}
              </p>
            )}
            {autoSync && models.account?.retired.length > 0 && (
              <p className="muted">提供終了の可能性: {models.account.retired.map((model) => model.name).join('、')}</p>
            )}
            {models.opencodeGo && (
              <p className="muted">
                OpenCode Go の一覧: {models.opencodeGo.error
                  ? '読み込めませんでした（前回の結果を使っています）'
                  : models.opencodeGo.checkedAt ? `照合済み（${dateTime(models.opencodeGo.checkedAt)}）` : '未確認'}
                {models.opencodeGo.hidden.length > 0 && <>　非表示: {models.opencodeGo.hidden.map((model) => model.name).join('、')}</>}
              </p>
            )}
            {models.models.length > 0 && (
              <ul className="custom-models">
                {models.models.map((model) => (
                  <li key={`${model.provider}/${model.id}`}>
                    <div>
                      <span>{model.name}</span>
                      <code>{model.provider} · {model.id} · {({ fetched: '自動取得', bundled: '同梱', account: 'ChatGPT アカウントの一覧' })[model.source]}</code>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="fine-print">
              {models.checkedAt ? `モデルの最終確認: ${dateTime(models.checkedAt)}。` : ''}
              {models.lastAdded ? `前回追加: ${models.lastAdded.models.map((model) => model.name).join('、')}（${dateTime(models.lastAdded.at)}）。` : ''}
            </p>
          </details>
        </>
      )}
      {updates.checkedAt && <p className="fine-print">{dateTime(updates.checkedAt)}</p>}
    </section>
  )
}

export function AboutSettings() {
  const server = useStore((state) => state.server)
  if (!server) return null
  const states: Record<string, string> = { stopped: '停止', starting: '起動中', ready: '稼働中', failed: '失敗' }
  return (
    <div className="settings-section">
      {server.updates && <UpdatesCard updates={server.updates} />}
      <dl className="about">
        <dt>Agent Desk</dt><dd>{server.app.version}</dd>
        <dt>データフォルダ</dt><dd><code>{server.app.dataDir}</code></dd>
        {(Object.keys(server.runtime) as PermissionMode[]).map((mode) => (
          <div key={mode} className="about-row">
            <dt>実行環境（{PERMISSION_INFO[mode].label}）</dt><dd>{states[server.runtime[mode]] ?? server.runtime[mode]}</dd>
          </div>
        ))}
      </dl>
      <p className="fine-print">サンドボックスは完全な隔離ではありません。重要なリポジトリはバックアップを。</p>
      <button type="button" className="link-button" onClick={() => openExternal('https://github.com/deepseek-ai/deepseek-harness')}>
        <ExternalLink size={12} /> DeepSeek Harness のリポジトリ
      </button>
    </div>
  )
}