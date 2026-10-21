import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileStem, freePath, generateImage, referenceUrl } from '../server/imagegen.js'

test('fileStem makes a safe name and falls back to a timestamp', () => {
  assert.equal(fileStem('Cat Watercolor.png', 'x'), 'cat-watercolor')
  assert.equal(fileStem('../../evil', 'x'), 'evil')
  assert.equal(fileStem(null, 'A cute orange kitten, watercolor!'), 'a-cute-orange-kitten-watercolor')
  assert.equal(fileStem(null, '猫のイラスト', new Date(2026, 9, 9, 8, 5, 3)), 'image-20261009-080503')
})

test('freePath never overwrites and referenceUrl reads workspace images', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-imagegen-'))
  try {
    assert.equal(await freePath(dir, 'cat', 'png'), path.join(dir, 'cat.png'))
    await fs.writeFile(path.join(dir, 'cat.png'), 'x')
    assert.equal(await freePath(dir, 'cat', 'png'), path.join(dir, 'cat-2.png'))

    assert.equal(await referenceUrl('cat.png', dir), `data:image/png;base64,${Buffer.from('x').toString('base64')}`)
    await assert.rejects(referenceUrl('missing.png', dir), /not found/)
    await assert.rejects(referenceUrl('notes.txt', dir), /only PNG/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('app-server image input rejects missing prompt without starting generation', async () => {
  let calls = 0
  await assert.rejects(generateImage({}, { client: { generate: () => { calls++ } } }), /prompt is required/)
  assert.equal(calls, 0)
})
test('transparent JPEG is rejected before starting generation', async () => {
  let calls = 0
  await assert.rejects(generateImage({ prompt: 'circle', background: 'transparent', format: 'jpeg' }, { client: { generate: () => { calls++ } } }), /transparent background/)
  assert.equal(calls, 0)
})
test('invalid local image reference never reaches app-server', async () => {
  let calls = 0
  await assert.rejects(generateImage({ prompt: 'circle', reference_images: ['notes.txt'] }, { workspace: '.', client: { generate: () => { calls++ } } }), /only PNG/)
  assert.equal(calls, 0)
})