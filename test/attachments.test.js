import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { attachmentPath, fileListText, isImageFile, isOtherFile, otherFileId, safeFileName } from '../server/attachments.js'

const uuid = '0f8e2b0c-1234-4abc-9def-0123456789ab'

test('safeFileName keeps the name but drops what Windows cannot store', () => {
  assert.equal(safeFileName('report 2026.pdf'), 'report 2026.pdf')
  assert.equal(safeFileName('動画.mp4'), '動画.mp4')
  assert.equal(safeFileName('a/b\\c:d*.txt'), 'a_b_c_d_.txt')
  assert.equal(safeFileName('..'), 'file')
  assert.equal(safeFileName(''), 'file')
  assert.equal(safeFileName('notes. '), 'notes')
  assert.equal(safeFileName('con.txt'), '_con.txt')
  const long = safeFileName(`${'x'.repeat(300)}.csv`)
  assert.equal(long.length, 120)
  assert.ok(long.endsWith('.csv'))
})

test('only names the server makes are accepted', () => {
  assert.ok(isImageFile(`${uuid}.png`))
  assert.ok(!isImageFile(`${uuid}/a.png`))
  assert.ok(isOtherFile(otherFileId(uuid, 'clip.mp4')))
  assert.ok(!isOtherFile(`${uuid}/..`))
  assert.ok(!isOtherFile(`${uuid}/../secret.txt`))
  assert.ok(!isOtherFile('../x/y.txt'))
  assert.equal(attachmentPath('/data', `${uuid}/../../etc`), null)
})

test('fileListText gives the agent each file path', () => {
  const dir = path.resolve('/data/attachments')
  const text = fileListText(dir, [{ file: `${uuid}/clip.mp4` }])
  assert.ok(text.includes(path.join(dir, uuid, 'clip.mp4')))
  assert.equal(fileListText(dir, []), '')
})
