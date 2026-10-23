import { useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { request, toast } from '../store'
import type { TeamPlaybook, TeamPolicy } from '../types'

/** server/team-playbooks.js */
const NAME_MAX = 40
const ENTRIES_MAX = 30

type Entry = { id: string } & Record<string, string>
type Field = { key: string; placeholder: string; max: number; multiline?: boolean; label: string }

/** An entry id the server keeps (ENTRY_ID); randomUUID is missing on a phone over plain http. */
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
const same = (a: Entry[], b: Entry[]) => JSON.stringify(a) === JSON.stringify(b)

/** A list of named texts, edited here and saved as one settings field. */
function GuideList({ title, setting, saved, fields }: { title: string; setting: string; saved: Entry[]; fields: Field[] }) {
  const [draft, setDraft] = useState(saved)
  const [base, setBase] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Saved elsewhere (another window, a phone): follow it unless there are unsaved edits here.
  if (!same(saved, base)) {
    setBase(saved)
    if (same(draft, base)) setDraft(saved)
  }
  const dirty = !same(draft, saved)
  const invalid = draft.some((entry) => !entry.name.trim() || fields.some((field) => (entry[field.key] ?? '').length > field.max))
  const edit = (id: string, patch: Record<string, string>) => setDraft(draft.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
  const add = () => setDraft([...draft, { id: newId(), name: '', ...Object.fromEntries(fields.map((field) => [field.key, ''])) }])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await request('settings.update', { patch: { [setting]: draft } })
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
        <button type="button" className="button ghost" onClick={add} disabled={draft.length >= ENTRIES_MAX}>
          <Plus size={14} /> 追加
        </button>
      </div>
      {draft.map((entry) => (
        <div key={entry.id} className="team-guide">
          <div className="team-guide-head">
            <input value={entry.name} maxLength={NAME_MAX} onChange={(event) => edit(entry.id, { name: event.target.value })}
              placeholder="名前" aria-label={`${title}の名前`} />
            <button type="button" className="icon-button" onClick={() => setDraft(draft.filter((other) => other.id !== entry.id))}
              title="削除" aria-label={`${entry.name || title}を削除`}>
              <Trash2 size={15} />
            </button>
          </div>
          {fields.map((field) => {
            const value = entry[field.key] ?? ''
            const props = {
              value,
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
            <button type="button" className="button" onClick={() => setDraft(saved)} disabled={saving}>元に戻す</button>
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
export function TeamGuides({ policies, playbooks }: { policies: TeamPolicy[]; playbooks: TeamPlaybook[] }) {
  return (
    <>
      <GuideList
        title="方針"
        setting="teamPolicies"
        saved={policies}
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
