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
  assert.deepEqual(referenceCandidates('my%20file.txt', ws), [
    { file: path.join(ws, 'my%20file.txt'), line: null },
    { file: path.join(ws, 'my file.txt'), line: null },
  ])
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

test('resolveReference keeps a closing parenthesis that belongs to the name', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-refs-'))
  try {
    await fs.mkdir(path.join(dir, 'New folder (2)'))
    await fs.writeFile(path.join(dir, 'New folder (2)', 'a (1).txt'), 'x')
    await fs.writeFile(path.join(dir, '(1) b.txt'), 'x')
    const folder = path.join(dir, 'New folder (2)')
    for (const ref of ['New folder (2)', '`New folder (2)`', '"New folder (2)"', '(New folder (2))', 'New folder (2),', path.join(dir, 'New folder (2)')]) {
      const found = await resolveReference(ref, dir)
      assert.equal(found.file, folder, ref)
      assert.equal(found.directory, true, ref)
    }
    const inner = path.join(folder, 'a (1).txt')
    assert.equal((await resolveReference(path.join(folder, 'a (1).txt'), dir)).file, inner)
    assert.equal((await resolveReference('(New folder (2)/a (1).txt)', dir)).file, inner)
    const line = await resolveReference(path.join(folder, 'a (1).txt') + ':5', dir)
    assert.deepEqual([line.file, line.line], [inner, 5])
    assert.equal((await resolveReference('(1) b.txt', dir)).file, path.join(dir, '(1) b.txt'))
    assert.equal((await resolveReference('(src/missing.ts)', dir)).exists, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('resolveReference keeps a name that ends in an unmatched parenthesis', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-refs-'))
  try {
    await fs.writeFile(path.join(dir, 'report)'), 'x')
    const only = path.join(dir, 'report)')
    for (const ref of ['report)', '`report)`', '"report)"', only]) assert.equal((await resolveReference(ref, dir)).file, only, ref)
    assert.equal((await resolveReference('(see report)', dir)).exists, false)
    // Both exist: the name as written wins; the decorated reading still works when only it exists.
    await fs.writeFile(path.join(dir, 'report'), 'x')
    assert.equal((await resolveReference('report)', dir)).file, only)
    assert.equal((await resolveReference('report', dir)).file, path.join(dir, 'report'))
    assert.equal((await resolveReference('(report)', dir)).file, path.join(dir, 'report'))
    await fs.writeFile(path.join(dir, 'other'), 'x')
    assert.equal((await resolveReference('other)', dir)).file, path.join(dir, 'other'))
    assert.equal((await resolveReference('`other`,', dir)).file, path.join(dir, 'other'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('resolveReference handles a lone parenthesis name and refuses oversized input', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-refs-'))
  try {
    await fs.writeFile(path.join(dir, ')'), 'x')
    assert.equal((await resolveReference(')', dir)).file, path.join(dir, ')'))
    assert.deepEqual(referenceCandidates(')'.repeat(1025), dir), [])
    assert.deepEqual(referenceCandidates(')'.repeat(200000), dir), [])
    assert.deepEqual(referenceCandidates('', dir), [])
    assert.deepEqual(referenceCandidates('a\nb', dir), [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('resolveReference prefers the literal path over its URL-decoded reading', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-refs-'))
  try {
    await fs.writeFile(path.join(dir, 'a%20b.txt'), 'x')
    assert.equal((await resolveReference('a%20b.txt', dir)).file, path.join(dir, 'a%20b.txt'))
    assert.equal((await resolveReference(path.join(dir, 'a%20b.txt'), dir)).file, path.join(dir, 'a%20b.txt'))
    // Only the literal file exists: no silent switch to another name.
    assert.equal((await resolveReference('a%20b.txt', dir)).exists, true)
    assert.equal((await resolveReference('c%20d.txt', dir)).exists, false)
    // Both exist: the literal one wins.
    await fs.writeFile(path.join(dir, 'a b.txt'), 'x')
    assert.equal((await resolveReference('a%20b.txt', dir)).file, path.join(dir, 'a%20b.txt'))
    assert.equal((await resolveReference('a%20b.txt:4', dir)).file, path.join(dir, 'a%20b.txt'))
    // Only the decoded file exists: the encoded reference still finds it.
    await fs.writeFile(path.join(dir, 'e f.txt'), 'x')
    assert.equal((await resolveReference('e%20f.txt', dir)).file, path.join(dir, 'e f.txt'))
    const decodedLine = await resolveReference('e%20f.txt#L3', dir)
    assert.deepEqual([decodedLine.file, decodedLine.line], [path.join(dir, 'e f.txt'), 3])
    // A literal percent sign that is not an escape stays as written.
    await fs.writeFile(path.join(dir, '100%.txt'), 'x')
    assert.equal((await resolveReference('100%.txt', dir)).file, path.join(dir, '100%.txt'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('file URLs are decoded exactly once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-refs-'))
  try {
    await fs.writeFile(path.join(dir, 'x y.txt'), 'x')
    await fs.writeFile(path.join(dir, 'x%20y.txt'), 'x')
    const spaced = await resolveReference(pathToFileURL(path.join(dir, 'x y.txt')).href, dir)
    assert.equal(spaced.file, path.join(dir, 'x y.txt'))
    const literal = pathToFileURL(path.join(dir, 'x%20y.txt')).href
    assert.ok(literal.includes('%2520'))
    assert.equal((await resolveReference(literal, dir)).file, path.join(dir, 'x%20y.txt'))
    assert.deepEqual(referenceCandidates(literal, dir).map((c) => c.file), [path.join(dir, 'x%20y.txt')])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('referenceCandidates still refuses encoded UNC paths and remote URLs', () => {
  const ws = path.resolve('/work/project')
  for (const ref of ['%2F%2Fserver%2Fshare%2Fa.png', '%5C%5Cserver%5Cshare', '(//server/share/a.png)', 'file://server/a%20b.png', 'https://example.com/a%20b.png', 'smb://host/a']) {
    assert.deepEqual(referenceCandidates(ref, ws), [], ref)
  }
})

test('isRunnable flags programs and scripts', () => {
  assert.equal(isRunnable('C:/x/setup.EXE'), true)
  assert.equal(isRunnable('run.ps1'), true)
  assert.equal(isRunnable('cat.png'), false)
  assert.equal(isRunnable('notes.md'), false)
})
