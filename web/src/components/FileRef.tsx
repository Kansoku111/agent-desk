// Files the agent mentions: a path in an answer, an image it shows, a file it
// changed. One that exists on disk becomes clickable — a click offers open /
// show in Explorer / copy path, Ctrl+click (⌘+click) opens it. On a phone the
// file is on the PC, so the menu only copies the path or shows an image.
import { useEffect, useRef, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import { Copy, ExternalLink, FolderOpen, Image as ImageIcon } from 'lucide-react'
import { act, getState, request, toast, token } from '../store'
import { copyText } from '../util'
import { MenuItem } from './Popover'

interface FileInfo {
  file: string
  line: number | null
  directory: boolean
}

const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent)
const EXPLORER = IS_MAC ? 'Finder で表示' : 'エクスプローラーで表示'
const isUncPath = (value: string) => /^[\\/]{2}/.test(value)

/** Text that could be a path: has a folder separator or a file extension, and is not a URL. */
export function looksLikePath(text: string) {
  const value = text.trim()
  if (!value || value.length > 400 || /[\r\n<>|*?]/.test(value) || isUncPath(value)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^file:\/\//i.test(value)) return false
  if (/^[a-z]:[\\/]/i.test(value) || /^file:\/\//i.test(value)) return true
  if (/\s/.test(value)) return false
  if (/^[@#$%]/.test(value) || /^[\w-]+\(.*\)$/.test(value)) return false
  return /[\\/]/.test(value) || /\.[a-z][a-z0-9]{0,7}(?::\d+(?::\d+)?|#L\d+)?$/i.test(value)
}

// ------------------------------------------------------------------ existence cache

/** What the server said (null: no such file) and when; a miss is asked again later, as the agent may create it. */
const known = new Map<string, { info: FileInfo | null; at: number; ttl?: number }>()
const inflight = new Set<string>()
const MISS_TTL = 10_000
const ERROR_TTL = 3_000
const waiting = new Map<string, Set<string>>()
const listeners = new Set<() => void>()
let version = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

const keyOf = (workspace: string | null, ref: string) => `${workspace ?? ''}\n${ref}`

function flush() {
  flushTimer = null
  const batches = [...waiting.entries()]
  waiting.clear()
  for (const [workspace, refs] of batches) {
    const list = [...refs]
    request<{ files: Record<string, FileInfo | null> }>('file.stat', { refs: list, workspace: workspace || null })
      .then(({ files }) => {
        for (const ref of list) known.set(keyOf(workspace || null, ref), { info: files[ref] ?? null, at: Date.now() })
      })
      .catch(() => {
        const at = Date.now()
        for (const ref of list) known.set(keyOf(workspace || null, ref), { info: null, at, ttl: ERROR_TTL })
      })
      .finally(() => {
        for (const ref of list) inflight.delete(keyOf(workspace || null, ref))
        version += 1
        for (const listener of listeners) listener()
      })
  }
}

function ask(workspace: string | null, ref: string) {
  if (isUncPath(ref)) return
  const key = keyOf(workspace, ref)
  const entry = known.get(key)
  if (inflight.has(key) || (entry && (entry.info || Date.now() - entry.at < (entry.ttl ?? MISS_TTL)))) return
  inflight.add(key)
  const set = waiting.get(workspace ?? '') ?? new Set<string>()
  set.add(ref)
  waiting.set(workspace ?? '', set)
  flushTimer ??= setTimeout(flush, 30)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What a reference points at, once the server has looked; null while unknown or missing. */
export function useFileInfo(ref: string | null | undefined, workspace: string | null) {
  return useFileInfos(ref ? [ref] : [], workspace)[0] ?? null
}

/** useFileInfo for several references at once, in the same order. */
export function useFileInfos(refs: readonly string[], workspace: string | null) {
  const infos = refs.map((ref) => isUncPath(ref) ? null : known.get(keyOf(workspace, ref))?.info ?? null)
  // What the server said about a file never changes once it exists, so only references still
  // unresolved (and asked again later) follow the lookups that finish; the others stay put.
  const unresolved = infos.some((info, index) => !info && !isUncPath(refs[index]))
  useSyncExternalStore(subscribe, () => (unresolved ? version : -1))
  useEffect(() => {
    refs.forEach((ref, index) => {
      if (!infos[index] && !isUncPath(ref)) ask(workspace, ref)
    })
  })
  return infos
}

/** Images the server shows by path (see IMAGE_TYPES in server/file-refs.js). */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

/** URL of a local image for an <img>. */
export function localImageUrl(file: string) {
  return `/local-image?t=${encodeURIComponent(token ?? '')}&path=${encodeURIComponent(file)}`
}

// ------------------------------------------------------------------ actions and menu

export async function openRef(ref: string, workspace: string | null, how: 'open' | 'reveal') {
  const result = await act<{ revealed: boolean }>('file.open', { ref, workspace, how })
  if (result?.revealed) toast('実行ファイルは直接開かず、場所を表示しました')
}

interface MenuState {
  x: number
  y: number
  ref: string
  workspace: string | null
  info: FileInfo
}

let menu: MenuState | null = null
const menuListeners = new Set<() => void>()
function setMenu(next: MenuState | null) {
  menu = next
  for (const listener of menuListeners) listener()
}

/** The one floating file menu; mounted once at the app root. */
export function FileMenuHost() {
  const current = useSyncExternalStore((listener) => {
    menuListeners.add(listener)
    return () => menuListeners.delete(listener)
  }, () => menu)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!current) return
    const close = (event: Event) => {
      if (event.type === 'mousedown' && panel.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    document.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [current])

  if (!current) return null
  const { ref, workspace, info } = current
  const width = 260
  const left = Math.max(8, Math.min(current.x, window.innerWidth - width - 8))
  const top = Math.min(current.y + 6, window.innerHeight - 200)
  const run = (how: 'open' | 'reveal') => {
    setMenu(null)
    void openRef(ref, workspace, how)
  }
  const remote = getState().server?.app.remote
  return (
    <div ref={panel} className="menu file-menu" role="menu" style={{ left, top, width }}>
      <div className="menu-heading file-menu-path" title={info.file}><span dir="ltr">{info.file}</span></div>
      {!remote && <MenuItem icon={<ExternalLink size={15} />} label="開く" hint={IS_MAC ? '⌘+クリック' : 'Ctrl+クリック'} onSelect={() => run('open')} />}
      {!remote && <MenuItem icon={<FolderOpen size={15} />} label={EXPLORER} onSelect={() => run('reveal')} />}
      {remote && IMAGE_FILE.test(info.file) && (
        <MenuItem
          icon={<ImageIcon size={15} />}
          label="画像を表示"
          onSelect={() => {
            setMenu(null)
            window.open(localImageUrl(info.file), '_blank', 'noopener')
          }}
        />
      )}
      <MenuItem
        icon={<Copy size={15} />}
        label="パスをコピー"
        onSelect={() => {
          setMenu(null)
          copyText(info.file).then(() => toast('パスをコピーしました', 'success'), () => toast('コピーできませんでした', 'error'))
        }}
      />
    </div>
  )
}

// ------------------------------------------------------------------ the clickable wrapper

/**
 * Makes `children` act on the file `refText` names, when it exists; otherwise
 * renders them unchanged.
 */
export function FileRef({ refText, workspace, children, className = '' }: {
  refText: string | null | undefined
  workspace: string | null
  children: ReactNode
  className?: string
}) {
  const info = useFileInfo(refText, workspace)
  if (!info || !refText) return <>{children}</>
  // A phone cannot open the PC's files; its click always shows the menu.
  const openDirect = (event: { ctrlKey: boolean; metaKey: boolean }) => (event.ctrlKey || event.metaKey) && !getState().server?.app.remote
  const showMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, ref: refText, workspace, info })
  }
  return (
    <span
      className={`file-ref ${className}`}
      role="button"
      tabIndex={0}
      title={`${info.file}\nクリック: メニュー / ${IS_MAC ? '⌘' : 'Ctrl'}+クリック: 開く`}
      onClick={(event) => {
        if (openDirect(event)) {
          event.preventDefault()
          event.stopPropagation()
          void openRef(refText, workspace, 'open')
        } else {
          showMenu(event)
        }
      }}
      onContextMenu={showMenu}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        const box = event.currentTarget.getBoundingClientRect()
        if (openDirect(event)) void openRef(refText, workspace, 'open')
        else setMenu({ x: box.left, y: box.bottom, ref: refText, workspace, info })
      }}
    >
      {children}
    </span>
  )
}
