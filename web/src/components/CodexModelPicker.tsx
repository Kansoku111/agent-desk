import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import type { CodexModel, CodexTaskSummary } from '../types'
import { codexChoice, type CodexChoice } from '../codex-selection'
import { effortLabel } from '../util'
import { Dropdown, MenuHeading, MenuItem } from './Popover'
import { useWheelSelect } from './useWheelSelect'

interface Draft extends CodexChoice { picked: { model: boolean; effort: boolean } }

export function CodexModelPicker({ task, models, disabled, onChange }: {
  task: CodexTaskSummary
  models: CodexModel[]
  disabled: boolean
  onChange: (choice: CodexChoice) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const latest = useRef({ task, models, disabled, onChange })
  latest.current = { task, models, disabled, onChange }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const queue = useRef(Promise.resolve())
  const desired = useRef<CodexChoice | null>(null)
  const queued = useRef(0)

  const commit = (choice: CodexChoice) => {
    if (latest.current.disabled) return
    desired.current = choice
    queued.current++
    // Model and level are one setting. Serialize wheel updates so a slow reply cannot revert a newer pair.
    queue.current = queue.current.then(async () => {
      const current = latest.current
      if (!alive.current || current.disabled) return
      const valid = codexChoice(current.models, choice.model, choice.effort)
      if (!valid || valid.effort !== choice.effort) return
      if (choice.model === current.task.model && choice.effort === current.task.effort) return
      await current.onChange(choice)
    }).catch(() => {}).finally(() => {
      queued.current--
      if (!queued.current) desired.current = null
    })
  }
  const modelWheel = useWheelSelect<HTMLSpanElement>(disabled || draft ? [] : models.map((model) => model.id), task.model,
    (model) => {
      const choice = codexChoice(latest.current.models, model, desired.current?.effort ?? latest.current.task.effort)
      if (choice) commit(choice)
    })
  const shownModel = modelWheel.pending ? modelWheel.shown : desired.current?.model ?? task.model
  const previewEffort = modelWheel.pending
    ? codexChoice(models, shownModel, desired.current?.effort ?? task.effort)?.effort ?? null
    : desired.current?.effort ?? task.effort
  const efforts = models.find((model) => model.id === shownModel)?.efforts ?? []
  const effortWheel = useWheelSelect<HTMLSpanElement>(disabled || draft ? [] : efforts, previewEffort,
    (effort) => {
      const choice = codexChoice(latest.current.models, modelWheel.pending ? modelWheel.shown : desired.current?.model ?? latest.current.task.model, effort)
      if (choice) commit(choice)
    })
  const shownEffort = modelWheel.pending && !efforts.includes(effortWheel.shown ?? '') ? previewEffort : effortWheel.shown
  const apply = () => {
    if (!draft) return
    setDraft(null)
    commit({ model: draft.model, effort: draft.effort })
  }
  const shownName = models.find((model) => model.id === shownModel)?.name ?? shownModel ?? 'モデルを選択'
  return <Dropdown width={420} portal onClose={apply} trigger={({ open, toggle }) => (
    <button type="button" className={'chip terminal-picker' + (open ? ' active' : '') + (modelWheel.pending || effortWheel.pending ? ' wheeling' : '')}
      disabled={disabled || !models.length} aria-label="モデルと推論の深さ" aria-haspopup="menu" aria-expanded={open} title={disabled ? '作業中・チームの担当はここでは変更できません' : 'モデルと推論の深さ（ホイールでも切り替え）'}
      onClick={() => {
        if (!open) {
          const choice = modelWheel.pending || effortWheel.pending
            ? codexChoice(models, shownModel, effortWheel.shown)
            : desired.current
          // An unavailable saved model remains visible; the menu must still let the user replace it.
          setDraft({ ...(choice ?? { model: shownModel ?? '', effort: task.effort }), picked: { model: false, effort: false } })
          modelWheel.cancel()
          effortWheel.cancel()
        }
        toggle()
      }}>
      <span ref={modelWheel.ref} className="terminal-picker-model">{shownName}</span>
      <span ref={effortWheel.ref} className="terminal-picker-effort"><Brain size={13} />{shownEffort ? effortLabel(shownEffort) : '既定'}</span>
      <ChevronDown size={13} />
    </button>
  )}>{(close) => {
    if (!draft) return null
    const levels = models.find((model) => model.id === draft.model)?.efforts ?? []
    const pick = (choice: CodexChoice, column: 'model' | 'effort') => {
      const updated = { ...choice, picked: { ...draft.picked, [column]: true } }
      setDraft(updated)
      if (updated.picked.model && updated.picked.effort) close()
    }
    return <>
      <div className="terminal-picker-columns">
        <div className="menu-scroll"><MenuHeading>モデル</MenuHeading>{models.map((model) => (
          <MenuItem key={model.id} label={model.name} selected={model.id === draft.model} onSelect={() => {
            const choice = codexChoice(models, model.id, draft.effort)
            if (choice) pick(choice, 'model')
          }} />
        ))}</div>
        <div className="menu-scroll"><MenuHeading>推論の深さ</MenuHeading>{levels.map((effort) => (
          <MenuItem key={effort} label={effortLabel(effort)} selected={effort === draft.effort} onSelect={() => pick({ model: draft.model, effort }, 'effort')} />
        ))}</div>
      </div>
      <div className="menu-footnote">両方を選ぶか、外側を押すと反映します。</div>
    </>
  }}</Dropdown>
}
