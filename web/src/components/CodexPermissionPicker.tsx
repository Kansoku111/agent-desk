import { ChevronDown, Shield, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { CodexTaskSummary } from '../types'
import { Dropdown, MenuHeading, MenuItem } from './Popover'

type PermissionMode = CodexTaskSummary['permissionMode']

const MODES = {
  'read-only': { label: '読み取りのみ', Icon: Shield },
  'workspace-write': { label: 'ワークスペース編集', Icon: ShieldCheck },
  'danger-full-access': { label: 'フルアクセス', Icon: ShieldAlert },
}

export function CodexPermissionPicker({ value, disabled, onChange }: {
  value: PermissionMode
  disabled: boolean
  onChange: (value: PermissionMode) => void
}) {
  const { label, Icon } = MODES[value]
  return <Dropdown width={240} portal trigger={({ open, toggle }) => (
    <button type="button" className={`chip ${open ? 'active' : ''} ${value === 'danger-full-access' ? 'warn' : ''}`}
      aria-label={`権限: ${label}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
      title={disabled ? '作業中・チームの担当はここでは変更できません' : '権限'} onClick={toggle}>
      <Icon size={13} /><span>{label}</span><ChevronDown size={13} />
    </button>
  )}>{(close) => <>
    <MenuHeading>権限</MenuHeading>
    {(Object.keys(MODES) as PermissionMode[]).map((mode) => {
      const { label, Icon } = MODES[mode]
      return <MenuItem key={mode} icon={<Icon size={15} />} label={label} selected={mode === value}
        danger={mode === 'danger-full-access'} disabled={disabled} onSelect={() => {
          if (disabled) return
          onChange(mode)
          close()
        }} />
    })}
  </>}</Dropdown>
}
