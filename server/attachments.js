// Files the user attaches to a message. Images go to the model as pictures;
// any other file is saved under its own name and the agent gets its path.
import path from 'node:path'

/** Image types the model reads directly, and the extension each is saved with. */
export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

const IMAGE_FILE = /^[a-f0-9-]+\.(png|jpg|gif|webp)$/
const OTHER_FILE = /^[a-f0-9-]{36}\/([^/\\:*?"<>|\0-\x1f]+)$/
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

/** A file name safe to create on Windows, keeping as much of the original as possible. */
export function safeFileName(name) {
  let safe = String(name ?? '').replace(/[/\\:*?"<>|\0-\x1f]/g, '_').replace(/[. ]+$/, '').trim()
  if (!safe || /^\.+$/.test(safe)) safe = 'file'
  if (RESERVED.test(safe)) safe = `_${safe}`
  if (safe.length > 120) {
    const ext = path.extname(safe).slice(0, 20)
    safe = safe.slice(0, 120 - ext.length) + ext
  }
  return safe
}

/** Where a non-image attachment is stored, relative to the attachments folder. */
export function otherFileId(uuid, name) {
  return `${uuid}/${safeFileName(name)}`
}

export function isImageFile(file) {
  return typeof file === 'string' && IMAGE_FILE.test(file)
}

export function isOtherFile(file) {
  if (typeof file !== 'string') return false
  const match = OTHER_FILE.exec(file)
  return Boolean(match) && !/^\.+$/.test(match[1])
}

/** The attachment's path on disk, or null for a name the server never made. */
export function attachmentPath(dir, file) {
  if (isImageFile(file)) return path.join(dir, file)
  if (isOtherFile(file)) return path.join(dir, ...file.split('/'))
  return null
}

/** The text that tells the agent where the attached files are. */
export function fileListText(dir, files) {
  if (!files.length) return ''
  const lines = files.map((entry) => `- ${attachmentPath(dir, entry.file)}`)
  return `[添付ファイル]\n${lines.join('\n')}`
}
