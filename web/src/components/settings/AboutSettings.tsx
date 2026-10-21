import { useState } from 'react'
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { act, openExternal, toast, useStore } from '../../store'
import type { DshUpdate, PermissionMode, UpdateChannel } from '../../types'
import { PERMISSION_INFO, UPDATE_PHASE_LABEL, updateRunning } from '../../util'
import { dateTime } from './shared'

const UPDATE_CHANNELS: { value: UpdateChannel; label: string }[] = [
  { value: 'latest', label: '標準（latest）' },
  { value: 'next', label: '次期リリース候補（next）' },
  { value: 'alpha', label: 'アルファ版（alpha）' },
]

/** Checking for and installing dsh releases. */
function DshUpdateCard({ update }: { update: DshUpdate }) {
  const settings = useStore((state) => state.server?.settings)
  const dataDir = useStore((state) => state.server?.app.dataDir)
  const [checking, setChecking] = useState(false)
  const [recovering, setRecovering] = useState(false)
  if (!settings) return null
  const running = updateRunning(update)
  const recoveryRequired = update.phase === 'recovery-required'
  const recover = async () => {
    setRecovering(true)
    try {
      await act('dshUpdate.recover')
    } finally {
      setRecovering(false)
    }
  }
  const failedReason = update.available ? update.failed[update.available] : undefined
  const result = update.lastResult

  const check = async () => {
    setChecking(true)
    const response = await act<{ update: DshUpdate }>('dshUpdate.check')
    setChecking(false)
    if (response?.update.phase === 'idle' && !response.update.error) toast(`dsh ${response.update.installed} は最新です`, 'success')
  }
  const save = (patch: Record<string, unknown>) => void act('settings.update', { patch })

  return (
    <section className="account-card">
      <div className="account-head">
        <div>
          <h3>dsh のアップデート</h3>
          <p className="muted">
            新しいリリースを数時間ごとに確認します。更新では、作業中のタスクが終わるのを待ってから dsh を入れ替え、
            必須の互換性と起動・モデル選択を確かめたうえで切り替えます。失敗時は元に戻し、復旧が完了しなければ実行を停止します。
          </p>
        </div>
        {update.phase === 'available' && <span className="badge update">新しい版</span>}
        {update.phase === 'idle' && update.checkedAt && !update.error && <span className="badge success"><CheckCircle2 size={12} /> 最新</span>}
      </div>

      <div className="account-row">
        <span>
          <code>{update.installed}</code>
          {update.available && <> → <code>{update.available}</code></>}
        </span>
        {update.phase === 'available' && update.available && (
          <button type="button" className="button primary" onClick={() => void act('dshUpdate.apply', { version: update.available })}>
            <Download size={14} /> {failedReason ? 'もう一度試す' : '更新する'}
          </button>
        )}
        {update.phase === 'waiting' && (
          <button type="button" className="button" onClick={() => void act('dshUpdate.cancel')}>更新を取りやめる</button>
        )}
        {(update.phase === 'idle' || update.phase === 'checking') && (
          <button type="button" className="button" disabled={checking || update.phase === 'checking'} onClick={() => void check()}>
            {checking || update.phase === 'checking' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 今すぐ確認
          </button>
        )}
      </div>

      {((running && !recoveryRequired) || update.phase === 'waiting') && (
        <p className="login-status">
          <Loader2 size={14} className="spin" /> {UPDATE_PHASE_LABEL[update.phase]}…
          {update.phase === 'waiting' && ' 終わりしだい更新を始めます。'}
        </p>
      )}
      {failedReason && update.phase === 'available' && (
        <p className="form-warning">このバージョンは以前、更新に失敗して元に戻しました（{failedReason}）。</p>
      )}
      {update.error && <p className="form-error">{update.error}</p>}
      {recoveryRequired && (
        <div role="alert">
          <p className="form-warning">{UPDATE_PHASE_LABEL[update.phase]}。アプリを開き直しても解除されません。</p>
          <ol className="fine-print">
            <li>下記のバックアップは削除しないでください。ネットワークとディスクの空き容量・書き込み権限を確認してください。</li>
            <li>「復旧を再試行」で保存済みの package.json / package-lock.json から npm ci を実行し、未復旧の dsh データを戻します。</li>
            <li>両方の復旧と状態保存が成功した場合だけ、タスクの実行を再開します。繰り返し失敗する場合は表示されたエラーを解消してから再試行してください。</li>
            <li>アプリ自体が起動できない場合の手順は、バックアップ内の <code>RECOVERY.md</code> に保存されています。状態記録を削除して停止を解除しないでください。</li>
          </ol>
          {update.recovery && <p className="fine-print">パッケージ: {update.recovery.packages ? '復旧待ち' : '復旧済み'} / データ: {update.recovery.home ? '復旧待ち' : '復旧済み'}</p>}
          <button type="button" className="button primary" disabled={recovering} onClick={() => void recover()}>
            <RefreshCw size={14} className={recovering ? 'spin' : undefined} /> 復旧を再試行
          </button>
        </div>
      )}

      <div className="setting compact">
        <div>
          <h3>更新チャネル</h3>
          <p className="muted">dsh の npm 配布タグです。latest 以外は試験的なリリースで、動作が不安定なことがあります。</p>
        </div>
        <select
          value={settings.dshUpdateChannel}
          disabled={running}
          onChange={(event) => save({ dshUpdateChannel: event.target.value })}
          aria-label="dsh の更新チャネル"
        >
          {UPDATE_CHANNELS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </select>
      </div>
      <div className="setting compact">
        <div>
          <h3>自動で更新する</h3>
          <p className="muted">新しいリリースを見つけたら、確認なしで更新します。更新に失敗したバージョンは自動では入れ直しません。</p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={settings.dshAutoUpdate} onChange={(event) => save({ dshAutoUpdate: event.target.checked })} />
          <span />
        </label>
      </div>

      <p className="fine-print">
        {update.checkedAt ? `最終確認: ${dateTime(update.checkedAt)}。` : ''}
        {result?.ok ? `前回の更新: ${result.from} → ${result.to}（${dateTime(result.at)}）。` : ''}
        更新前の package.json と dsh のデータは <code>{`${dataDir}${dataDir?.includes('\\') ? '\\' : '/'}dsh-update-backup`}</code> に保存されます。
      </p>
    </section>
  )
}

export function AboutSettings() {
  const server = useStore((state) => state.server)
  if (!server) return null
  const states: Record<string, string> = { stopped: '停止', starting: '起動中', ready: '稼働中', failed: '失敗' }
  return (
    <div className="settings-section">
      {server.dshUpdate && <DshUpdateCard update={server.dshUpdate} />}
      <dl className="about">
        <dt>Agent Desk</dt><dd>{server.app.version}</dd>
        <dt>DeepSeek Harness (dsh)</dt><dd>{server.app.dshVersion}</dd>
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