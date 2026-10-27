import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { act, useStore } from '../../store'
import type { FastProvider } from '../../types'
import { byNewest, providerReady } from '../Pickers'
import { isModelVisible } from '../../model-selection'
import { CLAUDE_CODE } from '../WorkflowModelField'

function contextLabel(tokens: number) {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}K`
}

/** Caps the context window per provider (applies to every model of that provider). */
function ContextSizes({ contextOptions }: { contextOptions: number[] }) {
  const limits = useStore((state) => state.server?.settings.contextLimits)
  if (!limits) return null
  const rows: { provider: keyof typeof limits; label: string; note: string; top: string }[] = [
    {
      provider: 'openai-codex',
      label: 'ChatGPT',
      note: '広げると利用枠の減りが早くなります。',
      top: '最大（モデルごと）',
    },
    { provider: 'anthropic', label: 'Claude', note: '小さくすると API 料金を抑えられます。', top: '1M まで' },
  ]
  return (
    <section className="account-card">
      <div className="account-head">
        <div>
          <h3>コンテキストサイズ</h3>
          <p className="muted">8 割に近づくと古いやり取りを要約します。</p>
        </div>
      </div>
      {rows.map(({ provider, label, note, top }) => (
        <div key={provider} className="setting compact">
          <div>
            <h3>{label}</h3>
            <p className="muted">{note}</p>
          </div>
          <select
            value={limits[provider] ?? ''}
            onChange={(event) => void act('settings.update', {
              patch: { contextLimits: { [provider]: event.target.value ? Number(event.target.value) : null } },
            })}
            aria-label={`${label} のコンテキストサイズ`}
          >
            <option value="">モデルの既定サイズ</option>
            {contextOptions.map((tokens) => (
              <option key={tokens} value={tokens}>{tokens === contextOptions[0] ? top : `${contextLabel(tokens)} まで`}</option>
            ))}
          </select>
        </div>
      ))}
    </section>
  )
}

/** Fast mode per provider: the same model served faster, for a higher price or quicker limit use. */
function FastMode() {
  const server = useStore((state) => state.server)
  if (!server) return null
  const rows: { provider: FastProvider; label: string; note: string }[] = [
    {
      provider: 'anthropic',
      label: 'Claude',
      note: '最大 2.5 倍速、料金は 2 倍。',
    },
    {
      provider: 'openai-codex',
      label: 'ChatGPT',
      note: '公式経路では使えません。',
    },
  ]
  return (
    <section className="account-card">
      <div className="account-head">
        <div>
          <h3>高速モード</h3>
        </div>
      </div>
      {rows.map(({ provider, label, note }) => {
        const models = server.catalog.models
          .filter((model) => model.provider === provider && server.fastModels?.[provider]?.[model.id] !== undefined)
          .sort(byNewest)
        const ready = providerReady(server, provider)
        const on = Boolean(server.settings.fastMode?.[provider])
        return (
          <div key={provider} className="setting compact">
            <div>
              <h3>{label}</h3>
              <p className="muted">{note}</p>
              {models.length > 0 && <p className="muted">{models.map((model) => model.name).join('、')}</p>}
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={provider === 'anthropic' && on}
                disabled={provider === 'openai-codex' || (!ready && !on)}
                onChange={(event) => void act('settings.update', { patch: { fastMode: { [provider]: event.target.checked } } })}
                aria-label={`${label} の高速モード`}
              />
              <span />
            </label>
          </div>
        )
      })}
    </section>
  )
}

/** Delegation tools pinned to the other model family (subagent_claude / subagent_gpt). */
function Subagents() {
  const server = useStore((state) => state.server)
  if (!server) return null
  const enabled = server.settings.subagentsEnabled ?? true
  const chosen = server.settings.subagentModels ?? { 'openai-codex': null, anthropic: null }
  const rows: { provider: keyof typeof chosen; label: string; note: string }[] = [
    { provider: 'anthropic', label: 'Claude', note: 'GPT のタスクから。API の従量課金です。' },
    { provider: 'openai-codex', label: 'ChatGPT', note: 'すべてのタスクから。ChatGPT サブスクリプションの範囲です。' },
  ]
  return (
    <section className="account-card">
      <div className="account-head">
        <div>
          <h3>サブエージェント</h3>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => void act('settings.update', { patch: { subagentsEnabled: event.target.checked } })}
            aria-label="サブエージェントを使う"
          />
          <span />
        </label>
      </div>
      {enabled && rows.map(({ provider, label, note }) => {
        const models = server.catalog.models.filter((model) => model.provider === provider).sort(byNewest)
        const ready = providerReady(server, provider)
        const value = chosen[provider] ?? ''
        return (
          <div key={provider} className="setting compact">
            <div>
              <h3>{label}</h3>
              <p className="muted">{ready ? note : `${label} のアカウントを接続すると選べます。`}</p>
            </div>
            <select
              value={value}
              disabled={!ready && !value}
              onChange={(event) => void act('settings.update', {
                patch: { subagentModels: { [provider]: event.target.value || null } },
              })}
              aria-label={`${label} のサブエージェントに使うモデル`}
            >
              <option value="">使わない</option>
              {value && !models.some((model) => model.id === value) && <option value={value}>{value}</option>}
              {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </div>
        )
      })}
    </section>
  )
}

function ModelVisibility() {
  const server = useStore((state) => state.server)
  const [open, setOpen] = useState(false)
  if (!server) return null
  type VisibilityModel = { value: string; id: string; name: string; retired?: boolean }
  const groups = new Map<string, VisibilityModel[]>()
  const aliases = CLAUDE_CODE.map((model) => ({ ...model, id: model.value.slice(7) }))
  const codeModels = server.catalog.models.filter((model) => model.provider === 'anthropic' && !aliases.some((alias) => alias.id === model.id))
    .map((model) => ({ ...model, value: `claude:${model.id}` }))
  groups.set('claude-code', [...aliases, ...codeModels])
  for (const model of server.catalog.models) {
    if (model.provider === 'anthropic' && !server.accounts.claude.configured) continue
    const list = groups.get(model.provider) ?? []
    list.push(model)
    groups.set(model.provider, list)
  }
  const providers = [...new Set(['claude-code', ...Object.keys(server.catalog.providers), ...groups.keys()])]
    .filter((provider) => groups.has(provider))
  const isVisible = (model: { value: string; retired?: boolean }) => isModelVisible(server, model)
  const all = [...groups.values()].flat()
  const hidden = all.filter((model) => !isVisible(model))
  const total = all.length
  const set = (models: { value: string; retired?: boolean }[], visible: boolean) => {
    const modelVisibility = Object.fromEntries(models.filter((model) => isVisible(model) !== visible).map((model) => [model.value, visible]))
    if (Object.keys(modelVisibility).length) void act('settings.update', { patch: { modelVisibility } })
  }
  return (
    <section className="account-card">
      <button type="button" className="model-visibility-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          <h3>モデルピッカーに表示するモデル</h3>
          <span className="muted">
            {total === 0
              ? 'モデル一覧を読み込み中です…'
              : hidden.length === 0
                ? `すべて表示中（${total}）`
                : `${total - hidden.length} / ${total} を表示中 · 非表示: ${hidden.slice(0, 3).map((model) => model.name).join('、')}${hidden.length > 3 ? ` ほか ${hidden.length - 3}` : ''}`}
          </span>
        </span>
        <span className="model-visibility-action">{open ? '閉じる' : '変更する'}{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>
      {open && (
        <>
          {providers.map((provider) => {
            const models = [...groups.get(provider)!].sort(byNewest)
            return (
              <div key={provider} className="model-visibility">
                <div className="model-visibility-head">
                  <span>{provider === 'claude-code' ? 'Claude Code' : provider === 'anthropic' ? 'Claude（API）' : server.catalog.providers[provider] ?? provider}</span>
                  <span>
                    <button type="button" className="link-button" onClick={() => set(models, true)}>すべて表示</button>
                    <button type="button" className="link-button" onClick={() => set(models, false)}>すべて隠す</button>
                  </span>
                </div>
                <div className="model-visibility-grid">
                  {models.map((model) => {
                    const visible = isVisible(model)
                    return (
                      <label key={model.value} className={`model-visibility-row${visible ? '' : ' off'}`} title={model.id}>
                        <input
                          type="checkbox"
                          checked={visible}
                          onChange={(event) => set([model], event.target.checked)}
                          aria-label={`${provider === 'claude-code' ? 'Claude Code ' : provider === 'anthropic' ? 'Claude（API） ' : ''}${model.name} をモデルピッカーに表示`}
                        />
                        <span>{model.name}{model.retired && <small className="muted"> · 提供終了の可能性</small>}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </>
      )}
    </section>
  )
}

export function ModelsSettings({ contextOptions }: { contextOptions: number[] }) {
  return (
    <div className="settings-section">
      <ModelVisibility />
      <FastMode />
      <ContextSizes contextOptions={contextOptions} />
      <Subagents />
    </div>
  )
}
