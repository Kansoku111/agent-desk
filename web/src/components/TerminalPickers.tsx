import { useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { act, useStore } from '../store'
import type { AppState, TerminalSummary } from '../types'
import { isModelVisible } from '../model-selection'
import { effortLabel, pickableEfforts } from '../util'
import { byNewest } from './Pickers'
import { Dropdown, MenuHeading, MenuItem } from './Popover'
import { useWheelSelect } from './useWheelSelect'

/** The levels `claude --effort` takes. */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/**
 * Claude Code's own aliases: they follow the newest model of each family.
 * Offered for a family the model list does not have, where they would only repeat a named model.
 */
const ALIASES = [
  { id: 'opus', name: 'Opus（最新）' },
  { id: 'sonnet', name: 'Sonnet（最新）' },
  { id: 'haiku', name: 'Haiku（最新）' },
]
const NOTE = '両方を選ぶか、外側を押すと反映します。待機中なら会話を引き継いで Claude Code を起動し直します。このタスクだけに効き、Claude Code の既定の設定は変わりません。'

const family = (id: string) => ALIASES.findIndex((alias) => id.includes(alias.id))

/** Claude models from the model list (Claude Code takes their ids, claude-opus-5-5), Opus first. */
export function claudeModels(server: AppState | null) {
  const listed = server ? server.catalog.models.filter((model) => model.provider === 'anthropic'
    && isModelVisible(server, { ...model, value: `claude:${model.id}` })) : []
  const rank = (id: string) => (family(id) < 0 ? ALIASES.length : family(id))
  listed.sort((a, b) => rank(a.id) - rank(b.id) || byNewest(a, b))
  const aliases = ALIASES.filter((alias) => (!server || isModelVisible(server, { value: `claude:${alias.id}` }))
    && !listed.some((model) => model.id.includes(alias.id)))
  return [...aliases, ...listed]
}

/** A model's name without the "Claude" every entry here shares. */
export function claudeModelName(server: AppState | null, id: string | null) {
  if (!id) return null
  const name = ALIASES.find((alias) => alias.id === id)?.name
    ?? server?.catalog.models.find((model) => model.provider === 'anthropic' && model.id === id)?.name
    ?? id
  return name.replace(/^Claude\s+/, '')
}

/** The levels a model has, as the model list knows them; else all of Claude Code's. */
export function claudeEfforts(server: AppState | null, model: string | null) {
  const known = model ? server?.catalog.effortsByModel[JSON.stringify(['anthropic', model])] : undefined
  return known ? pickableEfforts(known).map((effort) => effort.value).filter((value) => CLAUDE_EFFORTS.includes(value)) : CLAUDE_EFFORTS
}

function configure(terminal: TerminalSummary, patch: { model?: string | null; effort?: string | null }) {
  void act('terminal.configure', { terminalId: terminal.id, ...patch })
}

/** What is being chosen in the open panel ('' is Claude Code's default), and which columns were touched. */
interface Draft {
  model: string
  effort: string
  picked: { model: boolean; effort: boolean }
}

/**
 * One chip for the model and the reasoning level: its panel lists models on
 * the left and levels on the right, and choosing one of each applies both in
 * a single restart of Claude Code. The wheel over either half of the chip
 * steps that half on its own.
 */
export function TerminalModelPicker({ terminal }: { terminal: TerminalSummary }) {
  const server = useStore((state) => state.server)
  const [draft, setDraft] = useState<Draft | null>(null)
  const models = claudeModels(server)
  const busy = terminal.state !== 'running'
    ? null
    : terminal.activity !== 'idle'
      ? '作業中は変更できません'
      : terminal.background > 0 ? '裏で作業中は変更できません' : null
  const efforts = claudeEfforts(server, terminal.model ?? terminal.modelInUse)
  // Nothing to step through while Claude Code is working.
  const modelWheel = useWheelSelect<HTMLSpanElement>(busy ? [] : ['', ...models.map((model) => model.id)], terminal.model ?? '',
    (value) => configure(terminal, { model: value || null }))
  const effortWheel = useWheelSelect<HTMLSpanElement>(busy ? [] : ['', ...efforts], terminal.effort ?? '',
    (value) => configure(terminal, { effort: value || null }))
  const shownModel = modelWheel.pending ? modelWheel.shown : terminal.model ?? terminal.modelInUse
  const shownEffort = effortWheel.pending ? effortWheel.shown : terminal.effort ?? terminal.effortInUse

  const apply = () => {
    if (!draft) return
    setDraft(null)
    const model = draft.model || null
    const effort = draft.effort || null
    const patch = {
      ...(model !== (terminal.model ?? null) ? { model } : null),
      ...(effort !== (terminal.effort ?? null) ? { effort } : null),
    }
    if (Object.keys(patch).length) configure(terminal, patch)
  }

  return (
    <Dropdown
      width={420}
      onClose={apply}
      trigger={({ toggle, open }) => (
        <button
          type="button"
          className={`chip terminal-picker ${open ? 'active' : ''} ${modelWheel.pending || effortWheel.pending ? 'wheeling' : ''}`}
          onClick={() => {
            if (!open) setDraft({ model: terminal.model ?? '', effort: terminal.effort ?? '', picked: { model: false, effort: false } })
            toggle()
          }}
          disabled={Boolean(busy)}
          title={busy ?? 'モデルと推論の深さ（ホイールでも切り替え）'}
        >
          <span ref={modelWheel.ref} className="terminal-picker-model">{claudeModelName(server, shownModel || null) ?? 'Claude Code の既定'}</span>
          <span ref={effortWheel.ref} className="terminal-picker-effort">
            <Brain size={13} />
            {shownEffort ? effortLabel(shownEffort) : '既定'}
          </span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => {
        if (!draft) return null
        const levels = claudeEfforts(server, draft.model || terminal.modelInUse)
        const pick = (next: Partial<Pick<Draft, 'model' | 'effort'>>, column: 'model' | 'effort') => {
          const updated = { ...draft, ...next, picked: { ...draft.picked, [column]: true } }
          // A level the new model does not have falls back to Claude Code's default.
          if (column === 'model' && updated.effort && !claudeEfforts(server, updated.model || terminal.modelInUse).includes(updated.effort)) {
            updated.effort = ''
          }
          setDraft(updated)
          if (updated.picked.model && updated.picked.effort) close()
        }
        return (
          <>
            <div className="terminal-picker-columns">
              <div className="menu-scroll">
                <MenuHeading>モデル</MenuHeading>
                <MenuItem
                  label="既定"
                  description={terminal.modelInUse && !terminal.model ? `今は ${claudeModelName(server, terminal.modelInUse)}` : 'Claude Code の設定'}
                  selected={!draft.model}
                  onSelect={() => pick({ model: '' }, 'model')}
                />
                {models.map((model) => (
                  <MenuItem
                    key={model.id}
                    label={claudeModelName(server, model.id)}
                    selected={model.id === draft.model}
                    onSelect={() => pick({ model: model.id }, 'model')}
                  />
                ))}
              </div>
              <div className="menu-scroll">
                <MenuHeading>推論の深さ</MenuHeading>
                <MenuItem
                  label="既定"
                  description={terminal.effortInUse && !terminal.effort ? `今は ${effortLabel(terminal.effortInUse)}` : 'Claude Code の設定'}
                  selected={!draft.effort}
                  onSelect={() => pick({ effort: '' }, 'effort')}
                />
                {levels.map((effort) => (
                  <MenuItem
                    key={effort}
                    label={effortLabel(effort)}
                    selected={effort === draft.effort}
                    onSelect={() => pick({ effort }, 'effort')}
                  />
                ))}
              </div>
            </div>
            <div className="menu-footnote">{NOTE}</div>
          </>
        )
      }}
    </Dropdown>
  )
}
