import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { act, setState, startTeam, useStore } from '../store'
import type { AppState, TeamProvider, TeamSettings as Config, TeamSummary, TeamTier } from '../types'
import { isModelVisible } from '../model-selection'
import { effortLabel, pickableEfforts, workspaceLabel } from '../util'
import { Modal } from './Modal'
import { byNewest } from './Pickers'
import { claudeEfforts, claudeModelName, claudeModels } from './TerminalPickers'

const MAX_CHILDREN = 12
const PROVIDERS: TeamProvider[] = ['gpt', 'claude', 'deepseek']
const PROVIDER_NAME: Record<TeamProvider, string> = { gpt: 'GPT', claude: 'Claude', deepseek: 'DeepSeek' }
/** Each dsh provider's models in the model list. */
const CATALOG_PROVIDER = { gpt: 'openai-codex', deepseek: 'deepseek-official' } as const
const TIERS: { tier: TeamTier; label: string; note: string }[] = [
  { tier: 'low', label: '低枠', note: '単純な作業、繰り返しの多い作業、量の多い作業' },
  { tier: 'mid', label: '中枠', note: '判断・設計・品質が要る作業' },
]

/** A change to a team's settings, in the shape settings.update and team.create take. */
type Patch = Record<string, unknown>
type Change = (patch: Patch) => void

const tierOn = (tier: { enabled?: boolean }) => tier.enabled !== false

/** The settings with every field (settings saved by an older version lack the GPT leader's and DeepSeek's). */
function fullConfig(saved: Config): Config {
  return {
    ...saved,
    leaderProvider: saved.leaderProvider ?? 'claude',
    gptLeader: saved.gptLeader ?? { model: null, effort: 'high' },
    deepseek: saved.deepseek ?? { enabled: false, low: { enabled: true, model: null, effort: null }, mid: { enabled: true, model: null, effort: null } },
  }
}

/** A provider's part of the settings (fullConfig fills DeepSeek's). */
const part = (config: Config, provider: TeamProvider) => config[provider]!

/** Folds a patch into a draft, two levels deep (gpt.low.model), as the server does. */
function applyPatch(config: Config, patch: Patch): Config {
  const next: Record<string, unknown> = { ...config }
  for (const [key, value] of Object.entries(patch)) {
    if (!value || typeof value !== 'object') {
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

/** dsh models of a provider (GPT on the ChatGPT subscription, DeepSeek on its API key), newest first. */
function dshModels(server: AppState, provider: 'gpt' | 'deepseek' = 'gpt') {
  return server.catalog.models.filter((model) => model.provider === CATALOG_PROVIDER[provider] && isModelVisible(server, model)).sort(byNewest)
}

/** The reasoning levels of a dsh model, as the model list knows them. */
function dshEfforts(server: AppState, id: string | null, provider: 'gpt' | 'deepseek' = 'gpt') {
  const known = id ? server.catalog.effortsByModel[JSON.stringify([CATALOG_PROVIDER[provider], id])] : undefined
  return pickableEfforts(known ?? server.catalog.fallbackEfforts).map((effort) => effort.value)
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
  gpt: 'dsh のタスクとして、ChatGPT サブスクリプションで動きます。',
  claude: '画面なしの Claude Code として、Claude Code にログインしているサブスクリプションで動きます。確認が要る操作は実行せず、報告でリーダーに伝えます。',
  deepseek: 'dsh のタスクとして、DeepSeek の API キーで動きます（使った分だけ DeepSeek に課金されます）。子としてだけ使えます。',
}

function ProviderCard({ server, config, provider, onChange }: { server: AppState; config: Config; provider: TeamProvider; onChange: Change }) {
  const on = part(config, provider).enabled
  const othersOn = PROVIDERS.some((entry) => entry !== provider && part(config, entry).enabled)
  const signedOut = provider === 'gpt' && !server.accounts.chatgpt.signedIn
  const noKey = provider === 'deepseek' && !server.accounts.deepseek.configured
  return (
    <section className={`account-card team-provider-card ${on ? '' : 'off'}`}>
      <div className="setting compact">
        <div>
          <h3>{PROVIDER_NAME[provider]} の子</h3>
          <p className="muted">
            {PROVIDER_NOTE[provider]}
            {signedOut && ' ChatGPT にサインインすると使えます（設定 → アカウント）。'}
            {noKey && ' 設定 → アカウントで DeepSeek の API キーを登録すると使えます。'}
          </p>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={on}
            // At least one provider stays on; DeepSeek needs its key first.
            disabled={on ? !othersOn : noKey}
            onChange={(event) => onChange({ [provider]: { enabled: event.target.checked } })}
            aria-label={`${PROVIDER_NAME[provider]} の子を使う`}
          />
          <span />
        </label>
      </div>
      {on && TIERS.map((entry) => <TierRow key={entry.tier} server={server} config={config} provider={provider} onChange={onChange} {...entry} />)}
    </section>
  )
}

/** Who leads, on which model. */
function LeaderSection({ server, config, onChange }: { server: AppState; config: Config; onChange: Change }) {
  const gptLeads = config.leaderProvider === 'gpt'
  return (
    <section className="account-card">
      <div className="setting compact">
        <div>
          <h3>リーダー</h3>
          <p className="muted">
            {gptLeads
              ? 'GPT（dsh のタスク）がリーダーになり、ChatGPT サブスクリプションで動きます。Claude の上限を使わずにチームを回せます。'
              : 'Claude Code がリーダーになり、Claude Code にログインしているサブスクリプションで動きます。'}
            {gptLeads && !server.accounts.chatgpt.signedIn && ' ChatGPT にサインインすると使えます（設定 → アカウント）。'}
          </p>
        </div>
        <select value={config.leaderProvider} onChange={(event) => onChange({ leaderProvider: event.target.value })} aria-label="リーダー">
          <option value="claude">Claude Code</option>
          <option value="gpt">GPT</option>
        </select>
      </div>
      <div className="setting compact team-tier-row">
        <div>
          <h3>リーダーのモデル</h3>
          <p className="muted">{gptLeads ? '「未設定」のときは GPT の中枠のモデルを使います。' : 'Claude Code で動きます。'}</p>
        </div>
        {gptLeads
          ? (
            <ModelPickers
              models={dshModels(server).map((model) => ({ id: model.id, name: model.name }))}
              levels={dshEfforts(server, config.gptLeader.model ?? config.gpt.mid.model)}
              model={config.gptLeader.model}
              effort={config.gptLeader.effort}
              unset="未設定（中枠と同じ）"
              unsetEffort="モデルの既定"
              label="GPT のリーダー"
              onChange={(patch) => onChange({ gptLeader: patch })}
            />
          )
          : (
            <ModelPickers
              models={claudeModels(server).map((model) => ({ id: model.id, name: claudeModelName(server, model.id) ?? model.id }))}
              levels={claudeEfforts(server, config.leader.model)}
              model={config.leader.model}
              effort={config.leader.effort}
              unset="Claude Code の既定"
              unsetEffort="Claude Code の既定"
              label="リーダー"
              onChange={(patch) => onChange({ leader: patch })}
            />
          )}
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
        {Array.from({ length: MAX_CHILDREN }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} 人まで</option>)}
      </select>
    </div>
  )
}

function BypassSwitch({ config, onChange }: { config: Config; onChange: Change }) {
  return (
    <div className="setting compact">
      <div>
        <h3>リーダーも承認なしで動かす</h3>
        <p className="muted">オフにすると、リーダーがファイルを変えたりコマンドを実行したりする前に、あなたに確認します（GPT のリーダーは「ワークスペース」の権限で動きます）。子はいつも承認なしで動きます。</p>
      </div>
      <label className="switch">
        <input type="checkbox" checked={config.leaderBypass} onChange={(event) => onChange({ leaderBypass: event.target.checked })}
          aria-label="リーダーも承認なしで動かす" />
        <span />
      </label>
    </div>
  )
}

/**
 * TM: starts a team in a folder with the choices made here. They start from
 * the last team's, and the next team starts from these.
 */
export function TeamStartDialog({ workspace }: { workspace: string }) {
  const server = useStore((state) => state.server)
  const [draft, setDraft] = useState<Config | null>(() => (server?.settings.agentTeams ? fullConfig(server.settings.agentTeams) : null))
  const [details, setDetails] = useState(false)
  const [starting, setStarting] = useState(false)
  const close = () => setState({ teamStart: null })
  if (!server || !draft) return null
  const change: Change = (patch) => setDraft((current) => (current ? applyPatch(current, patch) : current))
  const start = async () => {
    setStarting(true)
    const started = await startTeam(workspace, draft)
    setStarting(false)
    if (started) close()
  }
  return (
    <Modal title="エージェントチームを始める" onClose={close} width={620} className="team-start-modal">
      <div className="team-start-body">
        <p className="muted">
          フォルダ: <strong>{workspaceLabel(workspace, server.app.myPc, server.settings.projectNames)}</strong>。
          前回のチームの選び方が入っています。このまま始めても、ここで変えてもかまいません。
        </p>
        <LeaderSection server={server} config={draft} onChange={change} />
        <section className="account-card">
          <ChildCount config={draft} onChange={change} />
        </section>
        {PROVIDERS.map((provider) => <ProviderCard key={provider} server={server} config={draft} provider={provider} onChange={change} />)}
        <button type="button" className={`link-button team-start-details ${details ? 'open' : ''}`} onClick={() => setDetails(!details)}>
          <ChevronRight size={13} /> 詳しい設定
        </button>
        {details && (
          <section className="account-card">
            <BypassSwitch config={draft} onChange={change} />
          </section>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={close}>キャンセル</button>
        <button type="button" className="button primary" disabled={starting} onClick={() => void start()}>始める</button>
      </div>
    </Modal>
  )
}

/**
 * A running team's own settings (from its panel): the children's providers
 * and tiers and how many may be open. Who leads stays as it started.
 */
export function TeamConfigDialog({ team, onClose }: { team: TeamSummary; onClose: () => void }) {
  const server = useStore((state) => state.server)
  const [draft, setDraft] = useState<Config | null>(() => (team.config ? fullConfig(team.config) : null))
  const [saving, setSaving] = useState(false)
  if (!server) return null
  if (!draft) {
    return (
      <Modal title="このチームの設定" onClose={onClose}>
        <p className="muted">Agent Desk を起動し直すと使えます。</p>
      </Modal>
    )
  }
  const change: Change = (patch) => setDraft((current) => (current ? applyPatch(current, patch) : current))
  const save = async () => {
    setSaving(true)
    const result = await act('team.update', { teamId: team.id, patch: { gpt: draft.gpt, claude: draft.claude, deepseek: draft.deepseek, maxChildren: draft.maxChildren } })
    setSaving(false)
    if (result) onClose()
  }
  const leader = draft.leaderProvider === 'gpt' ? 'GPT' : 'Claude Code'
  return (
    <Modal title="このチームの設定" onClose={onClose} width={620} className="team-start-modal">
      <div className="team-start-body">
        <p className="muted">
          リーダー（{leader}）はこのままです。子の枠と数の変更は、次に起動する子から反映し、リーダーにも伝えます。動いている子はそのモデルのまま続けます。
        </p>
        <section className="account-card">
          <ChildCount config={draft} onChange={change} />
        </section>
        {PROVIDERS.map((provider) => <ProviderCard key={provider} server={server} config={draft} provider={provider} onChange={change} />)}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>キャンセル</button>
        <button type="button" className="button primary" disabled={saving} onClick={() => void save()}>保存</button>
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
  const apiSubagent = server.settings.subagentModels?.anthropic
  return (
    <div className="settings-section">
      <section className="account-card">
        <div className="account-head">
          <div>
            <h3>エージェントチーム</h3>
            <p className="muted">
              サイドバーの <span className="cl-mark tm-mark inline">TM</span> でチームを始めます。リーダーに計画や指示を伝えると、
              リーダーが作業を分けて子のエージェントに任せ、終わった子から順に届く報告を確認して、合格か手直しかを決めます。
            </p>
            <p className="muted">
              リーダー（Claude Code / GPT）、同時に動かせる子の数、子に使う GPT・Claude・DeepSeek と枠（低・中）ごとのモデルは、TM を押したときに選びます。使わない枠はオフにできます。前回の選び方を覚えています。
              動いているチームの子の枠と数は、チームのパネルの「このチームの設定」から変えられます。
            </p>
            <p className="muted">
              リーダーが選ぶのは枠と GPT / Claude / DeepSeek だけで、モデル名は選びません。Claude の API は使いません。子は承認なしで作業し、それでも止まったときはリーダーが判断します。
            </p>
          </div>
        </div>
        <BypassSwitch config={config} onChange={(patch) => void act('settings.update', { patch: { agentTeams: patch } })} />
      </section>
      {apiSubagent && (
        <p className="team-warning">
          「モデル」の「サブエージェント」で Claude（API の従量課金）が選ばれています。チームの GPT の子やリーダーがそれを使い始めると Agent Desk が止めますが、
          使わないなら「使わない」にしておくと確実です。
          <button type="button" className="link-button" onClick={() => setState({ settingsOpen: 'models' })}>モデルの設定を開く</button>
        </p>
      )}
    </div>
  )
}
