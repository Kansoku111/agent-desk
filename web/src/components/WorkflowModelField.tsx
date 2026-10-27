import { ChevronDown } from 'lucide-react'
import type { AppState } from '../types'
import { providerReady, visibleModels } from '../model-selection'
import { effortLabel } from '../util'
import { byNewest, PROVIDER_NOTE, PROVIDER_ORDER } from './Pickers'
import { Dropdown, MenuDivider, MenuHeading, MenuItem } from './Popover'
import { useWheelSelect } from './useWheelSelect'

export const CLAUDE_CODE = [{ value: 'claude:opus', name: 'Opus' }, { value: 'claude:sonnet', name: 'Sonnet' }, { value: 'claude:haiku', name: 'Haiku' }]

interface ModelGroup { id: string; heading: string; note: string; models: { value: string; name: string }[] }

/** The models a field offers, grouped and named as in the composer's model menu. */
export function modelGroups(server: AppState): ModelGroup[] {
  const byProvider = new Map<string, { value: string; name: string; id: string }[]>()
  for (const model of visibleModels(server)) {
    if (model.retired || !providerReady(server, model.provider)) continue
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
  }
  const order = [...new Set([...PROVIDER_ORDER, ...byProvider.keys()])].filter((provider) => byProvider.has(provider))
  return [
    { id: 'claude-code', heading: 'Claude Code', note: '', models: CLAUDE_CODE },
    ...order.map((provider) => ({
      id: provider, heading: server.catalog.providers[provider] ?? provider, note: PROVIDER_NOTE[provider] ?? '',
      models: byProvider.get(provider)!.sort(byNewest),
    })),
  ]
}

export function ModelField({ label, value, groups, disabled, onChange, effort, efforts, onEffort, allowClearUnavailableEffort = false }: {
  label: string; value: string; groups: ModelGroup[]; disabled: boolean; onChange: (value: string) => void
  effort: string; efforts: string[]; onEffort: (value: string) => void; allowClearUnavailableEffort?: boolean
}) {
  const clearUnavailableEffort = allowClearUnavailableEffort && !efforts.length && Boolean(effort)
  const effortChoices = clearUnavailableEffort ? [''] : efforts
  const effortName = clearUnavailableEffort ? `${effortLabel(effort)}（非対応）` : !efforts.length ? '指定不可' : effort ? `${effortLabel(effort)}${efforts.includes(effort) ? '' : '（非対応）'}` : '中'
  const name = groups.flatMap((group) => group.models).find((model) => model.value === value)?.name ?? 'モデルを選択'
  const modelWheel = useWheelSelect<HTMLButtonElement>(disabled ? [] : groups.flatMap((group) => group.models.map((model) => model.value)), value, onChange)
  const effortWheel = useWheelSelect<HTMLButtonElement>(disabled || !value ? [] : effortChoices, effortChoices.includes(effort) ? effort : null, onEffort)
  const wheelName = groups.flatMap((group) => group.models).find((model) => model.value === modelWheel.shown)?.name ?? name
  const shownEffort = effortWheel.pending && effortWheel.shown ? effortLabel(effortWheel.shown) : effortName
  return <div className="ab-field">
    <span>{label}</span>
    <div className="ab-model-controls"><Dropdown
      placement="bottom"
      portal
      width={300}
      trigger={({ toggle, open }) => (
        <button ref={modelWheel.ref} type="button" className={`ab-picker ${open ? 'active' : ''} ${modelWheel.pending ? 'wheeling' : ''}`} aria-label={`${label}: ${name}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={toggle}>
          <span>{wheelName}</span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <div className="menu-scroll">
          {groups.map((group, index) => (
            <div key={group.id}>
              {index > 0 && <MenuDivider />}
              <MenuHeading>{group.heading}<span className="menu-heading-note">{group.note}</span></MenuHeading>
              {group.models.map((model) => (
                <MenuItem key={model.value} label={model.name} selected={model.value === value} onSelect={() => { onChange(model.value); close() }} />
              ))}
            </div>
          ))}
        </div>
      )}
    </Dropdown>
    <Dropdown portal width={160} className="ab-effort-menu" trigger={({ toggle, open }) => (
      <button ref={effortWheel.ref} type="button" className={`ab-effort ${effortWheel.pending ? 'wheeling' : ''}`} aria-label={`${label}の推論レベル: ${effortName}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled || !value || !effortChoices.length} onClick={toggle}>
        <span>{shownEffort}</span><ChevronDown size={12} />
      </button>
    )}>
      {(close) => <>
        {clearUnavailableEffort && <MenuItem key="none" label="指定なし" selected={!effort} onSelect={() => { onEffort(''); close() }} />}
        {efforts.map((value) => <MenuItem key={value} label={effortLabel(value)} selected={effort === value} onSelect={() => { onEffort(value); close() }} />)}
      </>}
    </Dropdown></div>
  </div>
}
