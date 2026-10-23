import { lazy, type ComponentType } from 'react'

const RELOAD_KEY = 'agent-desk-chunk-reload'

/**
 * `lazy` for a screen split into its own file. A rebuild removes the old files,
 * so a page that is older than the build cannot load one: it reloads once to
 * pick up the new build, and shows nothing (instead of crashing) if that fails too.
 */
export function lazyChunk<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const loaded = await load()
      try { sessionStorage.removeItem(RELOAD_KEY) } catch {}
      return loaded
    } catch (error) {
      let reloaded = true
      try {
        reloaded = sessionStorage.getItem(RELOAD_KEY) !== null
        if (!reloaded) sessionStorage.setItem(RELOAD_KEY, '1')
      } catch {}
      if (!reloaded) {
        window.location.reload()
        return new Promise<never>(() => {})
      }
      console.error(error)
      return { default: (() => null) as unknown as T }
    }
  })
}
