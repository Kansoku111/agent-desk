import { useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { request, toast, useStore } from '../../store'

const INSTRUCTIONS_MAX = 10_000

/** Standing instructions the agent reads before every task. */
export function PersonalizeSettings() {
  const saved = useStore((state) => state.server?.settings.customInstructions ?? '')
  const [draft, setDraft] = useState(saved)
  const [base, setBase] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Saved elsewhere (another window, a phone): follow it unless there are unsaved edits here.
  if (saved !== base) {
    setBase(saved)
    if (draft === base) setDraft(saved)
  }
  const dirty = draft !== saved
  const tooLong = draft.length > INSTRUCTIONS_MAX

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await request('settings.update', { patch: { customInstructions: draft } })
      toast(draft.trim() ? '指示を保存しました' : '指示を消去しました', 'success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setSaving(false)
  }

  return (
    <div className="settings-section">
      <section className="account-card">
        <div className="account-head">
          <div>
            <h3>カスタム指示</h3>
            <p className="muted">
              ここに書いた指示を、エージェントはすべてのタスクで作業の前に読みます。
              口調、回答の言語、コーディングの方針、毎回守ってほしいルールなどを書いておけます。
            </p>
          </div>
          {saved.trim() && <span className="badge success"><CheckCircle2 size={12} /> 有効</span>}
        </div>
        <textarea
          className="instructions-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && dirty && !tooLong && !saving) {
              event.preventDefault()
              void save()
            }
          }}
          placeholder={'例:\n- 回答は日本語で、結論から簡潔に書いてください。\n- コードのコメントは英語で書いてください。\n- 変更したらテストを実行して結果を報告してください。'}
          aria-label="カスタム指示"
          rows={10}
          spellCheck={false}
        />
        <div className="instructions-footer">
          <span className={tooLong ? 'form-error' : 'fine-print'}>
            {draft.length.toLocaleString()} / {INSTRUCTIONS_MAX.toLocaleString()} 文字
          </span>
          <div className="instructions-actions">
            {dirty && (
              <button type="button" className="button" onClick={() => setDraft(saved)} disabled={saving}>
                元に戻す
              </button>
            )}
            <button type="button" className="button primary" onClick={() => void save()} disabled={!dirty || tooLong || saving}>
              {saving && <Loader2 size={14} className="spin" />} 保存
            </button>
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
        <p className="fine-print">
          保存すると、作業中のものを含むすべてのタスクで、次のメッセージから使われます（作業中のタスクがあるときは、その作業が終わってから反映します）。Claude Code のタスクは、起動し直したときから使われます。
          サブエージェントにも同じ指示が渡ります。会話の中での依頼と食い違うときは、会話の依頼を優先します。
        </p>
      </section>
    </div>
  )
}