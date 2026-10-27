// The release must carry everything the app reads at run time: the code the
// server shares with the UI (shared/), and the launcher must rebuild the UI
// when any of the build's inputs change.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractZip } from '../server/app-update.js'
import { codeStamp } from '../server/code-stamp.js'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-release-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return dir
}

const write = async (file, text) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

const touch = (file, when) => fs.utimes(file, when, when)

/** Whether the tool that opens a zip (the one the app uses) is on this machine. */
async function canUnpack() {
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    return fs.access(tar).then(() => true, () => false)
  }
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** The relative imports under `app` that do not resolve: the code that would crash at start. */
async function unresolvedImports(entry, app) {
  const seen = new Set()
  const missing = new Set()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    for (const match of text.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1])
      const candidates = [target, `${target}.js`, path.join(target, 'index.js')]
      const found = await Promise.any(candidates.map(async (candidate) => {
        await fs.access(candidate)
        return candidate
      })).catch(() => null)
      if (!found) {
        missing.add(path.relative(app, target))
        continue
      }
      if (found.endsWith('.js')) queue.push(found)
    }
  }
  return [...missing]
}

test('the packed release carries the shared code the server imports', async (t) => {
  const dir = await tempDir(t)
  const root = path.join(dir, 'repo')
  const version = '9.9.9'
  for (const name of ['assets', 'docs', 'scripts', 'server', 'shared', 'web']) {
    await write(path.join(root, name, 'placeholder.txt'), name)
  }
  await write(path.join(root, 'server', 'index.js'), "import { shared } from './helper.js'\nimport { value } from '../shared/usage-score.js'\nexport { shared, value }\n")
  await write(path.join(root, 'server', 'helper.js'), "import { value } from '../shared/usage-score.js'\nexport const shared = value\n")
  await write(path.join(root, 'shared', 'usage-score.js'), 'export const value = 1\n')
  await write(path.join(root, 'web', 'index.html'), '<!doctype html>')
  await write(path.join(root, 'web', 'dist', 'index.html'), '<!doctype html>')
  await write(path.join(root, 'package.json'), JSON.stringify({ name: 'agent-desk', version }))
  await write(path.join(root, 'package-lock.json'), '{}')
  await write(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [${version}]\n\n- test\n`)
  for (const name of ['AgentDesk.cmd', 'LICENSE', 'README.md', 'README.en.md', 'THIRD_PARTY_NOTICES.md']) {
    await write(path.join(root, name), name)
  }
  // The real packer, in a throwaway repository.
  await write(path.join(root, 'scripts', 'pack-release.mjs'), await fs.readFile(path.join(projectRoot, 'scripts', 'pack-release.mjs'), 'utf8'))
  execFileSync(process.execPath, [path.join(root, 'scripts', 'pack-release.mjs'), '--tag', `v${version}`], { cwd: root, stdio: 'pipe' })

  const out = path.join(dir, 'unpacked')
  await fs.mkdir(out, { recursive: true })
  // The tool that opens a zip is the one the app uses; a missing one is an
  // environment problem and is checked before anything is unpacked.
  if (!(await canUnpack())) {
    t.skip('この環境には zip を開くツールがありません')
    return
  }
  await extractZip(path.join(root, 'release', `AgentDesk-${version}.zip`), out)
  const app = path.join(out, 'AgentDesk')
  assert.equal(await fs.access(path.join(app, 'shared', 'usage-score.js')).then(() => true, () => false), true, 'the release carries shared/')
  assert.deepEqual(await unresolvedImports(path.join(app, 'server', 'index.js'), app), [])
})

test('the launcher rebuilds the UI when any of the build\'s inputs change', async (t) => {
  const dir = await tempDir(t)
  const root = path.join(dir, 'project')
  await write(path.join(root, 'scripts', 'ensure-build.mjs'), await fs.readFile(path.join(projectRoot, 'scripts', 'ensure-build.mjs'), 'utf8'))
  const marker = path.join(root, 'BUILD-RAN')
  // A Vite that only says it ran.
  await write(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, 'built')\n`)
  const inputs = {
    source: path.join(root, 'web', 'src', 'main.tsx'),
    public: path.join(root, 'web', 'public', 'favicon.svg'),
    config: path.join(root, 'web', 'vite.config.ts'),
    shared: path.join(root, 'shared', 'usage-score.js'),
    page: path.join(root, 'web', 'index.html'),
  }
  for (const file of Object.values(inputs)) await write(file, 'x')
  const dist = path.join(root, 'web', 'dist', 'index.html')
  await write(dist, 'built')
  // The build is newer than every input: nothing to do.
  const old = new Date('2020-01-01T00:00:00Z')
  const input = new Date('2021-01-01T00:00:00Z')
  for (const file of Object.values(inputs)) await touch(file, input)
  await touch(dist, new Date('2022-01-01T00:00:00Z'))

  const builds = async () => {
    await fs.rm(marker, { force: true })
    execFileSync(process.execPath, [path.join(root, 'scripts', 'ensure-build.mjs')], { cwd: root, stdio: 'pipe' })
    return fs.access(marker).then(() => true, () => false)
  }
  assert.equal(await builds(), false, 'an unchanged project is not built again')

  for (const [name, file] of Object.entries(inputs)) {
    // Only this input changes; the others go back to what they were.
    for (const other of Object.values(inputs)) await touch(other, input)
    await touch(dist, new Date('2022-01-01T00:00:00Z'))
    await touch(file, new Date('2023-01-01T00:00:00Z'))
    assert.equal(await builds(), true, `${name} is an input of the build`)
  }
})

test('the updater exe and the standalone updater carry the shared code', async () => {
  // The folders the updater exe copies into its own payload.
  const builder = await fs.readFile(path.join(projectRoot, 'scripts', 'updater', 'build-updater.ps1'), 'utf8')
  const payload = /foreach \(\$name in ([^)]*)\) \{/.exec(builder)
  assert.ok(payload, 'the payload list is found')
  assert.match(payload[1], /'shared'/, 'the updater exe payload carries shared/')
  // The folders the standalone updater replaces in an install.
  const updater = await fs.readFile(path.join(projectRoot, 'scripts', 'updater', 'update.ps1'), 'utf8')
  const managed = /\$ManagedDirs = @\(([^)]*)\)/.exec(updater)
  assert.ok(managed, 'the managed folders are found')
  assert.match(managed[1], /'shared'/, 'the standalone updater copies shared/')
})

test('the code stamp follows the shared code', async (t) => {
  const dir = await tempDir(t)
  const root = path.join(dir, 'install')
  await write(path.join(root, 'server', 'index.js'), 'export {}\n')
  await write(path.join(root, 'shared', 'usage-score.js'), 'export const value = 1\n')
  await write(path.join(root, 'package.json'), '{}')
  await write(path.join(root, 'node_modules', '.package-lock.json'), '{}')
  await write(path.join(root, 'web', 'dist', 'index.html'), 'built')

  const before = codeStamp(root)
  await write(path.join(root, 'shared', 'usage-score.js'), 'export const value = 2\n')
  await touch(path.join(root, 'shared', 'usage-score.js'), new Date())
  assert.notEqual(codeStamp(root), before, 'only the shared code changed')

  // An older install has no shared/: the stamp still works.
  await fs.rm(path.join(root, 'shared'), { recursive: true, force: true })
  assert.match(codeStamp(root), /^[0-9a-f]{16}$/)
})
