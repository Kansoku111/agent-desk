import { useState } from 'react'
import { Check, Copy, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { act, openExternal, toast, useStore } from '../../store'
import type { PermissionMode, UpdateChannel, Updates } from '../../types'
import { copyText, PERMISSION_INFO } from '../../util'
import { dateTime } from './shared'

const UPDATE_CHANNELS: UpdateChannel[] = ['latest', 'next', 'alpha']
/** How long a newly added model shows in the updates card. */
const RECENT_MODELS_MS = 7 * 24 * 60 * 60 * 1000

function Versions({ installed, available }: { installed: string | null; available: string | null }) {
  return (
    <span className="update-versions">
      <code>{installed ?? '—'}</code>
      {available && <> → <code>{available}</code></>}
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
  const [checking, setChecking] = useState(false)
  const busy = checking || updates.checking || models?.phase === 'checking'
  const recent = models?.lastAdded && Date.now() - models.lastAdded.at < RECENT_MODELS_MS ? models.lastAdded : null
  const { dsh, codex, claude } = updates

  const check = async () => {
    setChecking(true)
    await Promise.all([act('updates.check'), act('modelUpdate.check')])
    setChecking(false)
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
        <div className="update-row">
          <span className="update-name">dsh</span>
          <Versions installed={dsh.installed} available={dsh.available} />
          <select
            className="update-channel"
            value={channel}
            onChange={(event) => void act('settings.update', { patch: { dshUpdateChannel: event.target.value } })}
            aria-label="dsh の更新チャネル"
          >
            {UPDATE_CHANNELS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
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
        {models && (models.checkedAt || models.error) && (
          <div className="update-row">
            <span className="update-name">モデル</span>
            <span className="update-versions">{recent ? recent.models.map((model) => model.name).join('、') : ''}</span>
            <span className="update-action">{!models.error && models.checkedAt && <Latest />}</span>
            {models.error && <p className="form-error">{models.error}</p>}
          </div>
        )}
      </div>
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
      <p className="fine-print">
        エージェントの実行は DeepSeek Harness（MIT ライセンス、developer preview）が担います。
        サンドボックスと承認はリスクを減らしますが、完全な隔離は保証されません。重要なリポジトリはブランチやバックアップを用意して使ってください。
      </p>
      <button type="button" className="link-button" onClick={() => openExternal('https://github.com/deepseek-ai/deepseek-harness')}>
        <ExternalLink size={12} /> DeepSeek Harness のリポジトリ
      </button>
    </div>
  )
}