import { useMemo } from 'react'
import {
  Brain, ChevronDown, FolderOpen, FolderPlus, KeyRound, Monitor, Shield, ShieldAlert, ShieldCheck, X, Zap,
} from 'lucide-react'
import { act, setState, useStore } from '../store'
import type { AppState, CatalogModel, FastProvider, PermissionMode } from '../types'
import { providerReady, visibleModels } from '../model-selection'
export { pickDefaultModel, providerReady } from '../model-selection'
import { basename, effortLabel, fastNote, nearestEffort, parseModel, PERMISSION_INFO, pickableEfforts, workspaceLabel } from '../util'
import { Dropdown, MenuDivider, MenuHeading, MenuItem } from './Popover'
import { openProjectDialog } from './ProjectDialog'
import { useWheelSelect } from './useWheelSelect'

const PROVIDER_ORDER = ['openai-codex', 'anthropic', 'deepseek-official', 'local-llm']
const PROVIDER_NOTE: Record<string, string> = {
  'openai-codex': 'ChatGPT サブスクリプション',
  anthropic: 'Anthropic API キー',
  'deepseek-official': 'DeepSeek API キー',
  'local-llm': 'このネットワークのサーバー',
}

function modelName(server: AppState | null, value: string | null) {
  if (!value) return null
  return server?.catalog.models.find((model) => model.value === value)?.name ?? null
}

/** Version a model id carries (gpt-6.1-sol → [6, 1], claude-sonnet-5-5 → [5, 5]). */
function modelVersion(id: string): [number, number] {
  const match = /(?:^|[-v])(\d+)(?:[.-](\d+))?(?=-|$|[a-z])/i.exec(id.replace(/^[a-z]+-/i, '-'))
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : [-1, 0]
}

/** Newest first, then alphabetical within one version. */
export function byNewest(a: { id: string }, b: { id: string }) {
  const [am, an] = modelVersion(a.id)
  const [bm, bn] = modelVersion(b.id)
  return bm - am || bn - an || a.id.localeCompare(b.id)
}

export function ModelPicker({ value, onChange }: { value: string | null; onChange: (value: string) => void }) {
  const server = useStore((state) => state.server)
  // Regrouped only when the server state changes, not on every render of the composer.
  const { groups, order, selectable } = useMemo(() => {
    const groups = new Map<string, CatalogModel[]>()
    for (const model of server ? visibleModels(server) : []) {
      const list = groups.get(model.provider) ?? []
      list.push(model)
      groups.set(model.provider, list)
    }
    // Models the ChatGPT account no longer offers sink to the bottom of their group.
    for (const list of groups.values()) list.sort((a, b) => Number(Boolean(a.retired)) - Number(Boolean(b.retired)) || byNewest(a, b))
    const order = [...new Set([...PROVIDER_ORDER, ...groups.keys()])].filter((provider) => groups.has(provider))
    // The wheel walks the models the menu offers, in menu order.
    const selectable = server
      ? order.filter((provider) => providerReady(server, provider)).flatMap((provider) => groups.get(provider)!.map((model) => model.value))
      : []
    return { groups, order, selectable }
  }, [server])
  const wheel = useWheelSelect<HTMLButtonElement>(selectable, value, onChange)
  if (!server) return null
  const label = modelName(server, wheel.shown) ?? 'モデルを選択'
  return (
    <Dropdown
      width={300}
      trigger={({ toggle, open }) => (
        <button
          ref={wheel.ref}
          type="button"
          className={`chip ${open ? 'active' : ''} ${wheel.pending ? 'wheeling' : ''}`}
          onClick={toggle}
          title="モデル（ホイールで切り替え）"
        >
          <span>{label}</span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <div className="menu-scroll">
          {order.length === 0 && <div className="menu-empty">{server.catalog.models.length ? '表示するモデルがありません。設定からチェックを入れてください。' : 'モデル一覧を読み込み中です…'}</div>}
          {order.map((provider, index) => {
            const ready = providerReady(server, provider)
            return (
              <div key={provider}>
                {index > 0 && <MenuDivider />}
                <MenuHeading>
                  {server.catalog.providers[provider] ?? provider}
                  <span className="menu-heading-note">{PROVIDER_NOTE[provider] ?? ''}</span>
                </MenuHeading>
                {ready
                  ? groups.get(provider)!.map((model) => (
                    <MenuItem
                      key={model.value}
                      label={model.name}
                      description={model.retired ? 'ChatGPT の一覧にありません（提供終了の可能性）' : undefined}
                      selected={model.value === value}
                      onSelect={() => {
                        onChange(model.value)
                        close()
                      }}
                    />
                  ))
                  : (
                    <MenuItem
                      icon={<KeyRound size={14} />}
                      label={provider === 'openai-codex' ? 'ChatGPT にサインイン…' : 'API キーを設定…'}
                      description="設定を開きます"
                      onSelect={() => {
                        close()
                        setState({ settingsOpen: 'accounts' })
                      }}
                    />
                  )}
              </div>
            )
          })}
          {order.length > 0 && <MenuDivider />}
          <MenuItem
            label="表示するモデルを設定…"
            onSelect={() => {
              close()
              setState({ settingsOpen: 'models' })
            }}
          />
        </div>
      )}
    </Dropdown>
  )
}

export function EffortPicker({ model, value, onChange }: { model: string | null; value: string; onChange: (value: string) => void }) {
  const catalog = useStore((state) => state.server?.catalog)
  const efforts = pickableEfforts(catalog ? (model && catalog.effortsByModel[model]) || catalog.fallbackEfforts : [])
  const values = efforts.map((effort) => effort.value)
  // A level this model lacks shows (and is sent) as the nearest one it has.
  const current = nearestEffort(value, values)
  const wheel = useWheelSelect<HTMLButtonElement>(values, current, onChange)
  if (!catalog || efforts.length <= 1) return null
  return (
    <Dropdown
      width={200}
      trigger={({ toggle, open }) => (
        <button
          ref={wheel.ref}
          type="button"
          className={`chip ${open ? 'active' : ''} ${wheel.pending ? 'wheeling' : ''}`}
          onClick={toggle}
          title="推論の深さ（ホイールで切り替え）"
        >
          <Brain size={13} />
          <span>{effortLabel(wheel.shown ?? '')}</span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeading>推論の深さ</MenuHeading>
          {efforts.map((effort) => (
            <MenuItem
              key={effort.value}
              label={effortLabel(effort.value, effort.name)}
              selected={effort.value === current}
              onSelect={() => {
                onChange(effort.value)
                close()
              }}
            />
          ))}
        </>
      )}
    </Dropdown>
  )
}

/**
 * Fast mode for the chosen model's provider, shown only when the model offers
 * it. The switch is per provider (like Codex CLI's), so it covers every task.
 */
export function FastModeChip({ model }: { model: string | null }) {
  const server = useStore((state) => state.server)
  const parsed = parseModel(model)
  const provider = parsed?.provider as FastProvider | undefined
  const note = provider && parsed ? server?.fastModels?.[provider]?.[parsed.id] : undefined
  if (!server || !provider || note === undefined) return null
  const on = Boolean(server.settings.fastMode?.[provider])
  const label = server.catalog.providers[provider] ?? provider
  return (
    <button
      type="button"
      className={`chip fast-chip ${on ? 'on' : ''}`}
      aria-pressed={on}
      title={`高速モード: ${on ? 'オン' : 'オフ'}（${fastNote(note)}）\n${label} のすべてのタスクに、次のリクエストから反映します。`}
      onClick={() => void act('settings.update', { patch: { fastMode: { [provider]: !on } } })}
    >
      <Zap size={13} fill={on ? 'currentColor' : 'none'} />
      <span>高速</span>
    </button>
  )
}

const MODE_ICONS: Record<PermissionMode, typeof Shield> = {
  'read-only': Shield,
  'workspace-write': ShieldCheck,
  'danger-full-access': ShieldAlert,
}

export function PermissionPicker({ value, onChange, existing, disabled }: {
  value: PermissionMode
  onChange: (value: PermissionMode) => void
  existing?: boolean
  disabled?: boolean
}) {
  const modes = useStore((state) => state.server?.permissionModes) ?? ['read-only', 'workspace-write', 'danger-full-access']
  const Icon = MODE_ICONS[value]
  return (
    <Dropdown
      width={320}
      trigger={({ toggle, open }) => (
        <button
          type="button"
          className={`chip ${open ? 'active' : ''} ${value === 'danger-full-access' ? 'warn' : ''}`}
          onClick={toggle}
          disabled={disabled}
          title={disabled ? '作業中は変更できません' : '権限'}
        >
          <Icon size={13} />
          <span>{PERMISSION_INFO[value].label}</span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeading>権限</MenuHeading>
          {modes.map((mode) => {
            const ModeIcon = MODE_ICONS[mode]
            return (
              <MenuItem
                key={mode}
                icon={<ModeIcon size={15} />}
                label={PERMISSION_INFO[mode].label}
                description={PERMISSION_INFO[mode].description}
                selected={mode === value}
                danger={mode === 'danger-full-access'}
                onSelect={() => {
                  onChange(mode)
                  close()
                }}
              />
            )
          })}
          {existing && <div className="menu-footnote">変更すると新しいセッションに切り替わります。会話の要点は自動で引き継ぎます。</div>}
        </>
      )}
    </Dropdown>
  )
}

export function WorkspacePicker({ value, onChange, placement = 'bottom' }: {
  value: string | null
  onChange: (value: string) => void
  placement?: 'top' | 'bottom'
}) {
  const workspaces = useStore((state) => state.server?.settings.workspaces) ?? []
  const myPc = useStore((state) => state.server?.app.myPc) ?? ''
  const names = useStore((state) => state.server?.settings.projectNames)
  return (
    <Dropdown
      width={360}
      placement={placement}
      trigger={({ toggle, open }) => (
        <button type="button" className={`chip workspace-chip ${open ? 'active' : ''}`} onClick={toggle} title={value ?? 'ワークスペース'}>
          {value && value === myPc ? <Monitor size={14} /> : <FolderOpen size={14} />}
          <span>{value ? workspaceLabel(value, myPc, names) : 'ワークスペースを選択'}</span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <>
          {myPc && (
            <MenuItem
              icon={<Monitor size={14} />}
              label="My PC"
              description="プロジェクトなし（リポジトリを参照しない）"
              selected={value === myPc}
              onSelect={() => {
                onChange(myPc)
                close()
              }}
            />
          )}
          {workspaces.length > 0 && <MenuDivider />}
          {workspaces.length > 0 && <MenuHeading>プロジェクト</MenuHeading>}
          <div className="menu-scroll short">
            {workspaces.map((workspace) => (
              <div key={workspace} className="workspace-row">
                <MenuItem
                  icon={<FolderOpen size={14} />}
                  label={workspaceLabel(workspace, myPc, names)}
                  description={workspace}
                  selected={workspace === value}
                  onSelect={() => {
                    onChange(workspace)
                    close()
                  }}
                />
                <button
                  type="button"
                  className="icon-button small row-remove"
                  title="一覧から外す"
                  aria-label={`${basename(workspace)} を一覧から外す`}
                  onClick={() => void act('workspace.remove', { path: workspace })}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          {workspaces.length > 0 && <MenuDivider />}
          <MenuItem
            icon={<FolderPlus size={14} />}
            label="プロジェクトを作成…"
            onSelect={() => {
              close()
              openProjectDialog()
            }}
          />
        </>
      )}
    </Dropdown>
  )
}
