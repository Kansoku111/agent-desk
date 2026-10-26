import { Monitor, Moon, Sun } from 'lucide-react'
import { act, setState, useStore } from '../../store'
import type { PermissionMode, Theme } from '../../types'
import { PERMISSION_INFO } from '../../util'
import { UsageDisplaySettings } from './UsageDisplaySettings'

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
          <h3>ブラウザ操作（Chrome）</h3>
          <p className="muted">専用プロファイルの Chrome をエージェントが操作します。</p>
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