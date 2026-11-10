import { Star } from 'lucide-react'
import { act, useStore } from '../store'

export function useFavoriteSkills() {
  const favorites = useStore((state) => state.server?.settings.favoriteSkills)
  return new Set(Object.keys(favorites ?? {}).filter((name) => favorites?.[name] === true))
}

export function FavoriteSkillButton({ name, favorite, menu = false }: { name: string; favorite: boolean; menu?: boolean }) {
  const label = favorite ? `${name} のお気に入りを解除` : `${name} をお気に入りに追加`
  return (
    <button type="button" role={menu ? 'menuitemcheckbox' : undefined} aria-checked={menu ? favorite : undefined}
      aria-pressed={menu ? undefined : favorite} aria-label={label} title={label}
      className={`icon-button small skill-favorite ${favorite ? 'is-favorite' : ''}`}
      onClick={() => void act('settings.update', { patch: { favoriteSkills: { [name]: !favorite } } })}>
      <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
    </button>
  )
}
