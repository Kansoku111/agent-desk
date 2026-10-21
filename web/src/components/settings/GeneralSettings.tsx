import { Monitor, Moon, Sun } from 'lucide-react'
import { act, setState, useStore } from '../../store'
import type { PermissionMode, Theme } from '../../types'
import { PERMISSION_INFO } from '../../util'

export function GeneralSettings() {
  const settings = useStore((state) => state.server?.settings)
  const platform = useStore((state) => state.server?.app.platform)
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
      <div className="setting">
        <div>
          <h3>デスクトップ通知</h3>
          <p className="muted">ウィンドウが裏にあるとき、作業の完了や承認待ちを通知します。</p>
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
          <h3>ブラウザ操作（Chrome）</h3>
          <p className="muted">
            エージェントが Chrome を操作できるようにします（ページを開く、読む、クリック、入力、スクリーンショット）。
            Agent Desk 専用のプロファイルで起動するので、普段の Chrome とは別にサインイン状態が保存されます。
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={settings.browserTool} onChange={(event) => update({ browserTool: event.target.checked })} />
          <span />
        </label>
      </div>
      {settings.browserTool && (
        <div className="setting">
          <div>
            <h3>ブラウザを表示しない</h3>
            <p className="muted">オンにすると Chrome をウィンドウなし（ヘッドレス）で動かします。オフなら操作の様子を見られます。</p>
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
            <p className="muted">
              エージェントが画面のスクリーンショットを撮り、マウスとキーボードで PC 上のアプリを操作できるようにします。
              権限モードに関係なく、承認なしで実際の画面を操作します。使うときだけオンにしてください。
            </p>
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
          <p className="muted">
            エージェントが画像を作れるようにします。描くのは ChatGPT サブスクリプションの GPT で、Claude のタスクからも使えます。
            画像はワークスペースの generated-images フォルダに保存されます。ChatGPT の利用上限を使い、Claude の API 料金はかかりません。
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={settings.imageTool} onChange={(event) => update({ imageTool: event.target.checked })} />
          <span />
        </label>
      </div>
      <div className="setting">
        <div>
          <h3>変更を戻せるようにする</h3>
          <p className="muted">
            リクエストを送る前と作業のあとにワークスペースのファイルを保存し、「このリクエストの前に戻す」で元に戻せるようにします。
            保存先はデータフォルダで、Git が必要です。.gitignore で除外したファイル、node_modules などの依存パッケージ、50MB を超えるファイルは対象外です。
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={settings.checkpoints} onChange={(event) => update({ checkpoints: event.target.checked })} />
          <span />
        </label>
      </div>
      <div className="setting">
        <div>
          <h3>新しいタスクの権限</h3>
          <p className="muted">{PERMISSION_INFO[settings.defaultPermissionMode].description}</p>
        </div>
        <select
          value={settings.defaultPermissionMode}
          onChange={(event) => {
            const value = event.target.value as PermissionMode
            update({ defaultPermissionMode: value })
            setState((state) => ({ draft: { ...state.draft, permissionMode: value } }))
          }}
          aria-label="新しいタスクの権限"
        >
          {(Object.keys(PERMISSION_INFO) as PermissionMode[]).map((mode) => <option key={mode} value={mode}>{PERMISSION_INFO[mode].label}</option>)}
        </select>
      </div>
    </div>
  )
}