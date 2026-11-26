import { type CSSProperties, type KeyboardEvent, useEffect, useState } from 'react'
import { ChevronRight, Plus, Trash2 } from 'lucide-react'
import { act, request, setState, startTeam, useStore } from '../store'
import type { AppState, TeamModelChoice, TeamPersonalizeMode, TeamProvider, TeamSettings as Config, TeamSummary, TeamTier } from '../types'
import { isModelVisible, isRetiredModel, isRetiredProvider, retiredLabel, retiredModelName } from '../model-selection'
import { effortLabel, parseModel, pickableEfforts, workspaceLabel } from '../util'
import { Modal } from './Modal'
import { byNewest } from './Pickers'
import { claudeEfforts, claudeModelName, claudeModels } from './TerminalPickers'
import { ClaudeAuthConsent } from './ClaudeAuthConsent'
import { TeamHarness } from './TeamHarness'
import { AbSettings, ExecutionSettings, ModeSection } from './ModeSections'
import { PtcToggle } from './PtcToggle'
import { FallbackSummary } from './FallbackSummary'
import { ModelField, modelGroups } from './WorkflowModelField'
import { Dropdown, MenuDivider, MenuHeading, MenuItem } from './Popover'
import { needsClaudeAuth, type AuthConsentState } from '../team-auth-consent'
import { workflowEffortSupported, workflowLevels } from '../../../shared/workflow-effort.js'
import { usageFallbackChoice } from '../../../shared/usage-fallback.js'
import { MAX_CHILDREN_LIMIT, MAX_TEAM_MODELS } from '../../../shared/team-limits.js'
import { usesClaudeApi } from '../subagent-routes'

const PROVIDERS: TeamProvider[] = ['gpt', 'codex', 'claude', 'claudeApi', 'deepseek', 'opencodeGo', 'commandCode', 'commandCodeClaude', 'local']
const PROVIDER_NAME: Record<TeamProvider, string> = { gpt: 'GPT', codex: 'Codex', claude: 'Claude', claudeApi: 'Claude（API）', deepseek: 'DeepSeek', opencodeGo: 'OpenCode Go', commandCode: 'Command Code', commandCodeClaude: 'Command Code（Claude）', local: 'ローカル LLM' }
type DshProvider = 'gpt' | 'codex' | 'claudeApi' | 'deepseek' | 'opencodeGo' | 'commandCode' | 'commandCodeClaude' | 'local'
/** Each dsh provider's models in the model list. */
const CATALOG_PROVIDER = { gpt: 'openai-codex', codex: 'codex', claudeApi: 'anthropic', deepseek: 'deepseek-official', opencodeGo: 'opencode-go', commandCode: 'command-code', commandCodeClaude: 'command-code-claude', local: 'local-llm' } as const
const CATALOG_TO_TEAM: Record<string, DshProvider> = { 'openai-codex': 'gpt', codex: 'codex', anthropic: 'claudeApi', 'deepseek-official': 'deepseek', 'opencode-go': 'opencodeGo', 'command-code': 'commandCode', 'command-code-claude': 'commandCodeClaude', 'local-llm': 'local' }
const teamModelGroups = (server: AppState) => modelGroups(server, true).filter((group) => group.id === 'claude-code' || CATALOG_TO_TEAM[group.id])
// A removed provider's saved choice keeps its own provider name, so it is still shown and never sent to another route.
const modelValue = (entry: { provider: TeamProvider; model: string }) => entry.provider === 'claude' ? `claude:${entry.model}` : entry.provider === 'codex' ? `codex:${entry.model}`
  : JSON.stringify([isRetiredProvider(entry.provider) ? entry.provider : CATALOG_PROVIDER[entry.provider], entry.model])
/** The name of a saved choice that the menu does not list: a removed provider's model is marked retired. */
const savedName = (server: AppState, entry: { provider: TeamProvider; model: string }) => entry.provider === 'claude' ? claudeModelName(server, entry.model) ?? entry.model
  : isRetiredProvider(entry.provider) ? retiredModelName(modelValue(entry))
  : server.catalog.models.find((model) => model.value === modelValue(entry))?.name ?? entry.model
function pickerChoice(value: string): TeamModelChoice | null {
  if (value.startsWith('claude:')) return { provider: 'claude', model: value.slice(7), effort: null }
  if (value.startsWith('codex:')) return { provider: 'codex', model: value.slice(6), effort: null }
  const parsed = parseModel(value)
  const provider = parsed && CATALOG_TO_TEAM[parsed.provider]
  return parsed && provider ? { provider, model: parsed.id, effort: null } : null
}
const OFF_PROVIDER = { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } }
const TIERS: { tier: TeamTier; label: string; note: string }[] = [
  { tier: 'low', label: '低枠', note: '単純な作業、繰り返しの多い作業、量の多い作業' },
  { tier: 'mid', label: '中枠', note: '判断・設計・品質が要る作業' },
]

/** A change to a team's settings, in the shape settings.update and team.create take. */
type Patch = Record<string, unknown>
type Change = (patch: Patch) => void

const tierOn = (tier: { enabled?: boolean }) => tier.enabled !== false

/** Every provider starts off; a team needs at least one on to hand work to. */
const anyChildOn = (config: Config) => config.modelMode === 'free' ? Boolean(config.freeModels?.length) : PROVIDERS.some((provider) => config[provider]?.enabled)

/**
 * A removed provider the settings still turn on, or a retired child in free mode: the server refuses a team
 * that uses either. Tier mode does not use the free-mode list, so its saved rows do not count.
 */
const retiredChildBlock = (config: Config) => (config.retiredProviders?.length ?? 0) > 0
  || (config.modelMode === 'free' && (config.freeModels ?? []).some((entry) => isRetiredProvider(entry.provider)))

/** The settings with every field (settings saved by an older version lack the GPT leader's and DeepSeek's). */
function fullConfig(saved: Config): Config {
  return {
    ...saved,
    leaderProvider: saved.leaderProvider ?? 'claude',
    gptLeader: saved.gptLeader ?? { model: null, effort: 'high' },
    personalizeMode: saved.personalizeMode ?? 'all',
    modelMode: saved.modelMode ?? 'tiers',
    defaultModelMode: saved.defaultModelMode ?? 'tiers',
    freeModels: saved.freeModels ?? [],
    retiredProviders: saved.retiredProviders ?? [],
    codex: saved.codex ?? OFF_PROVIDER,
    claudeApi: saved.claudeApi ?? OFF_PROVIDER,
    deepseek: saved.deepseek ?? OFF_PROVIDER,
    opencodeGo: saved.opencodeGo ?? OFF_PROVIDER,
    commandCode: saved.commandCode ?? OFF_PROVIDER,
    commandCodeClaude: saved.commandCodeClaude ?? OFF_PROVIDER,
    local: saved.local ?? OFF_PROVIDER,
  }
}

/** A provider's part of the settings (fullConfig fills DeepSeek's). */
const part = (config: Config, provider: TeamProvider) => config[provider]!

/** Folds a patch into a draft, two levels deep (gpt.low.model), as the server does. */
function applyPatch(config: Config, patch: Patch): Config {
  const next: Record<string, unknown> = { ...config }
  for (const [key, value] of Object.entries(patch)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      next[key] = value
      continue
    }
    const part: Record<string, unknown> = { ...(next[key] as Record<string, unknown>) }
    for (const [inner, innerValue] of Object.entries(value)) {
      part[inner] = innerValue && typeof innerValue === 'object' ? { ...(part[inner] as object), ...innerValue } : innerValue
    }
    next[key] = part
  }
  return next as unknown as Config
}

/** dsh models of a provider (GPT on the ChatGPT subscription, Claude and DeepSeek on their API keys), newest first. */
function dshModels(server: AppState, provider: DshProvider = 'gpt') {
  return server.catalog.models.filter((model) => model.provider === CATALOG_PROVIDER[provider] && isModelVisible(server, model)).sort(byNewest)
}

/** The reasoning levels of a dsh model, as the model list knows them. */
function dshEfforts(server: AppState, id: string | null, provider: DshProvider = 'gpt') {
  const known = id ? server.catalog.effortsByModel[provider === 'codex' ? `codex:${id}` : JSON.stringify([CATALOG_PROVIDER[provider], id])] : undefined
  return pickableEfforts(known ?? (provider === 'codex' ? [] : server.catalog.fallbackEfforts)).map((effort) => effort.value)
}

/** A model and its reasoning level, side by side. */
function ModelPickers({ models, levels, model, effort, unset, unsetEffort, label, disabled = false, onChange }: {
  models: { id: string; name: string }[]
  levels: string[]
  model: string | null
  effort: string | null
  unset: string
  unsetEffort: string
  label: string
  disabled?: boolean
  onChange: (patch: { model?: string | null; effort?: string | null }) => void
}) {
  return (
    <div className="team-tier-pickers">
      <select value={model ?? ''} disabled={disabled} onChange={(event) => onChange({ model: event.target.value || null })} aria-label={`${label}のモデル`}>
        <option value="">{unset}</option>
        {model && !models.some((entry) => entry.id === model) && <option value={model}>{model}</option>}
        {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
      <select value={effort ?? ''} disabled={disabled} onChange={(event) => onChange({ effort: event.target.value || null })} aria-label={`${label}の推論の深さ`}>
        <option value="">{unsetEffort}</option>
        {effort && !levels.includes(effort) && <option value={effort}>{effortLabel(effort)}</option>}
        {levels.map((level) => <option key={level} value={level}>{effortLabel(level)}</option>)}
      </select>
    </div>
  )
}

function TierRow({ server, config, provider, tier, label, note, onChange }: {
  server: AppState
  config: Config
  provider: TeamProvider
  tier: TeamTier
  label: string
  note: string
  onChange: Change
}) {
  const chosen = part(config, provider)[tier]
  const on = tierOn(chosen)
  const other = part(config, provider)[tier === 'low' ? 'mid' : 'low']
  const models = provider === 'claude'
    ? claudeModels(server).map((model) => ({ id: model.id, name: claudeModelName(server, model.id) ?? model.id }))
    : dshModels(server, provider).map((model) => ({ id: model.id, name: model.name }))
  const name = `${PROVIDER_NAME[provider]} の${label}`
  return (
    <div className={`setting compact team-tier-row ${on ? '' : 'off'}`}>
      <label className="switch small">
        <input
          type="checkbox"
          checked={on}
          // At least one tier of a provider in use stays on.
          disabled={on && !tierOn(other)}
          onChange={(event) => onChange({ [provider]: { [tier]: { enabled: event.target.checked } } })}
          aria-label={`${name}を使う`}
        />
        <span />
      </label>
      <div>
        <h3>{label}{!on && <span className="muted">（使わない）</span>}</h3>
        <p className="muted">{note}</p>
      </div>
      <ModelPickers
        models={models}
        levels={provider === 'claude' ? claudeEfforts(server, chosen.model) : dshEfforts(server, chosen.model, provider)}
        model={chosen.model}
        effort={chosen.effort}
        unset="未設定（使わない）"
        unsetEffort={provider === 'claude' ? 'Claude Code の既定' : 'モデルの既定'}
        label={name}
        disabled={!on}
        onChange={(patch) => onChange({ [provider]: { [tier]: patch } })}
      />
    </div>
  )
}

const PROVIDER_NOTE: Record<TeamProvider, string> = {
  gpt: 'ChatGPT サブスクリプション',
  codex: 'Codex CLI のアカウント',
  claude: 'Claude Code 自身の認証と課金',
  claudeApi: 'Anthropic API（従量課金）',
  deepseek: 'DeepSeek API（従量課金）',
  opencodeGo: 'OpenCode Go サブスクリプション',
  commandCode: 'Command Code Provider API',
  commandCodeClaude: 'Command Code Provider API',
  local: '課金なし。小さく明確な作業向け',
}

function ProviderCard({ server, config, provider, onChange }: { server: AppState; config: Config; provider: TeamProvider; onChange: Change }) {
  const on = part(config, provider).enabled
  const signedOut = provider === 'gpt' && !server.accounts.chatgpt.signedIn
  const noKey = (provider === 'deepseek' && !server.accounts.deepseek.configured) || (provider === 'claudeApi' && !server.accounts.claude.configured)
    || (provider === 'opencodeGo' && !server.accounts.opencodeGo?.configured)
    || (['commandCode', 'commandCodeClaude'].includes(provider) && !server.accounts.commandCode?.configured)
    || (provider === 'local' && !server.accounts.localLlm?.configured)
  return (
    <section className={`account-card team-provider-card ${on ? '' : 'off'}`}>
      <div className="setting compact">
        <div>
          <h3>{PROVIDER_NAME[provider]} の子</h3>
          <p className="muted">
            {PROVIDER_NOTE[provider]}
            {signedOut && ' · 要サインイン'}
            {noKey && (provider === 'local' ? ' · 要 URL 登録' : ' · 要 API キー')}
          </p>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={on}
            // The API providers need their key first.
            disabled={!on && noKey}
            onChange={(event) => onChange({ [provider]: { enabled: event.target.checked } })}
            aria-label={`${PROVIDER_NAME[provider]} の子を使う`}
          />
          <span />
        </label>
      </div>
      {on && provider === 'claudeApi' && (
        <p className="team-warning">並列数や長い会話で費用が増えます。Claude Console の利用上限を確認してください。</p>
      )}
      {on && TIERS.map((entry) => <TierRow key={entry.tier} server={server} config={config} provider={provider} onChange={onChange} {...entry} />)}
    </section>
  )
}

/** Select several models in one menu; keep each selected model's own effort. */
function FreeModels({ server, config, onChange }: { server: AppState; config: Config; onChange: Change }) {
  const models = config.freeModels ?? []
  const groups = teamModelGroups(server)
  // Keep previously selected, now unavailable models visible and removable.
  const missing = Array.from(new Map(models.filter((entry) => !groups.some((group) => group.models.some((model) => model.value === modelValue(entry))))
    .map((entry) => [modelValue(entry), entry])).values())
  if (missing.length) groups.unshift({ id: 'current', heading: '選択済み', note: '', models: missing.map((entry) => ({
    value: modelValue(entry), name: savedName(server, entry),
  })) })
  const selected = new Set(models.map(modelValue))
  const toggle = (value: string) => {
    if (selected.has(value)) {
      onChange({ freeModels: models.filter((entry) => modelValue(entry) !== value) })
      return
    }
    const chosen = pickerChoice(value)
    if (chosen && models.length < MAX_TEAM_MODELS) onChange({ freeModels: [...models, chosen] })
  }
  return <section className="account-card team-free-models">
    <div className="account-head"><h3>子のモデル <span className="muted">{models.length} / {MAX_TEAM_MODELS}</span></h3>
      <Dropdown placement="bottom" portal width={300} trigger={({ toggle, open }) => (
        <button type="button" className="button ghost" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Plus size={14} /> モデルを選択</button>
      )}>
        {() => <div className="menu-scroll">
          {groups.map((group, index) => <div key={group.id}>
            {index > 0 && <MenuDivider />}
            <MenuHeading>{group.heading}<span className="menu-heading-note">{group.note}</span></MenuHeading>
            {group.status && <MenuItem label={group.status} disabled onSelect={() => {}} />}
            {group.empty && <MenuItem label={group.empty} disabled onSelect={() => {}} />}
            {group.models.map((model) => <MenuItem key={model.value} label={model.name} checkable selected={selected.has(model.value)}
              disabled={!selected.has(model.value) && models.length >= MAX_TEAM_MODELS} onSelect={() => toggle(model.value)} />)}
          </div>)}
        </div>}
      </Dropdown>
    </div>
    {models.map((entry, index) => {
      const value = modelValue(entry)
      const used = new Set(models.filter((other, i) => i !== index && modelValue(other) !== value).map(modelValue))
      const choices = groups.map((group) => ({ ...group, models: group.models.filter((model) => !used.has(model.value)) })).filter((group) => group.models.length)
      if (!choices.some((group) => group.models.some((model) => model.value === value))) {
        choices.unshift({ id: 'current', heading: '選択済み', note: '', models: [{ value, name: savedName(server, entry) }] })
      }
      // A removed provider's row keeps its saved level: no other level is offered for it, so its level cannot change.
      const levels = isRetiredProvider(entry.provider) ? [] : entry.provider === 'claude' ? claudeEfforts(server, entry.model) : dshEfforts(server, entry.model, entry.provider)
      const otherEfforts = new Set(models.filter((other, i) => i !== index && modelValue(other) === value).map((other) => other.effort ?? null))
      const currentLevel = levels.indexOf(entry.effort ?? '')
      const nextEffort = [...levels.slice(currentLevel + 1), ...levels.slice(0, currentLevel + 1)]
        .find((level) => level !== entry.effort && !otherEfforts.has(level))
      const duplicate = <button type="button" className="icon-button team-model-duplicate"
        title={models.length >= MAX_TEAM_MODELS ? `モデルは${MAX_TEAM_MODELS}個まで` : nextEffort ? '別の推論レベルで追加' : '追加できる推論レベルがありません'}
        aria-label={`モデル ${index + 1}を別の推論レベルで追加`} disabled={models.length >= MAX_TEAM_MODELS || !nextEffort}
        onClick={() => {
          if (nextEffort && models.length < MAX_TEAM_MODELS) onChange({ freeModels: [...models.slice(0, index + 1), { ...entry, effort: nextEffort }, ...models.slice(index + 1)] })
        }}><Plus size={14} /></button>
      return <div className="team-free-model-row" key={`${value}:${index}`}>
        <ModelField label={`モデル ${index + 1}`} labelAction={duplicate} value={value} groups={choices} disabled={false} effort={entry.effort ?? ''}
          effortsKnown={entry.provider !== 'codex' || server.catalog.effortsByModel[value] !== undefined}
          efforts={levels} unavailableEfforts={Array.from(otherEfforts, (level) => level ?? '')} allowDefaultEffort
          onChange={(next) => {
            if (next === value) return
            const chosen = pickerChoice(next)
            if (chosen && !used.has(next)) onChange({ freeModels: models.map((model, i) => i === index ? chosen : model) })
          }}
          onEffort={(effort) => {
            if (!otherEfforts.has(effort || null)) onChange({ freeModels: models.map((model, i) => i === index ? { ...model, effort: effort || null } : model) })
          }} />
        <button type="button" className="icon-button" title="削除" aria-label={`モデル ${index + 1}を削除`}
          onClick={() => onChange({ freeModels: models.filter((_, i) => i !== index) })}><Trash2 size={15} /></button>
      </div>
    })}
    {models.some((model) => isRetiredProvider(model.provider)) && <p className="team-warning">OpenScale は廃止されました。該当の子を削除し、選び直してください。</p>}
    {models.some((model) => model.provider === 'claudeApi') && <p className="team-warning">Claude（API）は従量課金です。並列数や長い会話で費用が増えます。</p>}
  </section>
}

function ChildModels({ server, config, onChange }: { server: AppState; config: Config; onChange: Change }) {
  const codexSignedIn = Boolean(server.accounts.codex?.signedIn)
  const codexModelCount = server.codexModels.length
  useEffect(() => {
    // Idle shutdown clears Codex's catalog; opening team settings must relearn it.
    if (codexSignedIn && !codexModelCount) void request('codex.models').catch(() => {})
  }, [codexSignedIn, codexModelCount])
  return <>
    <section className="account-card"><div className="setting compact">
      <h3>モデルの選び方</h3>
      <select aria-label="モデルの選び方" value={config.modelMode ?? 'tiers'} onChange={(event) => onChange({ modelMode: event.target.value })}>
        <option value="tiers">低中モード</option><option value="free">自由モード</option>
      </select>
    </div></section>
    {config.modelMode === 'free' ? <FreeModels server={server} config={config} onChange={onChange} />
      : PROVIDERS.map((provider) => <ProviderCard key={provider} server={server} config={config} provider={provider} onChange={onChange} />)}
  </>
}

/** A leader's existing choice is kept even when it is hidden or not connected. */
function LeaderSection({ server, config, onChange }: { server: AppState; config: Config; onChange: Change }) {
  const provider = config.leaderProvider
  const model = provider === 'claude' ? config.leader.model : provider === 'gpt'
    ? config.gptLeader.model ?? config.gpt.mid.model ?? config.gpt.low.model ?? (config.modelMode === 'free' ? config.freeModels?.find((entry) => entry.provider === 'gpt')?.model : null)
    : config.dshLeader?.model ?? null
  const effort = provider === 'claude' ? config.leader.effort : provider === 'gpt' ? config.gptLeader.effort : config.dshLeader?.effort ?? null
  const value = provider === 'claude' ? modelValue({ provider, model: model ?? '' }) : model ? modelValue({ provider, model }) : ''
  const groups = teamModelGroups(server)
  if (value && !groups.some((group) => group.models.some((entry) => entry.value === value))) {
    const name = provider === 'claude' ? claudeModelName(server, model ?? null) ?? 'Claude Code の既定'
      : model ? savedName(server, { provider, model }) : ''
    groups.unshift({ id: 'current', heading: '選択済み', note: '', models: [{ value, name }] })
  }
  const levels = provider === 'claude' ? claudeEfforts(server, model ?? null) : dshEfforts(server, model ?? null, provider)
  return (
    <section className="account-card">
      <div className="team-leader-picker">
        <ModelField label="リーダー" value={value} groups={groups} disabled={false} effort={effort ?? ''} efforts={levels} allowDefaultEffort allowClearUnavailableEffort
          onChange={(next) => {
            if (next === value) return
            const chosen = pickerChoice(next)
            if (!chosen) return
            if (chosen.provider === 'claude') onChange({ leaderProvider: 'claude', leader: { model: chosen.model, effort: null } })
            else if (chosen.provider === 'gpt') onChange({ leaderProvider: 'gpt', gptLeader: { model: chosen.model, effort: null } })
            else onChange({ leaderProvider: chosen.provider, dshLeader: chosen })
          }}
          onEffort={(next) => onChange(provider === 'claude' ? { leader: { effort: next || null } }
            : provider === 'gpt' ? { gptLeader: { effort: next || null } } : { dshLeader: { effort: next || null } })} />
        {isRetiredProvider(provider) && <p className="team-warning">OpenScale は廃止されました。リーダーを選び直してください。</p>}
        <p className="muted">{isRetiredProvider(provider) ? retiredLabel(provider) : PROVIDER_NOTE[provider]}{provider === 'gpt' && !server.accounts.chatgpt.signedIn && ' · 要サインイン'}</p>
      </div>
    </section>
  )
}

/** A running team's leader: Claude Code or a dsh model (Codex leaders are not switched). */
function TeamLeaderField({ server, value, effort, disabled, onChange }: { server: AppState; value: string; effort: string; disabled: boolean; onChange: (model: string, effort: string) => void }) {
  const groups = teamModelGroups(server).filter((group) => group.id !== 'codex')
  if (!groups.some((group) => group.models.some((entry) => entry.value === value))) {
    const name = value.startsWith('claude:') ? claudeModelName(server, value.slice(7) || null) ?? 'Claude Code の既定' : isRetiredModel(value) ? retiredModelName(value) : server.catalog.models.find((entry) => entry.value === value)?.name ?? value
    groups.unshift({ id: 'current', heading: '選択済み', note: '', models: [{ value, name }] })
  }
  const efforts = (model: string) => {
    if (model.startsWith('claude:')) return claudeEfforts(server, model.slice(7) || null)
    const choice = pickerChoice(model)
    return choice && choice.provider !== 'claude' ? dshEfforts(server, choice.model, choice.provider) : []
  }
  return (
    <section className="account-card">
      <div className="team-leader-picker">
        <ModelField label="リーダー" value={value} groups={groups} disabled={disabled} effort={effort} efforts={efforts(value)} allowDefaultEffort allowClearUnavailableEffort
          onChange={(next) => { if (next !== value) onChange(next, '') }}
          onEffort={(next) => onChange(value, next || '')} />
        {isRetiredModel(value) && <p className="team-warning">OpenScale は廃止されました。リーダーを選び直してください。</p>}
      </div>
    </section>
  )
}

function ChildCount({ config, onChange }: { config: Config; onChange: Change }) {
  return (
    <div className="setting compact">
      <div>
        <h3>同時に動かせる子の数</h3>
        <p className="muted">完了（close）した子は数えません。</p>
      </div>
      <select value={config.maxChildren} onChange={(event) => onChange({ maxChildren: Number(event.target.value) })} aria-label="同時に動かせる子の数">
        {Array.from({ length: MAX_CHILDREN_LIMIT }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} 人まで</option>)}
      </select>
    </div>
  )
}

function BypassSwitch({ config, onChange }: { config: Config; onChange: Change }) {
  return (
    <div className="setting compact">
      <div>
        <h3>リーダーも承認なしで動かす</h3>
        <p className="muted">子は常に承認なしで動きます。</p>
      </div>
      <label className="switch">
        <input type="checkbox" checked={config.leaderBypass} onChange={(event) => onChange({ leaderBypass: event.target.checked })}
          aria-label="リーダーも承認なしで動かす" />
        <span />
      </label>
    </div>
  )
}

/** Saved settings that still turn a removed provider on: the team cannot start or run until the user turns it off. */
function RetiredOn({ config, onChange }: { config: Config; onChange: Change }) {
  if (!config.retiredProviders?.length) return null
  return (
    <section className="account-card">
      <div className="setting compact">
        <p className="team-warning">OpenScale は廃止されました。オンのままでは、チームの開始も子の起動もできません。</p>
        <button type="button" className="button" onClick={() => onChange({ retiredProviders: [] })}>オフにする</button>
      </div>
    </section>
  )
}

function LeanChildrenSwitch({ config, onChange }: { config: Config; onChange: Change }) {
  return (
    <Switch title="子のツールを絞る" note="ブラウザ・画面操作・画像生成は必要な子にだけ渡します。"
      checked={config.leanChildren === true} onChange={(value) => onChange({ leanChildren: value })} />
  )
}

function Switch({ title, note, checked, onChange }: { title: string; note: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="setting compact">
      <div>
        <h3>{title}</h3>
        <p className="muted">{note}</p>
      </div>
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} aria-label={title} />
        <span />
      </label>
    </div>
  )
}

const PERSONALIZE_OPTIONS: { value: TeamPersonalizeMode; label: string; note: string }[] = [
  { value: 'off', label: 'なし', note: '親・子・観測者に適用しません' },
  { value: 'leader', label: '親のみ', note: 'リーダーだけに適用します' },
  { value: 'all', label: 'すべて', note: 'リーダー・子・観測者に適用します' },
]

function TeamPersonalizeSlider({ value, disabled = false, onChange }: {
  value: TeamPersonalizeMode
  disabled?: boolean
  onChange: (value: TeamPersonalizeMode) => void
}) {
  const index = Math.max(0, PERSONALIZE_OPTIONS.findIndex((option) => option.value === value))
  const current = PERSONALIZE_OPTIONS[index]
  const pickAt = (clientX: number, rect: DOMRect) => {
    if (!rect.width) return
    const next = Math.min(PERSONALIZE_OPTIONS.length - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * PERSONALIZE_OPTIONS.length)))
    if (PERSONALIZE_OPTIONS[next].value !== value) onChange(PERSONALIZE_OPTIONS[next].value)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : null
    const next = delta !== null ? Math.min(PERSONALIZE_OPTIONS.length - 1, Math.max(0, index + delta))
      : event.key === 'Home' ? 0
        : event.key === 'End' ? PERSONALIZE_OPTIONS.length - 1
          : null
    if (next === null) return
    event.preventDefault()
    if (next !== index) onChange(PERSONALIZE_OPTIONS[next].value)
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
    buttons[next]?.focus()
  }
  return (
    <div className="setting compact">
      <div>
        <h3>パーソナライズ</h3>
        <p className="muted">{current.note}</p>
      </div>
      <div
        className={`tri-slider ${value === 'off' ? 'tri-slider-off' : ''}`}
        style={{ '--tri-index': index } as CSSProperties}
        role="radiogroup"
        aria-label="パーソナライズの適用範囲"
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return
          pickAt(event.clientX, event.currentTarget.getBoundingClientRect())
        }}
        onPointerMove={(event) => {
          if (disabled || (event.buttons & 1) === 0) return
          if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.setPointerCapture?.(event.pointerId)
          pickAt(event.clientX, event.currentTarget.getBoundingClientRect())
        }}
      >
        <span className="tri-slider-thumb" aria-hidden="true" />
        {PERSONALIZE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            tabIndex={option.value === value ? 0 : -1}
            disabled={disabled}
            className={option.value === value ? 'on' : ''}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * TM: starts a team in a folder with the choices made here. They start from
 * the last team's, and the next team starts from these.
 */
export function TeamStartDialog({ workspace }: { workspace: string }) {
  const server = useStore((state) => state.server)
  const [draft, setDraft] = useState<Config | null>(() => (server?.settings.agentTeams ? { ...fullConfig(server.settings.agentTeams), modelMode: server.settings.agentTeams.defaultModelMode ?? 'tiers' } : null))
  const [details, setDetails] = useState(false)
  const [starting, setStarting] = useState(false)
  const [auth, setAuth] = useState<AuthConsentState>({ ready: false })
  const [authRevision, setAuthRevision] = useState(0)
  const close = () => setState({ teamStart: null })
  if (!server || !draft) return null
  const change: Change = (patch) => setDraft((current) => (current ? applyPatch(current, patch) : current))
  const leaderModel = draft.leaderProvider === 'claude' ? draft.leader.model : draft.leaderProvider === 'gpt' ? draft.gptLeader.model ?? draft.gpt.mid.model ?? draft.gpt.low.model ?? (draft.modelMode === 'free' ? draft.freeModels?.find((entry) => entry.provider === 'gpt')?.model : null) : draft.dshLeader?.model
  const leaderValue = leaderModel ? modelValue({ provider: draft.leaderProvider, model: leaderModel }) : draft.leaderProvider === 'claude' ? 'claude:' : ''
  const shared = Array.isArray(server.settings.usageFallbackRoutes)
  const target = shared ? usageFallbackChoice(server.settings.usageFallbackRoutes, leaderValue) : null
  const fallback = shared ? target?.model ?? '' : draft.leaderFallback ?? ''
  const effort = shared ? target?.effort ?? '' : draft.fallbackEffort ?? ''
  const needsAuth = needsClaudeAuth({ ...draft, leaderFallback: fallback }) || Boolean(server.settings.usageFallbackRoutes?.some((route) => route.model.startsWith('claude:')))
  const fallbackReady = !fallback || (draft.leaderProvider !== 'codex' && !fallback.startsWith('codex:') && fallback !== leaderValue && teamModelGroups(server).some((group) => group.models.some((model) => model.value === fallback)) && workflowEffortSupported(effort, workflowLevels(server.catalog, fallback)))
  // A retired leader, or the children's removed settings, must be fixed first: nothing is started in its place.
  const blocked = isRetiredProvider(draft.leaderProvider) || retiredChildBlock(draft)
  const start = async () => {
    if (!fallbackReady || blocked || (needsAuth && !auth.ready)) return
    setStarting(true)
    const started = await startTeam(workspace, draft, needsAuth ? auth.confirmation : undefined)
    setStarting(false)
    if (started) close()
    else if (needsAuth) { setAuth({ ready: false }); setAuthRevision((value) => value + 1) }
  }
  return (
    <Modal title="エージェントチームを始める" onClose={close} width={620} className="team-start-modal">
      <div className="team-start-body">
        <p className="muted">
          フォルダ: <strong>{workspaceLabel(workspace, server.app.myPc, server.settings.projectNames)}</strong>。
          前回のチームの選び方が入っています。このまま始めても、ここで変えてもかまいません。
        </p>
        <p className="muted">Claude の自動処理には「Claude（API）」の子を推奨します。選択は自動で変更せず、API 利用は従量課金です。</p>
        <LeaderSection server={server} config={draft} onChange={change} />
        {draft.leaderProvider === 'codex' ? <p className="muted">Codexリーダーのフォールバックには対応していません。{fallback && 'フォールバック設定を解除してください。'}</p>
          : <FallbackSummary server={server} value={fallback} effort={effort} shared={shared} sourceSelected={Boolean(leaderValue)} disabled={starting} />}
        <section className="account-card">
          <ChildCount config={draft} onChange={change} />
          <LeanChildrenSwitch config={draft} onChange={change} />
          <TeamPersonalizeSlider value={draft.personalizeMode ?? 'all'} disabled={starting} onChange={(personalizeMode) => change({ personalizeMode })} />
          <PtcToggle mode={draft.toolMode} disabled={starting} onChange={(toolMode) => change({ toolMode })} />
        </section>
        <RetiredOn config={draft} onChange={change} />
        <ChildModels server={server} config={draft} onChange={change} />
        {!anyChildOn(draft) && <p className="team-warning">子に使うモデルを少なくとも一つ選んでください。</p>}
        <button type="button" className={`link-button team-start-details ${details ? 'open' : ''}`} onClick={() => setDetails(!details)}>
          <ChevronRight size={13} /> 詳しい設定
        </button>
        {details && (
          <section className="account-card">
            <BypassSwitch config={draft} onChange={change} />
          </section>
        )}
        {needsAuth && <ClaudeAuthConsent key={authRevision} workspace={workspace} onChange={setAuth} />}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={close}>キャンセル</button>
        <button type="button" className="button primary" disabled={starting || !anyChildOn(draft) || !fallbackReady || blocked || (needsAuth && !auth.ready)} onClick={() => void start()}>始める</button>
      </div>
    </Modal>
  )
}

/**
 * A running team's own settings (from its panel): its leader, the children's
 * providers and tiers, how many may be open, and PTC.
 */
export function TeamConfigDialog({ team, onClose }: { team: TeamSummary; onClose: () => void }) {
  const server = useStore((state) => state.server)
  const [draft, setDraft] = useState<Config | null>(() => (team.config ? fullConfig(team.config) : null))
  const [saving, setSaving] = useState(false)
  const [auth, setAuth] = useState<AuthConsentState>({ ready: false })
  const [authRevision, setAuthRevision] = useState(0)
  const [leaderChoice, setLeaderChoice] = useState<{ model: string; effort: string } | null>(null)
  if (!server) return null
  if (!draft) {
    return (
      <Modal title="このチームの設定" onClose={onClose}>
        <p className="muted">Agent Desk を起動し直すと使えます。</p>
      </Modal>
    )
  }
  const change: Change = (patch) => setDraft((current) => (current ? applyPatch(current, patch) : current))
  const leaderThread = team.leaderKind === 'thread' ? server.threads.find((entry) => entry.id === team.leaderId) : undefined
  const leaderTerminal = team.leaderKind === 'terminal' ? server.terminals.find((entry) => entry.id === team.leaderId) : undefined
  const currentLeader = team.leaderKind === 'thread' ? leaderThread?.model : 'claude:' + (leaderTerminal?.model ?? '')
  const currentEffort = (team.leaderKind === 'thread' ? leaderThread?.effort : leaderTerminal?.effort) || ''
  // Codex and eco leaders stay as they started (the server does not switch them).
  // A leader on a removed provider is shown as retired, and a running team can switch it to another model.
  const leaderRetired = team.leaderKind === 'thread' && isRetiredModel(currentLeader)
  const switchable = !team.execution && team.leaderKind !== 'codex' && Boolean(currentLeader)
  const nextLeader = leaderChoice ?? { model: currentLeader ?? '', effort: currentEffort }
  const leaderChanged = switchable && (nextLeader.model !== currentLeader || nextLeader.effort !== currentEffort)
  const leaderToClaude = leaderChanged && nextLeader.model.startsWith('claude:')
  const needsAuth = needsClaudeAuth(draft, team) || leaderToClaude
  const showAuth = needsAuth || team.children.some((child) => child.kind === 'agent' && child.state !== 'removed')
  const teamTarget = team.sharedFallbackPolicy && Array.isArray(team.usageFallbackRoutes) && !team.leaderFallbackUsed ? usageFallbackChoice(team.usageFallbackRoutes, currentLeader) : null
  const teamFallback = teamTarget?.model ?? (team.sharedFallbackPolicy && Array.isArray(team.usageFallbackRoutes) && !team.leaderFallbackUsed ? '' : draft.leaderFallback ?? '')
  const teamFallbackEffort = teamTarget?.effort ?? (team.sharedFallbackPolicy && Array.isArray(team.usageFallbackRoutes) && !team.leaderFallbackUsed ? '' : draft.fallbackEffort ?? '')
  const toolModeBlocked = team.toolModeBusy && draft.toolMode !== team.config?.toolMode
  // Removed settings the team cannot run with are cleared before saving, so the leader does not switch while the rest is refused.
  const retiredBlock = retiredChildBlock(draft)
  const save = async () => {
    if (toolModeBlocked || retiredBlock || (needsAuth && !auth.ready)) return
    setSaving(true)
    const confirmation = showAuth && auth.ready ? auth.confirmation : undefined
    // A confirmation authorizes one action: the leader's Claude Code launch takes it when there is one.
    if (leaderChanged && !(await act('team.changeLeader', { teamId: team.id, model: nextLeader.model, effort: nextLeader.effort, authConfirmation: leaderToClaude ? confirmation : undefined }))) {
      setSaving(false)
      if (showAuth) { setAuth({ ready: false }); setAuthRevision((value) => value + 1) }
      return
    }
    const result = await act('team.update', { teamId: team.id, authConfirmation: leaderToClaude ? undefined : confirmation, patch: { modelMode: draft.modelMode, freeModels: draft.freeModels, gpt: draft.gpt, codex: draft.codex, claude: draft.claude, claudeApi: draft.claudeApi, deepseek: draft.deepseek, opencodeGo: draft.opencodeGo, commandCode: draft.commandCode, commandCodeClaude: draft.commandCodeClaude, local: draft.local, maxChildren: draft.maxChildren, toolMode: draft.toolMode, retiredProviders: draft.retiredProviders } })
    setSaving(false)
    if (result) onClose()
    else if (showAuth) { setAuth({ ready: false }); setAuthRevision((value) => value + 1) }
  }
  const leaderModel = team.leaderKind === 'thread' ? parseModel(server.threads.find((entry) => entry.id === team.leaderId)?.model) : null
  const leader = team.leaderKind === 'terminal' ? 'Claude Code' : leaderRetired && leaderModel ? retiredLabel(leaderModel.provider) : leaderModel ? server.catalog.providers[leaderModel.provider] ?? leaderModel.provider : PROVIDER_NAME[draft.leaderProvider]
  return (
    <Modal title="このチームの設定" onClose={onClose} width={620} className="team-start-modal">
      <div className="team-start-body">
        {switchable && <TeamLeaderField server={server} value={nextLeader.model} effort={nextLeader.effort} disabled={saving}
          onChange={(model, effort) => setLeaderChoice({ model, effort })} />}
        {leaderChanged && nextLeader.model.startsWith('claude:') !== (team.leaderKind === 'terminal') && <p className="team-warning">実行方式が変わるため、会話は抜粋で引き継ぎます。リーダーが待機中のときだけ切り替えられます。</p>}
        <p className="muted">
          {!switchable && `リーダー（${leader}）はこのままです。`}子のモデルと数の変更は、次に起動する子から反映し、リーダーにも伝えます。動いている子はそのモデルのまま続けます。
        </p>
        <section className="account-card">
          <ChildCount config={draft} onChange={change} />
          {!team.execution && (
            <div className="setting compact">
              <div>
                <h3>パーソナライズ</h3>
                <p className="muted">開始時に固定</p>
              </div>
              <span className="muted">{PERSONALIZE_OPTIONS.find((option) => option.value === (draft.personalizeMode ?? 'all'))?.label ?? 'すべて'}</span>
            </div>
          )}
          <PtcToggle mode={draft.toolMode} disabled={saving || team.toolModeBusy} onChange={(toolMode) => change({ toolMode })} />
        </section>
        <RetiredOn config={draft} onChange={change} />
        <ChildModels server={server} config={draft} onChange={change} />
        {team.leaderKind === 'codex' ? <p className="muted">Codexリーダーのフォールバックには対応していません。</p>
          : <FallbackSummary server={server} value={teamFallback} effort={teamFallbackEffort} shared={Boolean(team.sharedFallbackPolicy)}
            sourceSelected={Boolean(currentLeader)} disabled={saving} frozen />}
        {team.leaderFallbackUsed && <p className="muted">このチームではフォールバックを使用済みです。</p>}
        {!anyChildOn(draft) && <p className="team-warning">子に使うモデルを少なくとも一つ選んでください。</p>}
        {showAuth && <ClaudeAuthConsent key={authRevision} workspace={team.workspace} teamId={team.id} onChange={setAuth} />}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>キャンセル</button>
        <button type="button" className="button primary" disabled={saving || toolModeBlocked || retiredBlock || !anyChildOn(draft) || (needsAuth && !auth.ready)} onClick={() => void save()}>保存</button>
      </div>
    </Modal>
  )
}

/** 設定 → エージェントチーム: what a team is, and the settings seldom changed. */
export function TeamSettings() {
  const server = useStore((state) => state.server)
  if (!server) return null
  const saved = server.settings.agentTeams
  if (!saved) return <div className="settings-section"><p className="muted">Agent Desk を起動し直すと使えます。</p></div>
  const config = fullConfig(saved)
  const save: Change = (patch) => void act('settings.update', { patch: { agentTeams: patch } })
  const apiSubagent = usesClaudeApi(server.settings)
  return (
    <div className="settings-section">
      <ModeSection mark="TM" name="エージェントチーム">
        <p className="muted">
          サイドバーの <span className="cl-mark tm-mark inline">TM</span> で始め、構成もそこで選びます。
        </p>
        <RetiredOn config={config} onChange={save} />
        <Switch title="自由モードを標準にする" note="オフの場合は低中モード" checked={config.defaultModelMode === 'free'}
          onChange={(value) => save({ defaultModelMode: value ? 'free' : 'tiers' })} />
        <BypassSwitch config={config} onChange={save} />
        <Switch title="報告をまとめて渡す" note="近い時間に届いた報告を1ターンにまとめます。"
          checked={config.batchReports !== false} onChange={(value) => save({ batchReports: value })} />
        <LeanChildrenSwitch config={config} onChange={save} />
        <TeamHarness mode="tm" />
      </ModeSection>
      <ModeSection mark="AB" name="2社に相談"><AbSettings /><TeamHarness mode="ab" /></ModeSection>
      <ModeSection mark="eco" name="エコモード"><ExecutionSettings /><TeamHarness mode="eco" /></ModeSection>
      {apiSubagent && (
        <p className="team-warning">
          サブエージェントに Claude（API の従量課金）が選ばれています。
          <button type="button" className="link-button" onClick={() => setState({ settingsOpen: 'models' })}>モデルの設定を開く</button>
        </p>
      )}
    </div>
  )
}
