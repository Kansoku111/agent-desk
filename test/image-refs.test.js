import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageRefs } from '../web/src/image-refs.ts'

test('finds images mentioned in inline code, links and bare paths, in order', () => {
  const text = [
    '保存先は `generated-images/cat.png`（1536x1024）です。',
    '[スクリーンショット](shots/a%20b.jpg) と [別の](<shots/c d.webp> "title") を見てください。',
    '`C:\\Users\\me\\AppData\\Roaming\\AgentDesk\\my-pc\\generated-images\\dog.png` を直接開いてください。',
    '保存しました：C:\\Users\\me\\Downloads\\ここ\\shot1.png',
    '出力は ./out/plot.svg と /home/me/pic.gif です。',
  ].join('\n')
  assert.deepEqual(imageRefs(text).mentioned, [
    'generated-images/cat.png',
    'shots/a%20b.jpg',
    'shots/c d.webp',
    'C:\\Users\\me\\AppData\\Roaming\\AgentDesk\\my-pc\\generated-images\\dog.png',
    'C:\\Users\\me\\Downloads\\ここ\\shot1.png',
    './out/plot.svg',
    '/home/me/pic.gif',
  ])
})

test('keeps images already shown with ![]() apart', () => {
  const refs = imageRefs('![猫](generated-images/cat.png)\n\n保存先は `generated-images/cat.png` です。')
  assert.deepEqual(refs.shown, ['generated-images/cat.png'])
  assert.deepEqual(refs.mentioned, ['generated-images/cat.png'])
})

test('ignores web URLs, code blocks, other files and repeats', () => {
  const text = [
    'https://example.com/a.png と http://x.test/b.jpg は Web の画像です。',
    '```sh',
    'convert in.png out.png',
    '```',
    '`src/app.ts` と `README.md`、`a.png` と `a.png` と a.png。',
    'data.pngfile と cat.png.bak は画像ではありません。',
  ].join('\n')
  assert.deepEqual(imageRefs(text).mentioned, ['a.png'])
})

test('reads file URLs', () => {
  assert.deepEqual(imageRefs('file:///C:/tmp/x.png を作りました').mentioned, ['file:///C:/tmp/x.png'])
})

test('stays fast on long text without images', () => {
  const started = Date.now()
  imageRefs(`${'a.b-c_d/'.repeat(5000)}x ${'word.'.repeat(5000)}`)
  assert.ok(Date.now() - started < 500)
})
