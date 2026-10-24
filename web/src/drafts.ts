// Unsent text a message field keeps while its view is away. A field is keyed by
// what it writes to (a task, a team child), so going to another session and
// back finds the text where it was left. Kept in memory: a reload clears it.
import { useReducer, useRef } from 'react'

const drafts = new Map<string, string>()

export const getDraft = (key: string) => drafts.get(key) ?? ''

export function setDraft(key: string, value: string) {
  if (value) drafts.set(key, value)
  else drafts.delete(key)
}

/** The text of the field for `key`, read from the store on each render, so a new key never shows the old text. */
export function useDraft(key: string) {
  const [, redraw] = useReducer((count: number) => count + 1, 0)
  const update = (value: string) => {
    setDraft(key, value)
    redraw()
  }
  return [getDraft(key), update] as const
}

/**
 * A message field whose send button keeps the keyboard up. Text the IME has not
 * confirmed yet (iOS live conversion keeps a whole sentence so) stays with the
 * keyboard, and iOS writes it back after the send empties the field. `confirm`,
 * called as the button is pressed, settles it into the field first by moving
 * the focus away and straight back.
 */
export function useImeField() {
  const field = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const confirm = () => {
    const element = field.current
    if (!composing.current || !element) return
    composing.current = false
    element.blur()
    element.focus({ preventScroll: true })
  }
  const fieldProps = {
    ref: field,
    onCompositionStart: () => { composing.current = true },
    onCompositionEnd: () => { composing.current = false },
  }
  return { fieldProps, confirm }
}
