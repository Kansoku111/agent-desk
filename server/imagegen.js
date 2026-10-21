// Image generation through OpenAI's official bundled Codex app-server.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
export const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']
export const QUALITIES = ['auto', 'low', 'medium', 'high']
export const BACKGROUNDS = ['auto', 'opaque', 'transparent']
export const FORMATS = ['png', 'jpeg', 'webp']
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
export const MAX_REFERENCES = 4
export const IMAGE_TIMEOUT_MS = 5 * 60_000
export function fileStem(name, prompt, now = new Date()) {
  const source = name || prompt || ''
  const stem = path.basename(String(source))
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  if (stem) return stem
  const pad = value => String(value).padStart(2, '0')
  return `image-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}
export async function freePath(dir, stem, ext) {
  for (let index = 1;; index++) {
    const candidate = path.join(dir, `${stem}${index === 1 ? '' : `-${index}`}.${ext}`)
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
}
export async function referencePath(file, workspace) {
  const resolved = path.resolve(workspace, String(file))
  if (!IMAGE_TYPES[path.extname(resolved).toLowerCase()]) throw new Error(`${file}: only PNG, JPEG, WebP and GIF images can be used as references`)
  const stat = await fs.stat(resolved).catch(() => null)
  if (!stat?.isFile()) throw new Error(`${file}: file not found`)
  if (stat.size > MAX_REFERENCE_BYTES) throw new Error(`${file}: larger than 20 MB`)
  return resolved
}
// Retained pure helper for consumers displaying local reference data.
export async function referenceUrl(file, workspace) {
  const resolved = await referencePath(file, workspace)
  return `data:${IMAGE_TYPES[path.extname(resolved).toLowerCase()]};base64,${(await fs.readFile(resolved)).toString('base64')}`
}
const pick = (value, values, fallback) => values.includes(value) ? value : fallback
export async function generateImage(args, {
  client,
  workspace,
  previews,
  enabled = async () => true
}) {
  if (!(await enabled())) throw new Error('画像生成は設定で無効になっています。')
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) throw new Error('prompt is required')
  const format = pick(args.format, FORMATS, 'png')
  const background = pick(args.background, BACKGROUNDS, 'auto')
  if (background === 'transparent' && format === 'jpeg') throw new Error('a transparent background needs png or webp')
  const files = Array.isArray(args.reference_images) ? args.reference_images.slice(0, MAX_REFERENCES) : []
  const references = await Promise.all(files.map(file => referencePath(file, workspace)))
  const image = await client.generate({
    prompt,
    references,
    format,
    background,
    size: pick(args.size, SIZES, 'auto'),
    quality: pick(args.quality, QUALITIES, 'auto')
  })
  const ext = image.format === 'jpeg' ? 'jpg' : image.format
  const dir = path.join(workspace, 'generated-images')
  await fs.mkdir(dir, {
    recursive: true
  })
  const stem = fileStem(args.filename, prompt)
  // Exclusive create makes no-overwrite true even across concurrent MCP processes.
  let file
  for (let index = 1;; index++) {
    file = path.join(dir, `${stem}${index === 1 ? '' : `-${index}`}.${ext}`)
    try {
      await fs.writeFile(file, image.bytes, {
        flag: 'wx'
      })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  const lines = [
    `Saved the image to ${path.relative(workspace, file).split(path.sep).join('/')} `
      + `(${image.size ?? 'unknown size'}, ${image.format}, `
      + `${Math.round(image.bytes.length / 1024)} KB, ${Math.round(image.elapsedMs / 1000)}s).`,
  ]
  if (format !== image.format) {
    lines.push(`Requested ${format}; Codex returned ${image.format}, `
      + `so the original ${image.format} was kept without conversion.`)
  }
  if (image.revisedPrompt) lines.push(`Prompt the image model used: ${image.revisedPrompt}`)
  if (image.tokenUsage?.total) {
    lines.push(`Codex token usage: ${image.tokenUsage.total.inputTokens} input, `
      + `${image.tokenUsage.total.outputTokens} output.`)
  }
  if (previews) {
    const name = `${randomUUID()}.${ext}`
    await fs.mkdir(previews, {
      recursive: true
    })
    await fs.writeFile(path.join(previews, name), image.bytes, {
      flag: 'wx'
    })
    lines.push(`[agent-desk-preview] ${name}`)
  }
  return [{
    type: 'text',
    text: lines.join('\n')
  }]
}
