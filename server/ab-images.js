import fs from 'node:fs/promises'
import path from 'node:path'
import { IMAGE_TYPES, isImageFile, MAX_ATTACHMENT_BYTES } from './attachments.js'

/** Resolve only uploaded image IDs, never arbitrary local paths or client MIME types. */
export async function abImages(dir, images = []) {
  if (!Array.isArray(images) || images.length > 20) throw new Error('画像は20件以内で指定してください')
  return Promise.all(images.map(async (image) => {
    if (!isImageFile(image?.file)) throw new Error('添付画像の参照が不正です')
    const file = path.join(dir, image.file)
    const stat = await fs.lstat(file).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > MAX_ATTACHMENT_BYTES) throw new Error('添付画像が見つからないか、サイズが不正です')
    const mimeType = Object.keys(IMAGE_TYPES).find((type) => IMAGE_TYPES[type] === path.extname(file).slice(1))
    return { file: image.file, mimeType, name: String(image.name ?? '').slice(0, 200) }
  }))
}

export async function claudeImageBlocks(dir, images) {
  return Promise.all((await abImages(dir, images)).map(async (image) => ({
    type: 'image', source: { type: 'base64', media_type: image.mimeType, data: (await fs.readFile(path.join(dir, image.file))).toString('base64') },
  })))
}

/** Unknown routes are rejected, not treated as text with the images removed. */
export function assertAbImageModels(config, models) {
  for (const key of ['a', 'b', 'leader', ...(config.delegate ? ['implementer'] : [])]) {
    const value = config[key]
    if (!value.startsWith('claude:') && !models.some((model) => model.value === value && ['anthropic', 'openai-codex'].includes(model.provider))) {
      throw new Error('画像付きABではClaude / ChatGPTモデルを選んでください。このモデルの画像入力には対応していません')
    }
  }
}

export function abContextImages(run) {
  return [...new Map([...(run.images ?? []), ...run.messages.flatMap((message) => typeof message === 'string' ? [] : message.images ?? [])].map((image) => [image.file, image])).values()]
}
