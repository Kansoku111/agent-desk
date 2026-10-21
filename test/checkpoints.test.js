import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Checkpoints, MAX_FILE_BYTES } from '../server/checkpoints.js'

async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-checkpoints-'))
  const workspace = path.join(base, 'work')
  await fs.mkdir(workspace)
  const checkpoints = new Checkpoints({ root: path.join(base, 'checkpoints') })
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true })
    await fs.writeFile(path.join(workspace, file), text)
  }
  const read = (file) => fs.readFile(path.join(workspace, file), 'utf8').catch(() => null)
  const exists = (file) => fs.access(path.join(workspace, file)).then(() => true, () => false)
  return { base, workspace, checkpoints, write, read, exists }
}

test('restore puts changed, deleted and created files back', async (t) => {
  const { base, workspace, checkpoints, write, read, exists } = await setup()
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  // The workspace's own attributes would normally convert line endings.
  await write('.gitattributes', '* text=auto eol=lf\n')
  await write('keep.txt', 'same')
  await write('edit.txt', 'before\r\n')
  await write('gone.txt', 'still here')
  await write('日本語 [1].txt', 'ファイル')
  const { commit: before } = await checkpoints.snapshot(workspace, 'thread/turn/before')

  await write('edit.txt', 'after\n')
  await fs.rm(path.join(workspace, 'gone.txt'))
  await write('日本語 [1].txt', '変更')
  await write('new/deep/file.txt', 'created')

  const preview = await checkpoints.preview(workspace, before)
  assert.deepEqual(
    Object.fromEntries(preview.map((entry) => [entry.path, entry.action])),
    { 'edit.txt': 'restore', 'gone.txt': 'recreate', '日本語 [1].txt': 'restore', 'new/deep/file.txt': 'delete' },
  )

  const result = await checkpoints.restore(workspace, before, 'thread/turn/undo')
  assert.equal(result.error, null)
  assert.equal(await read('keep.txt'), 'same')
  assert.equal(await read('edit.txt'), 'before\r\n', 'line endings are kept byte for byte')
  assert.equal(await read('gone.txt'), 'still here')
  assert.equal(await read('日本語 [1].txt'), 'ファイル')
  assert.equal(await exists('new'), false, 'folders emptied by the restore are removed')

  // The state before the restore is kept, so the restore can be undone.
  await checkpoints.restore(workspace, result.undo)
  assert.equal(await read('edit.txt'), 'after\n')
  assert.equal(await read('gone.txt'), null)
  assert.equal(await read('new/deep/file.txt'), 'created')
})

test('ignored and large files are left alone', async (t) => {
  const { base, workspace, checkpoints, write, read } = await setup()
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  await write('.gitignore', 'secret.env\n')
  await write('secret.env', 'one')
  const { commit: before } = await checkpoints.snapshot(workspace)

  await write('secret.env', 'two')
  await write('node_modules/pkg/index.js', 'installed')
  const big = path.join(workspace, 'big.bin')
  const handle = await fs.open(big, 'w')
  await handle.truncate(MAX_FILE_BYTES + 1)
  await handle.close()

  assert.deepEqual(await checkpoints.preview(workspace, before), [])
  await checkpoints.restore(workspace, before)
  assert.equal(await read('secret.env'), 'two')
  assert.equal(await read('node_modules/pkg/index.js'), 'installed')
  assert.equal((await fs.stat(big)).size, MAX_FILE_BYTES + 1)
})

test('changes lists what a turn did, and forget drops kept snapshots', async (t) => {
  const { base, workspace, checkpoints, write } = await setup()
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  await write('a.txt', '1')
  const { commit: before } = await checkpoints.snapshot(workspace, 'task-1/turn-1/before')
  await write('a.txt', '2')
  await write('b.txt', 'new')
  const { commit: after } = await checkpoints.snapshot(workspace, 'task-1/turn-1/after')
  const changes = await checkpoints.changes(workspace, before, after)
  assert.deepEqual(changes.map((entry) => `${entry.status} ${entry.path}`).sort(), ['A b.txt', 'M a.txt'])

  await checkpoints.forget(workspace, 'task-1')
  await checkpoints.forget(workspace, 'task-1')
  await checkpoints.tidy(workspace)
  await assert.rejects(checkpoints.changes(workspace, before, after), 'forgotten snapshots are pruned')
})
