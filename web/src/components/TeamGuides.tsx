import { useState } from 'react'
import { Copy, Loader2, Plus, Trash2 } from 'lucide-react'
import { request, toast } from '../store'
import type { TeamPlaybook, TeamPolicy } from '../types'
import { copyText, parseModel } from '../util'

type ModelGroup = { id: string; heading: string; models: { value: string; name: string }[] }

const POLICY_PROMPT = `Agent Deskのエージェントチーム「自由モード」で使う、モデルの使い分け方針を作ってください。

1. 下に添付した「自由モードのモデル候補」を調査対象にしてください。これはコピー時点のピッカー候補であり、現在のチームで選択中のモデル一覧ではありません。チームのstatusや実行時の許可一覧だけで対象を絞らず、OpenCode Goを含む全プロバイダーの全候補をモデルごとに確認してください。同名のモデルもプロバイダー・課金経路ごとに区別してください。候補一覧の読み込み状態を確認し、不完全な場合は不足を明記してください。

2. 対象モデルの得意分野や制約を、できるだけ最新の公式情報を中心に調べて比較してください。

あわせて、コーディング、推論、知識・調査などの用途に関連するベンチマークや第三者による評価を調べてください。公式発表と第三者の評価は区別し、比較する際はモデルのバージョン、推論設定、テスト条件や評価日を確認してください。条件が異なる結果を単純に順位付けせず、比較できない点や情報が不足している点は明記してください。

根拠が見つからない特徴や、料金・速度の不明な点は推測で補わず、不明としてください。情報源と確認日も示してください。

3. 比較結果をもとに、タスクの種類や難しさに応じて、リーダーが子のモデルを選べる具体的な方針を作ってください。例えば、調査、実装、レビュー、難しい問題などの使い分けと、適したモデルが選択されていない場合の代替方法を含めてください。根拠の薄いモデル間の優劣を断定しないでください。

4. 結果は次の順で示してください。
- 確認したモデルと、それぞれの使い分けの要点
- 調査したベンチマークと、比較上の注意点
- そのまま「方針」に貼れる文章（2,000文字以内）
- 参考にした情報源と、分からなかったこと

候補一覧はコピー時の接続・表示設定に基づき、未接続・非表示のモデルは含まれません。情報を確認できないモデルは省略せず不明とし、必要な情報を示してください。設定やモデルの選択は勝手に変更しないでください。`

function policyPrompt(groups: ModelGroup[], catalogLoaded: boolean) {
  const models = groups.flatMap((group) => group.models.map((model) => {
    const id = group.id === 'claude-code' ? model.value.slice('claude:'.length) : parseModel(model.value)?.id ?? model.value
    return `- ${JSON.stringify(group.heading)} (${group.id}): ${JSON.stringify(model.name)} [ID: ${JSON.stringify(id)}]`
  }))
  return `${POLICY_PROMPT}\n\n自由モードのモデル候補（コピー時点）:\n${catalogLoaded ? 'カタログの取得済みデータに基づく候補です。' : 'カタログが空のため、一覧は不完全な可能性があります。'}\n${models.join('\n') || '候補を取得できませんでした。'}`
}

/** server/team-playbooks.js */
const NAME_MAX = 40
const ENTRIES_MAX = 30

type Entry = { id: string } & Record<string, string>
type Field = { key: string; placeholder: string; max: number; multiline?: boolean; label: string }

/** An entry id the server keeps (ENTRY_ID); randomUUID is missing on a phone over plain http. */
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
/** As the server saves it (team-playbooks.js): trimmed, a name on one line. */
const asSaved = (key: string, value: unknown) => (typeof value !== 'string' ? value : (key === 'name' ? value.replace(/\s+/g, ' ') : value).trim())
const same = (a: Entry[], b: Entry[]) => JSON.stringify(a, asSaved) === JSON.stringify(b, asSaved)

/** A list of named texts, edited here and saved as one settings field. */
function GuideList({ title, setting, saved, fields, prompt }: { title: string; setting: string; saved: Entry[]; fields: Field[]; prompt?: string }) {
  const [draft, setDraft] = useState(saved)
  const [base, setBase] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Follow external saves only when clean, or when our own save is published.
  // A dirty draft must keep its original base so a later save detects conflicts.
  if (!same(saved, base) && (same(draft, base) || same(draft, saved))) {
    setBase(saved)
    setDraft(saved)
  }
  const dirty = !same(draft, saved)
  const invalid = draft.some((entry) => !entry.name.trim() || fields.some((field) => (entry[field.key] ?? '').length > field.max))
  const edit = (id: string, patch: Record<string, string>) => setDraft(draft.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
  const add = () => setDraft([...draft, { id: newId(), name: '', ...Object.fromEntries(fields.map((field) => [field.key, ''])) }])

  const remove = async (id: string) => {
    const remaining = draft.filter((entry) => entry.id !== id)
    if (!base.some((entry) => entry.id === id)) {
      setDraft(remaining)
      return
    }
    // Persist only the deletion, not unrelated edits or incomplete new entries.
    const nextBase = base.filter((entry) => entry.id !== id)
    setSaving(true)
    setError(null)
    try {
      await request('settings.update', { patch: { [setting]: nextBase, teamGuidesBase: { [setting]: base } } })
      setBase(nextBase)
      setDraft(remaining)
      toast(`${title}を削除しました`, 'success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setSaving(false)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await request('settings.update', { patch: { [setting]: draft, teamGuidesBase: { [setting]: base } } })
      toast(`${title}を保存しました`, 'success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setSaving(false)
  }

  return (
    <section className="account-card">
      <div className="account-head">
        <h3>{title}</h3>
        <div className="team-guide-actions">
          {setting === 'teamPolicies' && (
            <button type="button" className="button ghost" onClick={() => {
              void copyText(prompt ?? POLICY_PROMPT).then(() => toast('方針作成指示文をコピーしました', 'success'), () => toast('コピーできませんでした', 'error'))
            }}>
              <Copy size={14} /> 方針作成指示文をコピー
            </button>
          )}
          <button type="button" className="button ghost" onClick={add} disabled={saving || draft.length >= ENTRIES_MAX}>
            <Plus size={14} /> 追加
          </button>
        </div>
      </div>
      {draft.map((entry) => (
        <div key={entry.id} className="team-guide">
          <div className="team-guide-head">
            <input value={entry.name} maxLength={NAME_MAX} readOnly={saving} onChange={(event) => edit(entry.id, { name: event.target.value })}
              placeholder="名前" aria-label={`${title}の名前`} />
            <button type="button" className="icon-button" disabled={saving} onClick={() => void remove(entry.id)}
              title="削除" aria-label={`${entry.name || title}を削除`}>
              <Trash2 size={15} />
            </button>
          </div>
          {fields.map((field) => {
            const value = entry[field.key] ?? ''
            const props = {
              value,
              readOnly: saving,
              placeholder: field.placeholder,
              'aria-label': `${entry.name || title}の${field.label}`,
              onChange: (event: { target: { value: string } }) => edit(entry.id, { [field.key]: event.target.value }),
            }
            return (
              <div key={field.key} className="team-guide-field">
                {field.multiline
                  ? <textarea className="instructions-input team-guide-text" rows={6} spellCheck={false} {...props} />
                  : <input {...props} />}
                {value.length > field.max * 0.8 && (
                  <span className={value.length > field.max ? 'form-error' : 'fine-print'}>
                    {value.length.toLocaleString()} / {field.max.toLocaleString()}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ))}
      {dirty && (
        <div className="instructions-footer">
          <span />
          <div className="instructions-actions">
            <button type="button" className="button" onClick={() => { setDraft(saved); setBase(saved); setError(null) }} disabled={saving}>元に戻す</button>
            <button type="button" className="button primary" onClick={() => void save()} disabled={invalid || saving}>
              {saving && <Loader2 size={14} className="spin" />} 保存
            </button>
          </div>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}

/** 設定 → エージェントチーム: the policies a team can start with, and the playbooks every leader can open. */
export function TeamGuides({ policies, playbooks, modelGroups, catalogLoaded }: { policies: TeamPolicy[]; playbooks: TeamPlaybook[]; modelGroups: ModelGroup[]; catalogLoaded: boolean }) {
  return (
    <>
      <GuideList
        title="方針"
        setting="teamPolicies"
        saved={policies}
        prompt={policyPrompt(modelGroups, catalogLoaded)}
        fields={[{
          key: 'text', label: '本文', max: 2_000, multiline: true,
          placeholder: '例:\n- 設計とレビューは Claude の中枠、量の多い作業は GPT の低枠\n- 子は 3 人までにして、細かく分けすぎない',
        }]}
      />
      <GuideList
        title="プレイブック"
        setting="teamPlaybooks"
        saved={playbooks}
        fields={[
          { key: 'description', label: '使う場面', max: 200, placeholder: '使う場面（例: 大きな改修を始めるとき）' },
          { key: 'body', label: '本文', max: 20_000, multiline: true, placeholder: '手順' },
        ]}
      />
    </>
  )
}
