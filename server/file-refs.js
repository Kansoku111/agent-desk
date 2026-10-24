// Files the agent mentions in its answers: resolving a reference to a path on
// disk, and opening it the way the user asked (default app or Explorer).
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Extensions never launched directly: opening them would run a program. */
const RUNNABLE = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp',
  '.scr', '.hta', '.lnk', '.url', '.pif', '.cpl', '.jar', '.reg', '.app', '.command', '.sh', '.appref-ms',
  // Scripts an installed interpreter runs when opened, and installers or system handlers.
  '.py', '.pyw', '.pyz', '.pyzw', '.rb', '.rbw', '.pl', '.php', '.ahk', '.au3', '.ws', '.psd1', '.ps1xml',
  '.msix', '.msixbundle', '.appx', '.appxbundle', '.application', '.xbap', '.gadget', '.inf', '.msc', '.mst',
  '.scf', '.settingcontent-ms', '.diagcab', '.library-ms', '.search-ms',
])

export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

export function isRunnable(file) {
  return RUNNABLE.has(path.extname(file).toLowerCase())
}

/**
 * Where a reference may point, most likely first. References come as the
 * agent wrote them: relative to the workspace or absolute, with `/` or `\`,
 * as a `file://` URL, wrapped in quotes or backticks, or with a line
 * (`src/a.ts:42`, `src/a.ts#L42`).
 * @returns {{ file: string, line: number | null }[]}
 */
export function referenceCandidates(ref, workspace) {
  // Decoration around a path: quotes, backticks, brackets, trailing punctuation.
  // A `)` is only decoration when it has no `(` to close, so `New folder (2)` survives.
  const raw = String(ref ?? '').trim()
  let text = raw.replace(/^[`'"<]+/, '')
  const stripTail = (value) => {
    for (;;) {
      const next = value.replace(/[`'">,.;:]+$/, '')
      if (next !== value) value = next
      else if (value.endsWith(')') && value.split(')').length > value.split('(').length) value = value.slice(0, -1)
      else return value
    }
  }
  // The name as written (only quotes and backticks around it removed) comes before the decorated-away
  // reading, so a real "report)" is not turned into "report".
  const literal = text.replace(/[`'">]+$/, '')
  if (!literal || literal.length > 1024 || /[\0\r\n]/.test(literal)) return []
  text = stripTail(text)
  // A leading `(` is decoration in "(src/a.ts)" but part of the name in "(1) a.txt": try the literal name first.
  const starts = []
  for (const base of [literal, text]) {
    starts.push(base)
    if (base.startsWith('(')) starts.push(stripTail(base.replace(/^\(+/, '')))
  }
  const texts = []
  for (let start of new Set(starts)) {
    if (!start) continue
    let decode = true
    if (/^file:\/\//i.test(start)) {
      // fileURLToPath decodes once; a second decode would turn %2520 into a space.
      try {
        const url = new URL(start)
        if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return []
        start = fileURLToPath(start)
        decode = false
      } catch {
        return []
      }
    }
    if (/^https?:|^[a-z][a-z0-9+.-]*:\/\//i.test(start)) return []
    // The path as written comes first; a URL-encoded reading is only a fallback.
    const variants = [start]
    if (decode) {
      try {
        const decoded = decodeURIComponent(start)
        if (decoded !== start) variants.push(decoded)
      } catch {}
    }
    texts.push(...variants)
  }
  if (texts.some((value) => /^[\\/]{2}/.test(value))) return []
  const base = workspace ? path.resolve(workspace) : null
  const candidates = []
  const seen = new Set()
  for (let value of texts) {
    if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(1))
    // Git Bash style (/c/Users/...) on Windows.
    if (process.platform === 'win32' && /^\/[a-z]\//i.test(value)) value = `${value[1]}:${value.slice(2)}`
    const forms = [{ text: value, line: null }]
    const withLine = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(value)
    if (withLine && withLine[1]) forms.push({ text: withLine[1], line: Number(withLine[2] ?? withLine[3]) })
    for (const form of forms) {
      let file
      if (path.isAbsolute(form.text)) file = path.normalize(form.text)
      else if (base) file = path.resolve(base, form.text)
      else continue
      const key = `${file}\0${form.line}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ file, line: form.line })
    }
  }
  return candidates
}

/** The first candidate that exists, with what it is. */
export async function resolveReference(ref, workspace) {
  for (const candidate of referenceCandidates(ref, workspace)) {
    try {
      const stat = await fs.stat(candidate.file)
      return { ...candidate, exists: true, directory: stat.isDirectory() }
    } catch {}
  }
  return { file: null, line: null, exists: false, directory: false }
}
