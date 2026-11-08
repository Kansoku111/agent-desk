// Files the user attaches to a message. Images go to the model as pictures;
// any other file is saved under its own name and the agent gets its path.
import fs from 'node:fs/promises'
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
  if (safe.length > 120) {
    const ext = path.extname(safe).slice(0, 20)
    safe = (safe.slice(0, 120 - ext.length) + ext).replace(/[. ]+$/, '')
  }
  if (!safe || /^\.+$/.test(safe)) safe = 'file'
  if (RESERVED.test(safe)) safe = `_${safe}`
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

// imagegen.js puts a copy of each generated image here and names it on this line.
const PREVIEW_LINE = /\[agent-desk-preview\] ([a-f0-9-]+\.(?:png|jpg|gif|webp))/g

/** The attachments a task's turns show: the user's files and the image previews its tools made. */
export function turnAttachments(turns) {
  const files = new Set()
  const add = (images) => {
    for (const image of Array.isArray(images) ? images : []) if (isImageFile(image?.file) || isOtherFile(image?.file)) files.add(image.file)
  }
  for (const turn of Array.isArray(turns) ? turns : []) {
    add(turn?.user?.images)
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type === 'steer') add(item.images)
      if (item?.type !== 'tool' || item.output == null) continue
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
      for (const match of output.matchAll(PREVIEW_LINE)) files.add(match[1])
    }
  }
  return [...files]
}

/** Deletes attachments. A non-image upload is the only file in its own folder, so the folder goes with it. */
export async function removeAttachments(dir, files, log = () => {}) {
  for (const file of files) {
    const full = attachmentPath(dir, file)
    if (!full) continue
    await fs.rm(isImageFile(file) ? full : path.dirname(full), { recursive: true, force: true })
      .catch((error) => log(`attachment ${file}:`, error.message))
  }
}

/** The text that tells the agent where the attached files are. */
export function fileListText(dir, files) {
  if (!files.length) return ''
  const lines = files.map((entry) => `- ${attachmentPath(dir, entry.file)}`)
  return `[添付ファイル]\n${lines.join('\n')}`
}
