import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import { request } from '../store'
import { requestErrorMessage } from '../rpc-client'
import { Dropdown, MenuItem } from './Popover'
import { FavoriteSkillButton, useSkillButtons } from './SkillFavorites'

interface Skill { name: string; description: string }

/** Where the list comes from: each kind of task offers the skills its own agent can open. */
export type SkillSource =
  | { kind: 'dsh'; workspace: string; threadId?: string }
  | { kind: 'claude'; terminalId: string }
  | { kind: 'codex'; taskId: string }

const sourceKey = (source: SkillSource) => source.kind === 'dsh' ? `dsh:${source.threadId ?? ''}:${source.workspace}`
  : source.kind === 'claude' ? `claude:${source.terminalId}` : `codex:${source.taskId}`

function fetchSkills(source: SkillSource) {
  const call = source.kind === 'dsh' ? request<{ skills: Skill[] }>('skills.list', { workspace: source.workspace, threadId: source.threadId })
    : source.kind === 'claude' ? request<{ skills: Skill[] }>('terminal.skills', { terminalId: source.terminalId })
      : request<{ skills: Skill[] }>('codex.skills', { taskId: source.taskId })
  return call.then((result) => result.skills)
}

/**
 * Puts a skill into a message: dsh and Codex read `/name` / `$name` anywhere, Claude Code only
 * a command at the start of the message (a leading command that is a listed skill is replaced).
 */
export function insertSkill(kind: SkillSource['kind'], text: string, start: number, end: number, name: string, known: string[] = []) {
  if (kind === 'claude') {
    const leading = /^\/(\S+)\s*/.exec(text)
    const rest = leading && known.includes(leading[1]) ? text.slice(leading[0].length) : text
    const insertion = `/${name} `
    return { text: insertion + rest, caret: insertion.length }
  }
  const before = text.slice(0, start)
  const after = text.slice(end)
  const insertion = `${before && !/\s$/.test(before) ? ' ' : ''}${kind === 'codex' ? '$' : '/'}${name}${/^\s/.test(after) ? '' : ' '}`
  return { text: before + insertion + after, caret: start + insertion.length }
}

function SkillList({ skills, error, onSelect }: { skills: Skill[] | null; error: string | null; onSelect: (name: string) => void }) {
  const buttons = useSkillButtons()
  if (error) return <div className="menu-empty" role="alert">skills を取得できませんでした。{error}</div>
  if (!skills) return <div className="menu-empty">読み込み中…</div>
  if (!skills.length) return <div className="menu-empty">利用できる skills はありません</div>
  const starred = buttons.flatMap((name) => skills.filter((skill) => skill.name === name))
  const ordered = [...starred, ...skills.filter((skill) => !buttons.includes(skill.name))]
  return <div className="menu-scroll">{ordered.map((skill) => (
    <div className="skill-picker-row" key={skill.name}>
      <MenuItem label={skill.name} description={skill.description.replace(/\s+/g, ' ').slice(0, 120)} onSelect={() => onSelect(skill.name)} />
      <FavoriteSkillButton name={skill.name} menu />
    </div>
  ))}</div>
}

const CURRENT_KEY = 'agent-desk.skill-button'
const HOLD_MS = 350
const STEP_PX = 44

/**
 * The composer's Skills control. With starred skills it is one button for them: a tap puts in
 * the current one; a swipe, or a press held and dragged, moves through the starred ones and
 * puts in the one let go on. The chevron keeps the full list.
 */
export function SkillPicker({ source, onSelect }: { source: SkillSource; onSelect: (name: string, known: string[]) => void }) {
  const key = sourceKey(source)
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const buttons = useSkillButtons()
  const [current, setCurrent] = useState(() => localStorage.getItem(CURRENT_KEY) ?? '')
  const [slide, setSlide] = useState<number | null>(null)
  const gesture = useRef<{ id: number; x: number; y: number; from: number; timer: number; sliding: boolean } | null>(null)
  const swallowClick = useRef(false)

  const load = () => {
    let active = true
    setError(null)
    fetchSkills(source).then((list) => { if (active) setSkills(list) })
      .catch((reason) => { if (active) setError(requestErrorMessage(reason)) })
    return () => { active = false }
  }
  useEffect(() => { setSkills(null); return load() }, [key])

  const names = skills?.map((skill) => skill.name) ?? []
  const slots = buttons.filter((name) => names.includes(name))
  const index = Math.max(0, slots.indexOf(current))
  const choose = (name: string) => {
    setCurrent(name)
    localStorage.setItem(CURRENT_KEY, name)
    onSelect(name, names)
  }

  const end = () => {
    if (gesture.current) clearTimeout(gesture.current.timer)
    gesture.current = null
    setSlide(null)
  }
  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // A long press can end without a click on touch screens; never swallow the next tap.
    swallowClick.current = false
    if (slots.length < 2 || (event.pointerType === 'mouse' && event.button !== 0)) return
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* the pointer is already gone */ }
    const from = index
    const timer = window.setTimeout(() => {
      if (gesture.current) { gesture.current.sliding = true; setSlide(from) }
    }, HOLD_MS)
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, from, timer, sliding: false }
  }
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = gesture.current
    if (!state || state.id !== event.pointerId) return
    const dx = event.clientX - state.x
    if (!state.sliding) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(event.clientY - state.y)) return
      state.sliding = true
      clearTimeout(state.timer)
    }
    setSlide(Math.min(slots.length - 1, Math.max(0, state.from + Math.round(dx / STEP_PX))))
  }
  const up = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = gesture.current
    if (!state || state.id !== event.pointerId) return
    if (state.sliding) {
      swallowClick.current = true
      const target = slots[slide ?? state.from]
      end()
      if (target) choose(target)
      return
    }
    end()
  }

  const list = (
    <Dropdown width={320} trigger={({ open, toggle }) => (
      slots.length
        ? <button type="button" className={`chip skill-more ${open ? 'active' : ''}`} onClick={() => { if (!open) load(); toggle() }}
          aria-label="Skills の一覧" aria-expanded={open} title="Skills の一覧"><ChevronDown size={13} /></button>
        : <button type="button" className={`chip ${open ? 'active' : ''}`} onClick={() => { if (!open) load(); toggle() }} aria-label="Skills" aria-expanded={open}>
          <Sparkles size={13} /><span>Skills</span><ChevronDown size={13} />
        </button>
    )}>
      {(close) => <SkillList skills={skills} error={error} onSelect={(name) => { close(); onSelect(name, names) }} />}
    </Dropdown>
  )
  if (!slots.length) return <div className="skill-button">{list}</div>
  const shown = slots[slide ?? index]
  return (
    <div className="skill-button">
      {slide !== null && (
        <div className="skill-slider" aria-hidden="true">
          {slots.map((name, at) => <span key={name} className={at === slide ? 'on' : ''}>{name}</span>)}
        </div>
      )}
      <button type="button" className={`chip skill-current ${slide !== null ? 'active' : ''}`}
        aria-label={`${shown} を入力`} title={slots.length > 1 ? `${shown}（左右にスライドで切り替え）` : shown}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={end} onLostPointerCapture={() => { if (gesture.current) end() }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (slots.length < 2 || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
          event.preventDefault()
          const next = slots[(index + (event.key === 'ArrowRight' ? 1 : slots.length - 1)) % slots.length]
          setCurrent(next)
          localStorage.setItem(CURRENT_KEY, next)
        }}
        onClick={() => {
          if (swallowClick.current) { swallowClick.current = false; return }
          choose(shown)
        }}>
        <Sparkles size={13} /><span>{shown}</span>
        {slots.length > 1 && <i className="skill-dots">{slots.map((name, at) => <b key={name} className={at === (slide ?? index) ? 'on' : ''} />)}</i>}
      </button>
      {list}
    </div>
  )
}
