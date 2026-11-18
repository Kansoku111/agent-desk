import { Fragment, useId, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2 } from 'lucide-react'
import { getState, request, toast, useStore } from '../../store'
import { messageId } from '../../outbox'
import { INSTRUCTIONS_MAX, INSTRUCTION_TITLE_MAX } from '../../../../shared/text-limits.js'
import type { CustomInstructionItem, Settings } from '../../types'
import './PersonalizeSettings.css'

/** Checkbox order. `dsh` covers dsh and Codex (GP); `short` is the compact tag on a collapsed row. */
const TARGETS = [
  { key: 'dsh', label: 'dsh・Codex（GP）', short: 'dsh・GP' },
  { key: 'claude', label: 'Claude Code（CL）', short: 'CL' },
] as const

/** What the editor changes. `enabled` is not part of it: the switch saves at once. */
type Draft = Pick<CustomInstructionItem, 'title' | 'body' | 'targets'>
type Undo = { item: CustomInstructionItem; index: number }

const draftOf = (item: CustomInstructionItem): Draft => ({ title: item.title, body: item.body, targets: { ...item.targets } })
const sameDraft = (a: Draft, b: Draft) => a.title === b.title && a.body === b.body
  && a.targets.dsh === b.targets.dsh && a.targets.claude === b.targets.claude
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const sameItems = (a: CustomInstructionItem[], b: CustomInstructionItem[]) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** The first reason a draft cannot be saved, or null. `bodyTotal` counts every item's body, off ones included. */
function problemOf(draft: Draft, bodyTotal: number): string | null {
  const title = draft.title.trim()
  if (!title) return '題名を入力してください'
  if (title.length > INSTRUCTION_TITLE_MAX) return `題名は${INSTRUCTION_TITLE_MAX}文字までです`
  if (!draft.targets.dsh && !draft.targets.claude) return '適用先を1つ以上選んでください'
  if (bodyTotal > INSTRUCTIONS_MAX) return `本文は合計${INSTRUCTIONS_MAX.toLocaleString()}文字までです`
  return null
}

function withoutKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record }
  delete next[key]
  return next
}

/** Standing instructions the agent reads before every task (設定 → パーソナライズ). */
export function PersonalizeSettings() {
  const saved = useStore((state) => state.server?.settings.customInstructionItems)
  if (!saved) return null
  return <div className="settings-section"><InstructionList saved={saved} /></div>
}

function InstructionList({ saved }: { saved: CustomInstructionItem[] }) {
  // The list the edits are made against. Another window's save makes it stale; the server checks it too.
  const [base, setBase] = useState(saved)
  const [busy, setBusy] = useState(false)
  // Unsaved edits stay here, so collapsing a row or a stale list never discards them.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [newDraft, setNewDraft] = useState<Draft | null>(null)
  const [undo, setUndo] = useState<Undo | null>(null)
  const stale = !busy && !sameItems(saved, base)
  const locked = busy || stale
  const savedBodies = saved.reduce((sum, item) => sum + item.body.length, 0)

  /** Saves the whole list against `base`. Returns the error message, or null on success. */
  const save = async (next: CustomInstructionItem[]): Promise<string | null> => {
    setBusy(true)
    try {
      const result = await request<{ settings: Settings }>('settings.update', {
        patch: { customInstructionItems: next, customInstructionItemsBase: base },
      })
      setBase(result.settings.customInstructionItems)
      return null
    } catch (cause) {
      // Settings are published before applying runtime changes, which can fail after the save.
      const latest = getState().server?.settings.customInstructionItems
      if (latest && sameItems(latest, next)) {
        setBase(latest)
        toast(messageOf(cause), 'error')
        return null
      }
      return messageOf(cause)
    } finally {
      setBusy(false)
    }
  }

  const setEnabled = (id: string, enabled: boolean) =>
    save(saved.map((item) => item.id === id ? { ...item, enabled } : item))

  const saveEdit = async (id: string, draft: Draft) => {
    const error = await save(saved.map((item) => item.id === id
      ? { ...item, title: draft.title.trim(), body: draft.body, targets: { ...draft.targets } }
      : item))
    // Keep the draft if it was edited while the save was in flight.
    if (!error) setDrafts((current) => current[id] === draft ? withoutKey(current, id) : current)
    return error
  }

  const addNew = async (draft: Draft) => {
    const error = await save([...saved, {
      id: messageId(), title: draft.title.trim(), body: draft.body, enabled: true, targets: { ...draft.targets },
    }])
    if (!error) setNewDraft((current) => current === draft ? null : current)
    return error
  }

  const remove = async (id: string) => {
    const index = saved.findIndex((item) => item.id === id)
    const error = await save(saved.filter((item) => item.id !== id))
    if (error) return error
    setDrafts((current) => withoutKey(current, id))
    setUndo({ item: saved[index], index })
    return null
  }

  // Re-inserts only the deleted item, so edits made since then in this or another window are kept.
  const restore = async () => {
    if (!undo) return null
    const error = await save([...saved.slice(0, undo.index), undo.item, ...saved.slice(undo.index)])
    if (!error) setUndo(null)
    return error
  }

  return (
    <section className="account-card">
      <div className="account-head">
        <h3>カスタム指示</h3>
        <button type="button" className="button" disabled={newDraft !== null}
          onClick={() => setNewDraft({ title: '', body: '', targets: { dsh: true, claude: true } })}>
          <Plus size={14} />追加
        </button>
      </div>
      {stale && (
        <div className="team-warning" role="alert">
          別の画面で変更されました。 <button type="button" className="button small" onClick={() => setBase(saved)}>下書きを残して続ける</button>
        </div>
      )}
      <ul className="instruction-list">
        {saved.map((item, index) => (
          <Fragment key={item.id}>
            {undo && undo.index === index && <UndoRow locked={locked} onRestore={restore} />}
            <InstructionRow
              item={item}
              draft={drafts[item.id]}
              bodyElsewhere={savedBodies - item.body.length}
              locked={locked}
              onDraft={(next) => setDrafts((current) => ({ ...current, [item.id]: next }))}
              onSave={(draft) => saveEdit(item.id, draft)}
              onSwitch={(enabled) => setEnabled(item.id, enabled)}
              onDelete={() => remove(item.id)} />
          </Fragment>
        ))}
        {undo && undo.index >= saved.length && <UndoRow locked={locked} onRestore={restore} />}
        {newDraft && (
          <li className="instruction-item">
            <InstructionEditor draft={newDraft} dirty bodyElsewhere={savedBodies} locked={locked} autoFocus
              onChange={setNewDraft}
              onSave={addNew}
              onCancel={() => setNewDraft(null)} />
          </li>
        )}
      </ul>
      {!saved.length && !newDraft && !undo && <p className="muted instruction-empty">指示はまだありません。</p>}
      <p className="fine-print">dsh は作業終了後、CL は再起動後、GP は新しい会話から反映。</p>
    </section>
  )
}

function InstructionRow({ item, draft, bodyElsewhere, locked, onDraft, onSave, onSwitch, onDelete }: {
  item: CustomInstructionItem
  draft: Draft | undefined
  bodyElsewhere: number
  locked: boolean
  onDraft: (draft: Draft) => void
  onSave: (draft: Draft) => Promise<string | null>
  onSwitch: (enabled: boolean) => Promise<string | null>
  onDelete: () => Promise<string | null>
}) {
  const [open, setOpen] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const panelId = useId()
  const saved = draftOf(item)
  const dirty = draft !== undefined && !sameDraft(draft, saved)
  const title = item.title || '無題'
  const tags = TARGETS.filter((target) => item.targets[target.key]).map((target) => target.short).join(' ')

  return (
    <li className={'instruction-item' + (item.enabled ? '' : ' off')}>
      <div className="instruction-head">
        <button type="button" className="instruction-toggle" aria-expanded={open} aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          <span className="instruction-title">{title}</span>
          {dirty && <span className="instruction-chip">未保存</span>}
          {tags && <span className="instruction-tags">{tags}</span>}
        </button>
        <label className="switch">
          <input type="checkbox" role="switch" aria-label={`${title}を有効にする`} checked={item.enabled} disabled={locked}
            onChange={(event) => void onSwitch(event.target.checked).then(setSwitchError)} />
          <span />
        </label>
      </div>
      {switchError && <p className="form-error">{switchError}</p>}
      {open && (
        <div id={panelId} className="instruction-panel">
          <InstructionEditor draft={draft ?? saved} dirty={dirty} bodyElsewhere={bodyElsewhere} locked={locked}
            onChange={onDraft} onSave={onSave} onDelete={onDelete} />
        </div>
      )}
    </li>
  )
}

/** Fields and footer for an existing item (with delete) or a new one (with cancel). */
function InstructionEditor({ draft, dirty, bodyElsewhere, locked, autoFocus = false, onChange, onSave, onDelete, onCancel }: {
  draft: Draft
  /** An existing item needs a change before it can be saved; a new one is savable once valid. */
  dirty: boolean
  bodyElsewhere: number
  locked: boolean
  autoFocus?: boolean
  onChange: (draft: Draft) => void
  onSave: (draft: Draft) => Promise<string | null>
  onDelete?: () => Promise<string | null>
  onCancel?: () => void
}) {
  const [pending, setPending] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bodyTotal = bodyElsewhere + draft.body.length
  const problem = problemOf(draft, bodyTotal)
  const canSave = !locked && dirty && problem === null && pending === null
  const message = error ?? (autoFocus && !draft.title && !draft.body && bodyTotal <= INSTRUCTIONS_MAX ? null : problem)

  const change = (next: Draft) => {
    setError(null)
    onChange(next)
  }
  const run = async (kind: 'save' | 'delete', action: () => Promise<string | null>) => {
    setPending(kind)
    setError(null)
    const failure = await action()
    setPending(null)
    setError(failure)
  }

  return (
    <div className="instruction-editor">
      <input type="text" value={draft.title} placeholder="題名" aria-label="題名" autoFocus={autoFocus} spellCheck={false}
        onChange={(event) => change({ ...draft, title: event.target.value })} />
      <textarea className="instructions-input" value={draft.body} rows={5} spellCheck={false}
        placeholder="例: 回答は日本語で、結論から書いてください。" aria-label="本文"
        onChange={(event) => change({ ...draft, body: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canSave) {
            event.preventDefault()
            void run('save', () => onSave(draft))
          }
        }} />
      <div className="instruction-target-group" role="group" aria-label="適用先">
        <span className="muted">適用先</span>
        <div className="instruction-targets">
          {TARGETS.map((target) => (
            <label key={target.key} className="instruction-target">
              <input type="checkbox" checked={draft.targets[target.key]}
                onChange={(event) => change({ ...draft, targets: { ...draft.targets, [target.key]: event.target.checked } })} />
              {target.label}
            </label>
          ))}
        </div>
      </div>
      {message && <p className="form-error">{message}</p>}
      <div className="instruction-foot">
        {onDelete && (
          <button type="button" className="icon-button instruction-delete" aria-label="削除" title="削除"
            disabled={locked || pending !== null} onClick={() => void run('delete', onDelete)}>
            <Trash2 size={16} />
          </button>
        )}
        <span className={bodyTotal > INSTRUCTIONS_MAX ? 'form-error' : 'fine-print'}>
          本文の合計 {bodyTotal.toLocaleString()} / {INSTRUCTIONS_MAX.toLocaleString()} 文字
        </span>
        <div className="instruction-actions">
          {onCancel && <button type="button" className="button" disabled={pending !== null} onClick={onCancel}>キャンセル</button>}
          <button type="button" className="button primary" disabled={!canSave} onClick={() => void run('save', () => onSave(draft))}>
            {pending === 'save' && <Loader2 size={14} className="spin" />} 保存
          </button>
        </div>
      </div>
    </div>
  )
}

/** Shown where a deleted item was, until it is restored or another item is deleted. */
function UndoRow({ locked, onRestore }: { locked: boolean; onRestore: () => Promise<string | null> }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <li className="instruction-undo" aria-live="polite">
      <span>削除しました</span>
      <button type="button" className="button small" disabled={locked} onClick={() => void onRestore().then(setError)}>元に戻す</button>
      {error && <p className="form-error">{error}</p>}
    </li>
  )
}
