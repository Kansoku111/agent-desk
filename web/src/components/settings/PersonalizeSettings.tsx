import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { request, toast, useStore } from '../../store'

const INSTRUCTIONS_MAX = 10_000

/** Standing instructions the agent reads before every task. */
export function PersonalizeSettings() {
  const saved = useStore((state) => state.server?.settings.customInstructions ?? '')
  const enabled = useStore((state) => state.server?.settings.customInstructionsEnabled !== false)
  const [toggling, setToggling] = useState(false)
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

  const toggle = async (enabled: boolean) => {
    setToggling(true)
    setError(null)
    try {
      await request('settings.update', { patch: { customInstructionsEnabled: enabled } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setToggling(false)
  }

  return (
    <div className="settings-section">
      <section className="account-card">
        <div className="account-head">
          <div>
            <h3>カスタム指示</h3>
            <p className="muted">すべてのタスクとサブエージェントが作業前に読みます。</p>
          </div>
          <label className="switch">
            <input type="checkbox" role="switch" aria-label="カスタム指示" checked={enabled} disabled={toggling} onChange={(event) => void toggle(event.target.checked)} />
            <span />
          </label>
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
        <p className="fine-print">dsh は待機後、Claude Code は再起動後に反映。会話での依頼が優先です。</p>
      </section>
    </div>
  )
}