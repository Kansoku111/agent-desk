// Agent Desk's own updates: the releases of its GitHub repository (the one in
// package.json) and the update button.
//
// A git checkout moves forward to the release's tag; any other install takes
// the release's zip (scripts/pack-release.mjs). Both are made ready while this
// server runs. The files themselves are swapped by scripts/apply-update.mjs
// once this server has exited, since Windows keeps a running program's files
// locked. It then starts the new version on this server's port and token, so
// the open windows reconnect and reload by themselves, and puts the old
// version back when the new one does not start.
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { compareVersions, isVersion } from './update-checks.js'

/** The release file a zip install takes. */
export const releaseAsset = (version) => `AgentDesk-${version}.zip`

/** Files the update leaves in the data folder (all under app-update/). */
export function updateFiles(home) {
  const dir = path.join(home, 'app-update')
  return {
    dir,
    download: path.join(dir, 'download'),
    backup: path.join(dir, 'backup'),
    plan: path.join(dir, 'plan.json'),
    script: path.join(dir, 'apply-update.mjs'),
    // The port and token the next launch takes over (single-instance.js).
    handoff: path.join(dir, 'handoff.json'),
    // How the last update went, read once by the next server.
    result: path.join(dir, 'result.json'),
    log: path.join(dir, 'update.log'),
  }
}

const BUSY = '作業中のタスクがあります。終わってから更新してください'

/** "owner/name" of the GitHub repository in package.json's `repository`, or null. */
export function githubRepository(pkg) {
  const url = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url ?? '')
  return match ? `${match[1]}/${match[2]}` : null
}

/** How this install updates: a git checkout by its tags, anything else by the release zip. */
export function installMethod(root) {
  return fs.existsSync(path.join(root, '.git')) ? 'git' : 'zip'
}

/**
 * The newest published release (drafts and prereleases left out), or null.
 * With `needAsset`, releases without the zip are skipped: a zip install cannot take them.
 */
export async function latestRelease({ repo, needAsset = false, fetch = globalThis.fetch }) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-desk', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GitHub が ${response.status} を返しました`)
  let best = null
  for (const release of await response.json()) {
    if (release.draft || release.prerelease) continue
    const version = String(release.tag_name ?? '').replace(/^v/, '')
    if (!isVersion(version) || (best && compareVersions(version, best.version) <= 0)) continue
    const asset = release.assets?.find((entry) => entry.name === releaseAsset(version))
    if (needAsset && !asset) continue
    best = {
      version,
      tag: release.tag_name,
      url: release.html_url,
      asset: asset ? { url: asset.browser_download_url, digest: asset.digest ?? null } : null,
    }
  }
  return best
}

function run(file, args, { cwd, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || stdout || error.message).trim().slice(-1500)))
      resolve(stdout)
    })
  })
}

/**
 * Fetches the release's tag into a git checkout and resolves to the commit to
 * move to. Refuses a checkout that cannot simply move forward to it.
 */
export async function prepareGit({ root, repo, release, remote = `https://github.com/${repo}.git`, git = (args) => run('git', args, { cwd: root }) }) {
  if ((await git(['status', '--porcelain', '--untracked-files=no'])).trim()) {
    throw new Error('コミットしていない変更があります')
  }
  const ref = `refs/tags/${release.tag}`
  await git(['fetch', '--no-tags', remote, `+${ref}:${ref}`])
  const head = (await git(['rev-parse', 'HEAD'])).trim()
  const target = (await git(['rev-parse', `${ref}^{commit}`])).trim()
  try {
    await git(['merge-base', '--is-ancestor', head, target])
  } catch {
    throw new Error(`手元のコミットが ${release.tag} にないため、自動では更新できません。git で更新してください`)
  }
  return { head, target }
}

/** Unpacks a zip with the system's own tool. */
export function extractZip(zip, dir) {
  // Windows 10 and later ship bsdtar, which reads zip files (Git's GNU tar on PATH does not).
  if (process.platform === 'win32') {
    return run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir])
  }
  return run('unzip', ['-q', zip, '-d', dir])
}

/** The folder holding package.json: the zip's top level or its one folder. */
async function packageRoot(dir) {
  if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory())
  if (entries.length === 1 && fs.existsSync(path.join(dir, entries[0].name, 'package.json'))) return path.join(dir, entries[0].name)
  throw new Error('配布用ファイルに package.json がありません')
}

/** Downloads the release zip, checks it against GitHub's hash and unpacks it; resolves to the new version's folder. */
export async function prepareZip({ release, dir, fetch = globalThis.fetch, extract = extractZip }) {
  if (!release.asset) throw new Error(`${release.tag} に配布用のファイル（${releaseAsset(release.version)}）がありません`)
  const expected = /^sha256:([0-9a-f]{64})$/i.exec(release.asset.digest ?? '')?.[1]?.toLowerCase()
  if (!expected) throw new Error('配布用ファイルのハッシュ値がありません')
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(dir, { recursive: true })
  const zip = path.join(dir, releaseAsset(release.version))
  const response = await fetch(release.asset.url, { headers: { 'user-agent': 'agent-desk' }, signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`ダウンロードに失敗しました（${response.status}）`)
  const hash = createHash('sha256')
  const digest = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk)
      done(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), digest, fs.createWriteStream(zip))
  if (hash.digest('hex') !== expected) throw new Error('ダウンロードしたファイルが壊れています（ハッシュ値が一致しません）')
  const out = path.join(dir, 'files')
  await fsp.mkdir(out)
  await extract(zip, out)
  const payload = await packageRoot(out)
  const pkg = JSON.parse(await fsp.readFile(path.join(payload, 'package.json'), 'utf8'))
  if (pkg.name !== 'agent-desk' || pkg.version !== release.version) {
    throw new Error(`配布用ファイルの中身が ${release.version} ではありません`)
  }
  return payload
}

/** Starts scripts/apply-update.mjs from a copy in the data folder: the install it replaces holds the original. */
export async function startApplier({ root, files, plan }) {
  await fsp.mkdir(files.dir, { recursive: true })
  await fsp.copyFile(path.join(root, 'scripts', 'apply-update.mjs'), files.script)
  await fsp.writeFile(files.plan, JSON.stringify(plan, null, 2))
  const child = spawn(process.execPath, [files.script, files.plan], { cwd: files.dir, detached: true, windowsHide: true, stdio: 'ignore' })
  child.unref()
}

/** How the last update went (written by apply-update.mjs), once; null when there was none. */
export async function takeUpdateResult(home) {
  const file = updateFiles(home).result
  try {
    const result = JSON.parse(await fsp.readFile(file, 'utf8'))
    await fsp.rm(file, { force: true })
    return result && typeof result === 'object' ? result : null
  } catch {
    return null
  }
}

/**
 * The update button's work: gets the release ready, then hands over to the
 * applier and shuts this server down. `handoff` gives the port, token and
 * number of open windows the next version takes over.
 */
export function createAppInstaller({ root, home, repo, method, version, args, busy, handoff, shutdown, fetch, log = () => {} }) {
  const files = updateFiles(home)
  return async (release, setPhase) => {
    if (busy()) throw new Error(BUSY)
    setPhase('downloading')
    const plan = {
      method, root, from: version, to: release.version, pid: process.pid, args,
      ...(method === 'git'
        ? await prepareGit({ root, repo, release })
        : { payload: await prepareZip({ release, dir: files.download, fetch }) }),
      files,
    }
    // A task may have started while the release downloaded.
    if (busy()) throw new Error(BUSY)
    plan.handoff = handoff()
    setPhase('installing')
    await startApplier({ root, files, plan })
    log(`updating to ${release.version} (${method}); the updater takes over`)
    // Give the windows a moment to hear that the update is under way.
    setTimeout(() => void shutdown(0), 300)
  }
}
