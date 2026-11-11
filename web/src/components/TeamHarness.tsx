import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { request, toast, useStore } from '../store'

/** server/team-harness.js */
const HARNESS_MAX = 10_000

type Key = 'teamParentHarness' | 'teamChildHarness'

function HarnessCard({ setting, title, placeholder }: { setting: Key; title: string; placeholder: string }) {
  const saved = useStore((state) => state.server?.settings[setting] ?? '')
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
  const tooLong = draft.length > HARNESS_MAX

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
      <div className="account-head"><h3>{title}</h3></div>
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
        placeholder={placeholder}
        aria-label={title}
        rows={6}
        spellCheck={false}
      />
      {(dirty || tooLong) && (
        <div className="instructions-footer">
          <span className={tooLong ? 'form-error' : 'fine-print'}>
            {draft.length.toLocaleString()} / {HARNESS_MAX.toLocaleString()} 文字
          </span>
          <div className="instructions-actions">
            <button type="button" className="button" onClick={() => setDraft(saved)} disabled={saving}>元に戻す</button>
            <button type="button" className="button primary" onClick={() => void save()} disabled={!dirty || tooLong || saving}>
              {saving && <Loader2 size={14} className="spin" />} 保存
            </button>
          </div>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}

/** 設定 → エージェントチーム: what only the parents, or only the children, of TM, eco and AB read. */
export function TeamHarness() {
  return (
    <>
      <HarnessCard setting="teamParentHarness" title="親ハーネス"
        placeholder={'TM・eco のリーダー、AB の判断リーダーだけが読みます。\n例:\n- 設計とレビューは Claude の中枠、量の多い作業は GPT の低枠\n- 子への依頼には受け入れ条件を必ず書く'} />
      <HarnessCard setting="teamChildHarness" title="子ハーネス"
        placeholder={'TM・eco の子、AB の相談役と実装担当だけが読みます。\n例:\n- 報告は 5 行以内\n- 変更前に関連テストを読む'} />
    </>
  )
}
