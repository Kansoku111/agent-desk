import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRunnable, referenceCandidates, resolveReference } from '../server/file-refs.js'

test('referenceCandidates reads the forms agents write paths in', () => {
  const ws = path.resolve('/work/project')
  assert.deepEqual(referenceCandidates('generated-images/cat.png', ws), [{ file: path.join(ws, 'generated-images', 'cat.png'), line: null }])
  assert.deepEqual(referenceCandidates('`src/a.ts`', ws)[0], { file: path.join(ws, 'src', 'a.ts'), line: null })
  assert.deepEqual(referenceCandidates('src/a.ts:42', ws)[1], { file: path.join(ws, 'src', 'a.ts'), line: 42 })
  assert.deepEqual(referenceCandidates('src/a.ts#L7-L9', ws)[1], { file: path.join(ws, 'src', 'a.ts'), line: 7 })
  assert.deepEqual(referenceCandidates('my%20file.txt', ws)[0], { file: path.join(ws, 'my file.txt'), line: null })
  const absolute = path.resolve('/elsewhere/x.png')
  assert.equal(referenceCandidates(pathToFileURL(absolute).href, ws)[0].file, absolute)
  assert.equal(referenceCandidates(absolute, ws)[0].file, absolute)
  assert.deepEqual(referenceCandidates('https://example.com/a.png', ws), [])
  assert.deepEqual(referenceCandidates('relative.txt', null), [])
})

test('referenceCandidates refuses UNC paths and hosted file URLs', () => {
  const ws = path.resolve('/work/project')
  for (const ref of ['//server/share/a.png', '///server/share/a.png', '\\\\server\\share\\a.png', 'file://server/share/a.png']) {
    assert.deepEqual(referenceCandidates(ref, ws), [], ref)
  }
})

test('referenceCandidates keeps ordinary absolute, relative, and hostless file URLs', () => {
  const ws = path.resolve('/work/project')
  assert.equal(referenceCandidates('src/a.ts', ws)[0].file, path.join(ws, 'src', 'a.ts'))
  assert.equal(referenceCandidates('/root/a.ts', ws)[0].file, path.normalize('/root/a.ts'))

  for (const ref of ['C:\\x', 'C:/x']) {
    const candidate = referenceCandidates(ref, ws)[0]
    assert.ok(candidate, ref)
    assert.equal(candidate.file, process.platform === 'win32' ? path.win32.normalize(ref) : path.resolve(ws, ref))
  }

  const hostless = pathToFileURL(path.resolve(ws, 'a.png')).href
  assert.equal(referenceCandidates(hostless, ws)[0].file, path.resolve(ws, 'a.png'))
  assert.ok(referenceCandidates('file:///C:/x', ws).length > 0)
  assert.ok(referenceCandidates('file://localhost/C:/x', ws).length > 0)
})

test('resolveReference finds the file, with or without a line suffix', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-refs-'))
  try {
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'x')
    assert.deepEqual(await resolveReference('src/a.ts:3', dir), { file: path.join(dir, 'src', 'a.ts'), line: 3, exists: true, directory: false })
    assert.equal((await resolveReference('src', dir)).directory, true)
    assert.equal((await resolveReference('src/missing.ts', dir)).exists, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('isRunnable flags programs and scripts', () => {
  assert.equal(isRunnable('C:/x/setup.EXE'), true)
  assert.equal(isRunnable('run.ps1'), true)
  assert.equal(isRunnable('cat.png'), false)
  assert.equal(isRunnable('notes.md'), false)
})
