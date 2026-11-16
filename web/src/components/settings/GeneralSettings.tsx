import { Monitor, Moon, Sun } from 'lucide-react'
import { act, setState, useStore } from '../../store'
import type { PermissionMode, Theme } from '../../types'
import { PERMISSION_INFO } from '../../util'
import { UsageDisplaySettings } from './UsageDisplaySettings'

export function GeneralSettings() {
  const settings = useStore((state) => state.server?.settings)
  const platform = useStore((state) => state.server?.app.platform)
  const browserUse = useStore((state) => state.server?.app.browserUse)
  const codeModeConsented = useStore((state) => state.server?.app.codeModeConsented)
  if (!settings) return null
  const update = (patch: Record<string, unknown>) => void act('settings.update', { patch })
  const themes: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: 'dark', label: 'ダーク', icon: Moon },
    { value: 'light', label: 'ライト', icon: Sun },
    { value: 'system', label: 'システム', icon: Monitor },
  ]
  return (
    <div className="settings-section">
      <div className="setting">
        <div>
          <h3>テーマ</h3>
        </div>
        <div className="segmented" role="radiogroup" aria-label="テーマ">
          {themes.map(({ value, label, icon: Icon }) => (
            <button key={value} type="button" role="radio" aria-checked={settings.theme === value} className={settings.theme === value ? 'on' : ''} onClick={() => update({ theme: value })}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </div>
      <UsageDisplaySettings />
      <div className="setting">
        <div>
          <h3>デスクトップ通知</h3>
          <p className="muted">完了と承認待ちを通知します。</p>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.notifications}
            onChange={async (event) => {
              const on = event.target.checked
              if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission()
              update({ notifications: on })
            }}
          />
          <span />
        </label>
      </div>
      <div className="setting">
        <div>
          <h3>ブラウザ操作</h3>
          <p className="muted">専用プロファイルの Chrome をエージェントが操作します。</p>
        </div>
        <label className="switch">
          <input type="checkbox" aria-label="ブラウザ操作" checked={settings.browserTool} onChange={(event) => update({ browserTool: event.target.checked })} />
          <span />
        </label>
      </div>
      {settings.browserTool && (
        <div className="setting">
          <div>
            <h3>ブラウザ操作ツール</h3>
            <p className="muted">実行中の dsh ターンがすべて終わると切り替わります。</p>
            {browserUse && browserUse.status !== 'ready' && (
              <p className="muted" id="browser-use-install">
                {browserUse.status === 'missing' ? 'Browser Use は未導入です。' : 'Browser Use 1.0.0 を確認できません。'}
                <code>{browserUse.installCommand}</code> を実行し、Agent Desk を再起動してください。
              </p>
            )}
          </div>
          <select
            aria-label="ブラウザ操作ツール"
            aria-describedby={browserUse && browserUse.status !== 'ready' ? 'browser-use-install' : undefined}
            value={settings.browserBackend ?? 'chrome'}
            onChange={(event) => update({ browserBackend: event.target.value })}
          >
            <option value="chrome">Chrome DevTools</option>
            <option value="browser-use" disabled={browserUse?.status !== 'ready'}>Browser Use</option>
          </select>
        </div>
      )}
      {settings.browserTool && (
        <div className="setting">
          <div>
            <h3>ブラウザを表示しない</h3>
            <p className="muted">ヘッドレスで動かします。</p>
          </div>
          <label className="switch">
            <input type="checkbox" checked={settings.browserHeadless} onChange={(event) => update({ browserHeadless: event.target.checked })} />
            <span />
          </label>
        </div>
      )}
      {platform === 'win32' && (
        <div className="setting">
          <div>
            <h3>デスクトップ操作</h3>
            <p className="muted">承認なしで実際の画面を操作します。使うときだけオンに。</p>
          </div>
          <label className="switch">
            <input type="checkbox" checked={settings.desktopTool} onChange={(event) => update({ desktopTool: event.target.checked })} />
            <span />
          </label>
        </div>
      )}
      <div className="setting">
        <div>
          <h3>画像生成</h3>
          <p className="muted">ChatGPT の利用枠で描き、generated-images に保存します。</p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={settings.imageTool} onChange={(event) => update({ imageTool: event.target.checked })} />
          <span />
        </label>
      </div>
      <div className="setting">
        <div>
          <h3>会話履歴の検索</h3>
          <p className="muted">AIが過去の会話を検索・参照できます。他のプロジェクトも対象にできます。</p>
        </div>
        <label className="switch">
          <input type="checkbox" aria-label="会話履歴の検索" checked={settings.historyTool === true} onChange={(event) => update({ historyTool: event.target.checked })} />
          <span />
        </label>
      </div>
      <div className="setting">
        <div>
          <h3>変更を戻せるようにする</h3>
          <p className="muted">リクエストごとにファイルを保存します。Git が必要で、.gitignore 対象と 50MB 超は除きます。</p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={settings.checkpoints} onChange={(event) => update({ checkpoints: event.target.checked })} />
          <span />
        </label>
      </div>
      <div className="setting">
        <div>
          <h3>新しいタスクの実行モード</h3>
          <p className="muted">{PERMISSION_INFO[settings.defaultPermissionMode].description}</p>
        </div>
        <select
          value={settings.defaultPermissionMode}
          onChange={(event) => {
            const value = event.target.value as PermissionMode
            update({ defaultPermissionMode: value })
            setState((state) => ({ draft: { ...state.draft, permissionMode: value } }))
          }}
          aria-label="新しいタスクの実行モード"
        >
          {(Object.keys(PERMISSION_INFO) as PermissionMode[]).map((mode) => <option key={mode} value={mode}>{PERMISSION_INFO[mode].label}</option>)}
        </select>
      </div>
      <div className="setting">
        <div>
          <h3>Claude Code の Code Mode（実験）</h3>
          <p className="muted">新しい CL タスクから、ツール呼び出しを JavaScript にまとめて実行します。</p>
          {settings.claudeCodeMode === true && codeModeConsented === false && (
            <p className="muted" id="code-mode-consent">
              Claude Code の同意が未完了のため、通常どおり起動します。<code>CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1</code> を付けて claude を一度起動し、確認画面で Yes を選んでください。
            </p>
          )}
        </div>
        <label className="switch">
          <input
            type="checkbox"
            aria-label="Claude Code の Code Mode"
            aria-describedby={settings.claudeCodeMode === true && codeModeConsented === false ? 'code-mode-consent' : undefined}
            checked={settings.claudeCodeMode === true}
            onChange={(event) => update({ claudeCodeMode: event.target.checked })}
          />
          <span />
        </label>
      </div>
    </div>
  )
}
