/**
 * The workspace a picker shows: the user's own pick, else the saved one, else the first
 * listed one. The list can arrive after the picker mounted, so this is derived, not seeded.
 * With no list (free text), whatever was typed or saved is kept.
 */
export function selectedWorkspace(picked: string | null, current: string | null, choices: { id: string }[] | null) {
  const options = choices ?? []
  const listed = (id: string | null) => id !== null && (options.length === 0 || options.some((option) => option.id === id))
  return [picked, current].find(listed) ?? options[0]?.id ?? ''
}
