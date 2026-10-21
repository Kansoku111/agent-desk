import { setState, type SettingsTab } from '../store'
import { Modal } from './Modal'
import { RemotePanel } from './RemotePanel'
import { TeamSettings } from './TeamSettings'
import { UsagePanel } from './UsagePanel'
import { AboutSettings } from './settings/AboutSettings'
import { AccountsSettings } from './settings/AccountsSettings'
import { GeneralSettings } from './settings/GeneralSettings'
import { ModelsSettings } from './settings/ModelsSettings'
import { PersonalizeSettings } from './settings/PersonalizeSettings'

const CONTEXT_OPTIONS = [1_000_000, 500_000, 400_000, 272_000, 200_000, 128_000, 64_000]

export function SettingsDialog({ tab }: { tab: SettingsTab }) {
  const close = () => setState({ settingsOpen: null })
  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'accounts', label: 'アカウント' },
    { id: 'models', label: 'モデル' },
    { id: 'teams', label: 'エージェントチーム' },
    { id: 'personalize', label: 'パーソナライズ' },
    { id: 'usage', label: '使用量' },
    { id: 'general', label: '一般' },
    { id: 'remote', label: 'スマホ' },
    { id: 'about', label: '情報' },
  ]
  return (
    <Modal title="設定" onClose={close} width={640} className="settings-modal">
      <div className="settings-layout">
        <nav className="settings-tabs" role="tablist">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? 'on' : ''}
              onClick={() => setState({ settingsOpen: entry.id })}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === 'accounts' && <AccountsSettings />}
          {tab === 'models' && <ModelsSettings contextOptions={CONTEXT_OPTIONS} />}
          {tab === 'teams' && <TeamSettings />}
          {tab === 'personalize' && <PersonalizeSettings />}
          {tab === 'usage' && <UsagePanel />}
          {tab === 'general' && <GeneralSettings />}
          {tab === 'remote' && <RemotePanel />}
          {tab === 'about' && <AboutSettings />}
        </div>
      </div>
    </Modal>
  )
}
