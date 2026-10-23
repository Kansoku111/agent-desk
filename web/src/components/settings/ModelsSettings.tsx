import { useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, RefreshCw } from 'lucide-react'
import { act, toast, useStore } from '../../store'
import type { FastProvider, ModelUpdate } from '../../types'
import { byNewest, providerReady } from '../Pickers'
import { isModelVisible } from '../../model-selection'
import { dateTime } from './shared'

const MODEL_PROVIDERS = [
  { id: 'openai-codex', label: 'ChatGPT' },
  { id: 'anthropic', label: 'Claude' },
]

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
      </div>
      {rows.map(({ provider, label, note }) => {
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
  const groups = new Map<string, typeof server.catalog.models>()
  for (const model of server.catalog.models) {
    const list = groups.get(model.provider) ?? []
    list.push(model)
    groups.set(model.provider, list)
  }
  const providers = [...new Set([...Object.keys(server.catalog.providers), ...groups.keys()])]
    .filter((provider) => groups.has(provider))
  const isVisible = (model: { value: string; retired?: boolean }) => isModelVisible(server, model)
  const hidden = server.catalog.models.filter((model) => !isVisible(model))
  const total = server.catalog.models.length
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
                  <span>{server.catalog.providers[provider] ?? provider}</span>
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
                          aria-label={`${model.name} をモデルピッカーに表示`}
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
      <ModelUpdateCard />
    </div>
  )
}

const MODEL_SOURCES = { fetched: '自動取得', bundled: '同梱', account: 'ChatGPT アカウントの一覧' }

/** New models from the ChatGPT account's list and the newest pi-ai release, and the ones Agent Desk adds now. */
function ModelUpdateCard() {
  const update = useStore((state) => state.server?.modelUpdate)
  const enabled = useStore((state) => state.server?.settings.modelAutoUpdate) !== false
  const signedIn = useStore((state) => state.server?.accounts.chatgpt.signedIn)
  const [checking, setChecking] = useState(false)
  if (!update) return null
  const busy = checking || update.phase === 'checking'
  const account = update.account
  const retired = enabled ? account?.retired ?? [] : []

  const check = async () => {
    setChecking(true)
    const response = await act<{ modelUpdate: ModelUpdate }>('modelUpdate.check')
    setChecking(false)
    const result = response?.modelUpdate
    if (!result || result.error) return
    const accountError = signedIn && result.account?.status === 'error'
    if (accountError) toast('ChatGPT のモデル一覧を読み込めませんでした。あとでもう一度お試しください', 'error')
    else if (result.lastAdded?.at === update.lastAdded?.at) toast('モデルの一覧は最新です', 'success')
  }

  return (
    <section className="account-card">
      <div className="account-head">
        <div>
          <h3>モデル一覧を本家と同期</h3>
          <p className="muted">GPT はアカウントの一覧に、Claude などは pi-ai の最新版に合わせます。</p>
        </div>
      </div>

      <div className="setting compact">
        <div>
          <h3>自動で同期する</h3>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => void act('settings.update', { patch: { modelAutoUpdate: event.target.checked } })}
            aria-label="新しいモデルを自動で追加"
          />
          <span />
        </label>
      </div>

      <div className="account-row">
        <span>
          モデル定義: {update.source ? <code>pi-ai {update.source}</code> : '同梱のもの'}
          {update.latest && update.source && update.latest !== update.source && <> （最新: <code>{update.latest}</code>）</>}
        </span>
        <button type="button" className="button" disabled={busy} onClick={() => void check()}>
          {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 今すぐ確認
        </button>
      </div>
      {update.error && <p className="form-error">{update.error}</p>}

      {enabled && (
        <div className="account-row">
          <span>
            ChatGPT アカウントの一覧:{' '}
            {!signedIn || account?.status === 'signed-out'
              ? 'ChatGPT にサインインすると照合できます'
              : account?.status === 'error'
                ? '読み込めませんでした（前回の結果を使っています）'
                : account?.checkedAt ? `照合済み（${dateTime(account.checkedAt)}）` : '確認中…'}
          </span>
        </div>
      )}
      {retired.length > 0 && (
        <p className="muted">提供終了の可能性: {retired.map((model) => model.name).join('、')}</p>
      )}

      {update.models.length > 0 && (
        <ul className="custom-models">
          {update.models.map((model) => (
            <li key={`${model.provider}/${model.id}`}>
              <div>
                <span>{model.name}</span>
                <code>{MODEL_PROVIDERS.find((item) => item.id === model.provider)?.label} · {model.id} · {MODEL_SOURCES[model.source]}</code>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="fine-print">
        {update.checkedAt ? `最終確認: ${dateTime(update.checkedAt)}。` : ''}
        {update.lastAdded ? `前回追加: ${update.lastAdded.models.map((model) => model.name).join('、')}（${dateTime(update.lastAdded.at)}）。` : ''}
      </p>
    </section>
  )
}