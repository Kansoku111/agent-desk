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
  let text = String(ref ?? '').trim().replace(/^[`'"<(]+|[`'">),.;:]+$/g, '')
  if (!text || text.length > 1024 || /[\0\r\n]/.test(text)) return []
  if (/^file:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return []
      text = fileURLToPath(text)
    } catch {
      return []
    }
  }
  if (/^https?:|^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return []
  try {
    text = decodeURIComponent(text)
  } catch {}
  if (/^[\\/]{2}/.test(text)) return []
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(1))
  // Git Bash style (/c/Users/...) on Windows.
  if (process.platform === 'win32' && /^\/[a-z]\//i.test(text)) text = `${text[1]}:${text.slice(2)}`
  const forms = [{ text, line: null }]
  const withLine = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(text)
  if (withLine && withLine[1]) forms.push({ text: withLine[1], line: Number(withLine[2] ?? withLine[3]) })
  const base = workspace ? path.resolve(workspace) : null
  const candidates = []
  for (const form of forms) {
    if (path.isAbsolute(form.text)) candidates.push({ file: path.normalize(form.text), line: form.line })
    else if (base) candidates.push({ file: path.resolve(base, form.text), line: form.line })
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
