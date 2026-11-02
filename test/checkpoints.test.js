import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Checkpoints, MAX_FILE_BYTES } from '../server/checkpoints.js'

async function setup(maxFileBytes = MAX_FILE_BYTES) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-checkpoints-'))
  const workspace = path.join(base, 'work')
  await fs.mkdir(workspace)
  const checkpoints = new Checkpoints({ root: path.join(base, 'checkpoints'), maxFileBytes })
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true })
    await fs.writeFile(path.join(workspace, file), text)
  }
  const read = (file) => fs.readFile(path.join(workspace, file), 'utf8').catch(() => null)
  const exists = (file) => fs.access(path.join(workspace, file)).then(() => true, () => false)
  return { base, workspace, checkpoints, write, read, exists }
}

test('legacy checkpoint budget cooldowns expose a recording-only limit without changing the workspace', async (t) => {
  const { base, workspace, checkpoints, write, read } = await setup()
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  await write('source.txt', 'unchanged')
  await checkpoints.snapshot(workspace, 'seed')
  const repo = [...checkpoints.repos.values()][0]
  const reason = 'フォルダ内のファイルが多すぎるため、変更を戻すための保存を省略しました。'
  await fs.writeFile(path.join(repo.gitDir, 'skip.json'), JSON.stringify({ at: Date.now(), reason }))
  const restored = new Checkpoints({ root: path.join(base, 'checkpoints') })
  await assert.rejects(restored.snapshot(workspace), (error) => error.code === 'CHECKPOINT_SNAPSHOT_LIMIT' && error.message === reason)
  assert.equal(await read('source.txt'), 'unchanged')
})

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

test('oversized tracked files leave the index and stay untouched by restore', async (t) => {
  const { base, workspace, checkpoints, write, read } = await setup(4)
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  await write('large.bin', 'A')
  const { commit: before } = await checkpoints.snapshot(workspace, 'task/before')
  await write('large.bin', 'B')
  await checkpoints.snapshot(workspace, 'task/middle')
  await write('large.bin', 'large')
  const { commit: after } = await checkpoints.snapshot(workspace, 'task/large')

  assert.deepEqual(await checkpoints.changes(workspace, before, after), [], 'an omitted file is not a deletion')
  assert.deepEqual(await checkpoints.preview(workspace, before), [])
  const result = await checkpoints.restore(workspace, before)
  assert.deepEqual(result.restored, [])
  assert.deepEqual(result.removed, [])
  assert.equal(await read('large.bin'), 'large')
})

test('previously omitted files remain protected by restore, undo and review after reload', async (t) => {
  const { base, workspace, checkpoints, write, read } = await setup(4)
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  await write('large.bin', 'large')
  await write('small', 'old')
  const before = await checkpoints.snapshot(workspace, 'task/before')
  assert.deepEqual(before.omitted, ['large.bin'])
  await write('large.bin', 'now')
  await write('small', 'new')
  const reloaded = new Checkpoints({ root: path.join(base, 'checkpoints'), maxFileBytes: 4 })
  const after = await reloaded.snapshot(workspace)
  const evidence = await reloaded.reviewDiff(workspace, before.commit, after.commit)
  assert.deepEqual(evidence.files, [{ path: 'small', status: 'M' }])
  assert.match(evidence.warning, /large\.bin/)
  assert.doesNotMatch(evidence.patch, /large\.bin/)
  assert.deepEqual(await reloaded.preview(workspace, before.commit), [{ path: 'small', action: 'restore' }])
  const result = await reloaded.restore(workspace, before.commit, 'task/undo')
  assert.equal(await read('large.bin'), 'now')
  assert.equal(await read('small'), 'old')
  await write('large.bin', 'edit')
  await reloaded.restore(workspace, result.undo)
  assert.equal(await read('large.bin'), 'edit', 'undo also preserves protected paths')
  assert.equal(await read('small'), 'new')
})

test('omitted paths protect file-directory replacements in both directions', async (t) => {
  for (const direction of ['file-to-directory', 'directory-to-file']) await t.test(direction, async (t) => {
    const { base, workspace, checkpoints, write, read } = await setup(4)
    t.after(() => fs.rm(base, { recursive: true, force: true }))
    const oldPath = direction === 'file-to-directory' ? 'folder' : 'folder/large'
    const newPath = direction === 'file-to-directory' ? 'folder/child' : 'folder'
    await write(oldPath, 'large')
    const before = await checkpoints.snapshot(workspace)
    await fs.rm(path.join(workspace, 'folder'), { recursive: true, force: true })
    await write(newPath, 'new')
    const after = await checkpoints.snapshot(workspace)
    const evidence = await checkpoints.reviewDiff(workspace, before.commit, after.commit)
    assert.deepEqual(evidence.files, [])
    assert.match(evidence.warning, /folder/)
    assert.deepEqual(await checkpoints.preview(workspace, before.commit), [])
    await checkpoints.restore(workspace, before.commit)
    assert.equal(await read(newPath), 'new')
  })
})

test('omitted paths stay protected after a case-only rename on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const { base, workspace, checkpoints, write, read } = await setup(4)
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  await write('Large.bin', 'large')
  const before = await checkpoints.snapshot(workspace)
  await fs.rename(path.join(workspace, 'Large.bin'), path.join(workspace, 'large.bin'))
  await write('large.bin', 'new')
  const after = await checkpoints.snapshot(workspace)
  assert.deepEqual(await checkpoints.preview(workspace, before.commit), [])
  assert.deepEqual((await checkpoints.reviewDiff(workspace, before.commit, after.commit)).files, [])
  await checkpoints.restore(workspace, before.commit)
  assert.equal(await read('large.bin'), 'new')
})

test('legacy snapshots fail closed without changing the workspace', async (t) => {
  const { base, workspace, checkpoints, write, read } = await setup()
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  await write('source', 'before')
  const before = await checkpoints.snapshot(workspace)
  const repo = [...checkpoints.repos.values()][0]
  const env = { ...process.env, GIT_DIR: repo.gitDir, GIT_WORK_TREE: workspace, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }
  const legacy = childProcess.execFileSync('git', ['commit-tree', before.commit + '^{tree}', '-m', 'Agent Desk checkpoint'], { env, encoding: 'utf8' }).trim()
  await write('source', 'after')
  const current = await checkpoints.snapshot(workspace)
  await assert.rejects(checkpoints.preview(workspace, legacy), /古い保存/)
  await assert.rejects(checkpoints.restore(workspace, legacy, 'task/undo'), /古い保存/)
  await assert.rejects(checkpoints.reviewDiff(workspace, legacy, current.commit), /古い保存/)
  assert.equal(await read('source'), 'after')
})

test('an incomplete snapshot never becomes an undo or restore baseline', async (t) => {
  const { base, workspace, checkpoints, write, read } = await setup()
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  await write('source', 'before')
  const before = await checkpoints.snapshot(workspace, 'task/before')
  await write('source', 'after')
  const original = childProcess.execFile
  const mocked = t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    if (command === 'git' && args.includes('add')) {
      const error = Object.assign(new Error('git add failed'), { code: 1 })
      setImmediate(() => callback(error, '', 'locked file'))
      return { stdin: new PassThrough() }
    }
    return original(command, args, options, callback)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(checkpoints.snapshot(workspace, 'task/failed'), /git add failed/)
    await assert.rejects(checkpoints.preview(workspace, before.commit), /git add failed/)
    await assert.rejects(checkpoints.restore(workspace, before.commit, 'task/undo'), /git add failed/)
    assert.equal(await read('source'), 'after')
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
})

test('an early Git exit reports its command failure instead of an unhandled stdin EPIPE', async (t) => {
  const { base, workspace, checkpoints, write, read } = await setup()
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  await write('source', 'before')
  await checkpoints.snapshot(workspace)
  await write('source', 'after')
  const original = childProcess.execFile
  const mocked = t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    if (command === 'git' && args.includes('add')) {
      const stdin = new PassThrough()
      setImmediate(() => {
        stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        setImmediate(() => callback(Object.assign(new Error('git add failed'), { code: 1 }), '', 'index locked'))
      })
      return { stdin }
    }
    return original(command, args, options, callback)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(checkpoints.snapshot(workspace), (error) => {
      assert.equal(error.message, 'git add failed')
      assert.equal(error.stderr, 'index locked')
      return true
    })
    assert.equal(await read('source'), 'after')
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
})

test('restore removes files whose names start with two dots', async (t) => {
  const { base, workspace, checkpoints, write, exists } = await setup()
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const { commit: before } = await checkpoints.snapshot(workspace, 'task/before')
  await write('..notes.txt', 'created after the checkpoint')

  const result = await checkpoints.restore(workspace, before)
  assert.deepEqual(result.removed, ['..notes.txt'])
  assert.equal(result.error, null)
  assert.equal(await exists('..notes.txt'), false)
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
