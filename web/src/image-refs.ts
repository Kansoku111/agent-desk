// Images an answer mentions by path (`generated-images/cat.png`, a link, a bare
// `C:\...\shot.png`) rather than shows with `![](...)`. The answer lists them
// under its text so they need not be opened to be seen. Kept free of imports
// so the tests can load it in Node.

const EXT = '(?:png|jpe?g|gif|webp|svg|bmp|avif)'
/** Where a path ends: not inside a longer name (`a.png.bak`), though a full stop may follow. */
const END = '(?![a-z0-9]|\\.[a-z0-9])'
const IMAGE_PATH = new RegExp(`\\.${EXT}$`, 'i')
/** At most this many previews per answer. */
const LIMIT = 12

interface ImageRefs {
  /** Mentioned by path, in the order they appear. */
  mentioned: string[]
  /** Already shown with `![](...)`; not shown again. */
  shown: string[]
}

/** Blanks out fenced code blocks: paths in commands or output are not meant to be shown. */
function withoutFences(text: string) {
  let fence: string | null = null
  return text.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      return ' '.repeat(line.length)
    }
    if (marker) {
      fence = marker
      return ' '.repeat(line.length)
    }
    return line
  }).join('\n')
}

/** The target of `(target)` or `(<target> "title")` in a link. */
function linkTarget(raw: string) {
  const value = raw.trim()
  if (value.startsWith('<')) return value.slice(1, value.indexOf('>') === -1 ? undefined : value.indexOf('>'))
  return value.split(/\s+/)[0]
}

export function imageRefs(text: string): ImageRefs {
  let body = withoutFences(text)
  const found: { at: number; ref: string }[] = []
  const shown: string[] = []
  /** Records what `pattern` finds and blanks it so later patterns skip it. */
  const take = (pattern: RegExp, use: (match: RegExpExecArray) => void) => {
    body = body.replace(pattern, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpExecArray
      match.index = args.at(-2) as number
      use(match)
      return ' '.repeat(match[0].length)
    })
  }
  const add = (at: number, ref: string) => {
    const value = ref.trim()
    if (IMAGE_PATH.test(value) && !/^(?:https?:|data:)/i.test(value)) found.push({ at, ref: value })
  }

  take(/!\[[^\]\n]*\]\(([^)\n]*)\)/g, (match) => shown.push(linkTarget(match[1])))
  take(/\[[^\]\n]*\]\(([^)\n]*)\)/g, (match) => add(match.index, linkTarget(match[1])))
  take(/`([^`\n]+)`/g, (match) => add(match.index, match[1]))
  take(/\b(?!file:)[a-z][a-z0-9+.-]*:\/\/\S+/gi, () => {})
  take(new RegExp(`file:\\/\\/[^\\s<>"'\`|*?]*?\\.${EXT}${END}`, 'gi'), (match) => add(match.index, match[0]))
  // Absolute Windows paths may hold any letters (C:\Users\me\ダウンロード\a.png), but no spaces.
  take(new RegExp(`(?<![a-z0-9])[a-z]:[\\\\/][^\\s<>"'\`|*?]*?\\.${EXT}${END}`, 'gi'), (match) => add(match.index, match[0]))
  // Other bare paths: ASCII only, so a path written flush against Japanese text still stands alone.
  take(new RegExp(`(?<![\\w.:/\\\\~-])(?:~[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])?(?:[\\w.-]*[\\\\/])*[\\w-][\\w.-]*\\.${EXT}${END}`, 'gi'), (match) => add(match.index, match[0]))

  const mentioned = [...new Set(found.sort((a, b) => a.at - b.at).map((item) => item.ref))].slice(0, LIMIT)
  return { mentioned, shown }
}
