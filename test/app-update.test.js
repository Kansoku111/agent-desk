import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { githubRepository, latestRelease, prepareGit, prepareZip, updateFiles } from '../server/app-update.js'
import { claimDataFolder } from '../server/single-instance.js'
import { UpdateChecker } from '../server/update-checks.js'
import { applyGit, applyZip, systemSteps } from '../scripts/apply-update.mjs'

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-app-update-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return dir
}

const read = (file) => fs.readFile(file, 'utf8')
const exists = (file) => fs.access(file).then(() => true, () => false)

test('githubRepository reads owner/name from package.json', () => {
  assert.equal(githubRepository({ repository: { url: 'git+https://github.com/Kansoku111/agent-desk.git' } }), 'Kansoku111/agent-desk')
  assert.equal(githubRepository({ repository: 'https://github.com/a/b' }), 'a/b')
  assert.equal(githubRepository({ repository: 'git@github.com:a/b.git' }), 'a/b')
  assert.equal(githubRepository({ repository: 'https://gitlab.com/a/b' }), null)
  assert.equal(githubRepository({}), null)
})

const asset = (version, digest = `sha256:${'a'.repeat(64)}`) => ({ name: `AgentDesk-${version}.zip`, browser_download_url: `https://dl/${version}.zip`, digest })

function github(releases) {
  return async (url) => {
    assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/o\/r\/releases\?/)
    return Response.json(releases)
  }
}

test('latestRelease takes the newest published release', async () => {
  const fetch = github([
    { tag_name: 'v0.3.0', draft: true, assets: [asset('0.3.0')] },
    { tag_name: 'v0.2.1-rc.1', prerelease: true, assets: [asset('0.2.1-rc.1')] },
    { tag_name: 'v0.2.0', html_url: 'https://github.com/o/r/releases/tag/v0.2.0', assets: [] },
    { tag_name: 'v0.1.9', html_url: 'https://github.com/o/r/releases/tag/v0.1.9', assets: [asset('0.1.9')] },
    { tag_name: 'nightly', assets: [] },
  ])
  const newest = await latestRelease({ repo: 'o/r', fetch })
  assert.deepEqual(newest, { version: '0.2.0', tag: 'v0.2.0', url: 'https://github.com/o/r/releases/tag/v0.2.0', asset: null })
  // A zip install cannot take a release without the zip.
  const installable = await latestRelease({ repo: 'o/r', needAsset: true, fetch })
  assert.equal(installable.version, '0.1.9')
  assert.deepEqual(installable.asset, { url: 'https://dl/0.1.9.zip', digest: `sha256:${'a'.repeat(64)}` })
  assert.equal(await latestRelease({ repo: 'o/r', fetch: github([]) }), null)
  await assert.rejects(latestRelease({ repo: 'o/r', fetch: async () => new Response('limit', { status: 403 }) }), /403/)
})

test('prepareZip checks the hash and the version inside', async (t) => {
  const dir = await tempDir(t)
  const body = 'zip bytes'
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`
  const release = (version = '0.2.0', hash = digest) => ({ version, tag: `v${version}`, asset: { url: 'https://dl/x.zip', digest: hash } })
  const fetch = async () => new Response(body)
  // Stands in for tar: the zip holds one AgentDesk folder.
  const extract = (version) => async (zip, out) => {
    assert.equal(await read(zip), body)
    await fs.mkdir(path.join(out, 'AgentDesk'))
    await fs.writeFile(path.join(out, 'AgentDesk', 'package.json'), JSON.stringify({ name: 'agent-desk', version }))
  }
  const payload = await prepareZip({ release: release(), dir, fetch, extract: extract('0.2.0') })
  assert.equal(payload, path.join(dir, 'files', 'AgentDesk'))

  await assert.rejects(prepareZip({ release: release('0.2.0', `sha256:${'0'.repeat(64)}`), dir, fetch, extract: extract('0.2.0') }), /ハッシュ値が一致しません/)
  await assert.rejects(prepareZip({ release: release('0.2.0', null), dir, fetch, extract: extract('0.2.0') }), /ハッシュ値がありません/)
  await assert.rejects(prepareZip({ release: release(), dir, fetch, extract: extract('0.1.0') }), /0\.2\.0 ではありません/)
  await assert.rejects(prepareZip({ release: { version: '0.2.0', tag: 'v0.2.0', asset: null }, dir, fetch }), /AgentDesk-0\.2\.0\.zip/)
})

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim()

/** An upstream repository with a release tag, and a clone one commit behind it. */
async function repositories(t) {
  const dir = await tempDir(t)
  const upstream = path.join(dir, 'upstream')
  const clone = path.join(dir, 'clone')
  await fs.mkdir(upstream)
  git(upstream, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(upstream, 'app.js'), 'v1\n')
  await fs.writeFile(path.join(upstream, 'package-lock.json'), '{"v":1}\n')
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-q', '-m', 'one')
  git(dir, 'clone', '-q', upstream, clone)
  await fs.writeFile(path.join(upstream, 'app.js'), 'v2\n')
  git(upstream, 'commit', '-q', '-am', 'two')
  git(upstream, 'tag', '-a', 'v0.2.0', '-m', 'release')
  return { upstream, clone, release: { version: '0.2.0', tag: 'v0.2.0' } }
}

test('prepareGit fetches the tag and refuses a checkout that cannot move forward to it', async (t) => {
  const { upstream, clone, release } = await repositories(t)
  const ready = await prepareGit({ root: clone, release, remote: upstream })
  assert.equal(ready.head, git(clone, 'rev-parse', 'HEAD'))
  assert.equal(ready.target, git(upstream, 'rev-parse', 'HEAD'))

  await fs.writeFile(path.join(clone, 'app.js'), 'edited\n')
  await assert.rejects(prepareGit({ root: clone, release, remote: upstream }), /コミットしていない変更/)
  git(clone, 'commit', '-q', '-am', 'local work')
  await assert.rejects(prepareGit({ root: clone, release, remote: upstream }), /自動では更新できません/)
})

test('automatic npm installs leave the tracked lockfile clean during update and launch', async (t) => {
  const root = await tempDir(t)
  const home = path.join(root, 'home')
  await fs.mkdir(path.join(root, 'scripts'))
  await fs.mkdir(path.join(root, 'server'))
  await fs.mkdir(home)
  await fs.copyFile(new URL('../scripts/launch.mjs', import.meta.url), path.join(root, 'scripts', 'launch.mjs'))
  await fs.writeFile(path.join(root, 'scripts', 'ensure-build.mjs'), '')
  await fs.writeFile(path.join(root, 'server', 'paths.js'), "export const appPaths = () => ({ home: process.env.TEST_HOME })\n")
  await fs.writeFile(path.join(root, 'server', 'index.js'), "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.TEST_HOME, 'server.json'), JSON.stringify({ pid: process.pid })); setTimeout(() => {}, 1500)\n")
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'update-fixture', version: '1.0.0', type: 'module' }))
  const lock = JSON.stringify({ name: 'update-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'update-fixture', version: '1.0.0' } }, marker: 'keep' }, null, 2) + '\n'
  await fs.writeFile(path.join(root, 'package-lock.json'), lock)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', 'package.json', 'package-lock.json')
  git(root, 'commit', '-q', '-m', 'fixture')

  await systemSteps(() => {}).npm(root)
  assert.equal(await read(path.join(root, 'package-lock.json')), lock)
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=no'), '')

  // Force the launcher's install path without touching the lockfile.
  await fs.rm(path.join(root, 'node_modules'), { recursive: true, force: true })
  execFileSync(process.execPath, [path.join(root, 'scripts', 'launch.mjs')], { cwd: root, env: { ...process.env, TEST_HOME: home }, timeout: 30_000, windowsHide: true })
  assert.equal(await read(path.join(root, 'package-lock.json')), lock)
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=no'), '')
})

function steps(overrides = {}) {
  const calls = []
  return {
    calls,
    npm: async () => { calls.push('npm') },
    launch: async () => { calls.push('launch') },
    git: async (args, cwd) => { calls.push(args[0]); git(cwd, ...args) },
    log: () => {},
    ...overrides,
  }
}

test('applyGit fast-forwards, and resets when the new version does not start', async (t) => {
  const { upstream, clone, release } = await repositories(t)
  const plan = { root: clone, ...await prepareGit({ root: clone, release, remote: upstream }) }

  const failing = steps({ launch: async () => { failing.calls.push('launch'); if (failing.calls.filter((call) => call === 'launch').length === 1) throw new Error('did not start') } })
  const error = await applyGit(plan, failing)
  assert.match(error.message, /did not start/)
  assert.deepEqual(failing.calls, ['merge', 'launch', 'reset'])
  // Line endings follow the user's core.autocrlf.
  assert.equal((await read(path.join(clone, 'app.js'))).trim(), 'v1')

  const working = steps()
  assert.equal(await applyGit(plan, working), null)
  // package-lock.json did not change: no npm install.
  assert.deepEqual(working.calls, ['merge', 'launch'])
  assert.equal((await read(path.join(clone, 'app.js'))).trim(), 'v2')
})

async function zipInstall(t) {
  const dir = await tempDir(t)
  const root = path.join(dir, 'install')
  const payload = path.join(dir, 'payload')
  for (const [file, text] of [
    ['install/server/index.js', 'old'], ['install/server/gone.js', 'old'], ['install/package-lock.json', 'lock 1'],
    ['install/node_modules/x/index.js', 'dep'], ['install/mine.txt', 'user file'],
    ['payload/server/index.js', 'new'], ['payload/web/dist/index.html', 'ui'], ['payload/package-lock.json', 'lock 2'],
  ]) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await fs.writeFile(path.join(dir, file), text)
  }
  return { root, payload, plan: { root, payload, files: { backup: path.join(dir, 'backup') } } }
}

test('applyZip replaces the app files and keeps dependencies and the user\'s files', async (t) => {
  const { root, plan } = await zipInstall(t)
  const run = steps()
  assert.equal(await applyZip(plan, run), null)
  assert.deepEqual(run.calls, ['npm', 'launch'])
  assert.equal(await read(path.join(root, 'server', 'index.js')), 'new')
  assert.equal(await exists(path.join(root, 'server', 'gone.js')), false)
  assert.equal(await read(path.join(root, 'web', 'dist', 'index.html')), 'ui')
  assert.equal(await read(path.join(root, 'node_modules', 'x', 'index.js')), 'dep')
  assert.equal(await read(path.join(root, 'mine.txt')), 'user file')
})

test('applyZip puts the old version back when npm install fails', async (t) => {
  const { root, plan } = await zipInstall(t)
  let installs = 0
  const run = steps({ npm: async () => { installs += 1; if (installs === 1) throw new Error('offline') } })
  const error = await applyZip(plan, run)
  assert.match(error.message, /offline/)
  // The second install restores the old dependencies; main() then starts the old version.
  assert.equal(installs, 2)
  assert.deepEqual(run.calls, [])
  assert.equal(await read(path.join(root, 'server', 'index.js')), 'old')
  assert.equal(await read(path.join(root, 'server', 'gone.js')), 'old')
  assert.equal(await read(path.join(root, 'package-lock.json')), 'lock 1')
  assert.equal(await exists(path.join(root, 'web')), false)
})

function checker(app) {
  return new UpdateChecker({
    root: '/repo',
    installed: { dsh: '0.2.0', codex: '0.163.0' },
    getChannel: () => 'latest',
    lookup: async () => ({ dsh: { distTags: {}, companionVersions: [] }, codex: { latest: null }, claude: { latest: null } }),
    readClaude: async () => null,
    source: true,
    app: { installed: '0.1.1', method: 'zip', lookup: async () => ({ version: '0.2.0', tag: 'v0.2.0', url: 'https://r/v0.2.0' }), install: async () => {}, ...app },
  })
}

test('the Agent Desk row offers a newer release and runs the update button', async () => {
  const phases = []
  const instance = checker({
    install: async (release, setPhase) => {
      assert.equal(release.version, '0.2.0')
      setPhase('downloading')
      setPhase('installing')
    },
  })
  instance.on('state', (state) => phases.push(state.app.phase))
  const state = await instance.check()
  assert.deepEqual(state.app, { installed: '0.1.1', available: '0.2.0', url: 'https://r/v0.2.0', method: 'zip', phase: 'idle', error: null })
  const after = await instance.installApp()
  assert.equal(after.app.phase, 'installing')
  assert.deepEqual(phases.slice(-2), ['downloading', 'installing'])
  // Already under way: a second press does nothing.
  assert.equal((await instance.installApp()).app.phase, 'installing')
})

test('a failed update shows on the row until the next try', async () => {
  const instance = checker({ install: async (_release, setPhase) => { setPhase('downloading'); throw new Error('作業中のタスクがあります\nmore') } })
  await instance.check()
  const state = await instance.installApp()
  assert.equal(state.app.phase, 'idle')
  assert.equal(state.app.error, '更新できませんでした: 作業中のタスクがあります')
  assert.equal((await instance.check()).app.error, state.app.error)

  const restored = checker({ result: { ok: false, to: '0.2.0', error: '新しい版が起動しませんでした' } })
  assert.match(restored.snapshot().app.error, /0\.2\.0 に更新できなかったので、元の版に戻しました: 新しい版が起動しませんでした/)
  assert.equal(checker({ result: { ok: true, to: '0.2.0' } }).snapshot().app.error, null)

  const latest = checker({ installed: '0.2.0' })
  assert.equal((await latest.check()).app.available, null)
  await assert.rejects(latest.installApp(), /新しい版がありません/)
})

test('the first launch after an update takes over the old port and token once', async (t) => {
  const home = await tempDir(t)
  const files = updateFiles(home)
  await fs.mkdir(files.dir, { recursive: true })
  const claim = () => claimDataFolder({ paths: { home }, serverInfoFile: path.join(home, 'server.json'), codeStamp: 'x', openWindow: false, log: () => {} })

  await fs.writeFile(files.handoff, JSON.stringify({ port: 47139, token: 'abc', windows: 2, at: Date.now() }))
  const first = await claim()
  assert.deepEqual(first.takeover, { port: 47139, token: 'abc', windows: 2 })
  await first.releaseDataLock()
  assert.equal(await exists(files.handoff), false)

  // A stale hand-over is dropped.
  await fs.writeFile(files.handoff, JSON.stringify({ port: 47139, token: 'abc', windows: 2, at: Date.now() - 60 * 60_000 }))
  const second = await claim()
  assert.equal(second.takeover, null)
  await second.releaseDataLock()
})
