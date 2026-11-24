import { Star } from 'lucide-react'
import { act, useStore } from '../store'

/** The Skills button holds at most this many (server/settings.js SKILL_BUTTONS_MAX). */
export const SKILL_BUTTONS_MAX = 5
const EMPTY: string[] = []

/** Starred skill names in the Skills button's order, shared across projects and kinds of task. */
export function useSkillButtons() {
  return useStore((state) => state.server?.settings.skillButtons) ?? EMPTY
}

export function saveSkillButtons(names: string[]) {
  return act('settings.update', { patch: { skillButtons: names } })
}

export function FavoriteSkillButton({ name, menu = false }: { name: string; menu?: boolean }) {
  const buttons = useSkillButtons()
  const favorite = buttons.includes(name)
  const full = !favorite && buttons.length >= SKILL_BUTTONS_MAX
  const label = favorite ? `${name} のお気に入りを解除` : full ? `お気に入りは${SKILL_BUTTONS_MAX}個までです` : `${name} をお気に入りに追加`
  return (
    <button type="button" role={menu ? 'menuitemcheckbox' : undefined} aria-checked={menu ? favorite : undefined}
      aria-pressed={menu ? undefined : favorite} aria-label={label} title={label} disabled={full}
      className={`icon-button small skill-favorite ${favorite ? 'is-favorite' : ''}`}
      // A toggle by name, merged in order on the server, so quick taps do not overwrite each other.
      onClick={() => void act('settings.update', { patch: { favoriteSkills: { [name]: !favorite } } })}>
      <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
    </button>
  )
}
