// Puts a new Agent Desk release in place once the server that asked for it has
// exited, then starts it on that server's port and token (server/app-update.js).
// When anything fails, or the new version does not start, it puts the old
// version back and starts that instead. How it went is left in result.json for
// the next server to show.
//
// It runs from a copy in the data folder, so it uses nothing from the install
// it replaces.
//   node apply-update.mjs <plan.json>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Top-level entries of a release that are never copied: they belong to the install. */
const KEEP = new Set(['node_modules', '.git'])

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Waits for the old server to exit; ends it when its shutdown hangs. */
export async function waitForExit(pid, { timeoutMs = 90_000, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs
  while (alive(pid) && Date.now() < deadline) await wait(250)
  if (!alive(pid)) return
  log(`server ${pid} is still running; ending it`)
  try {
    process.kill(pid)
  } catch {}
  for (let i = 0; i < 40 && alive(pid); i += 1) await wait(250)
  if (alive(pid)) throw new Error('前の Agent Desk が終了しません')
}

/** Retries a file operation while the old server's helpers still let go of their files. */
async function retry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= 20 || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error
      await wait(500)
    }
  }
}

const exists = (file) => fs.existsSync(file)
const readText = (file) => fsp.readFile(file, 'utf8').catch(() => null)

/** Makes each of `names` in `to` what it is in `from`: replaced, or removed when `from` has none. */
async function replace(from, to, names) {
  for (const name of names) {
    await retry(() => fsp.rm(path.join(to, name), { recursive: true, force: true }))
    if (!exists(path.join(from, name))) continue
    // Timestamps kept: the launcher rebuilds the UI when its sources look newer than the build.
    await retry(() => fsp.cp(path.join(from, name), path.join(to, name), { recursive: true, preserveTimestamps: true }))
  }
}

/**
 * A zip install: the release's files over the install's, after a backup of
 * what they replace. Resolves to null once the new version runs, or to the
 * error after the old files are back (main() then starts the old version).
 */
export async function applyZip(plan, { npm, launch, log }) {
  const { root, payload } = plan
  const backup = plan.files.backup
  const names = (await fsp.readdir(payload)).filter((name) => !KEEP.has(name))
  await fsp.rm(backup, { recursive: true, force: true })
  await fsp.mkdir(backup, { recursive: true })
  for (const name of names) {
    if (exists(path.join(root, name))) await fsp.cp(path.join(root, name), path.join(backup, name), { recursive: true, preserveTimestamps: true })
  }
  const lock = path.join(root, 'package-lock.json')
  const oldLock = await readText(lock)
  let installed = false
  try {
    log('copying the new files')
    await replace(payload, root, names)
    if (await readText(lock) !== oldLock || !exists(path.join(root, 'node_modules'))) {
      installed = true
      await npm(root)
    }
    await launch(plan)
    return null
  } catch (error) {
    log(`update failed: ${error.message}; restoring the previous version`)
    await replace(backup, root, names).catch((failure) => {
      throw new Error(`元の版に戻せませんでした。バックアップは ${backup} にあります（${failure.message}）`)
    })
    if (installed) await npm(root).catch((failure) => log(`npm install (restore): ${failure.message}`))
    return error
  }
}

/** A git checkout: a fast-forward to the release's commit, undone by a reset when it does not start (as applyZip). */
export async function applyGit(plan, { git, npm, launch, log }) {
  const { root } = plan
  const lock = path.join(root, 'package-lock.json')
  const oldLock = await readText(lock)
  let moved = false
  let installed = false
  try {
    log(`git merge --ff-only ${plan.target}`)
    await git(['merge', '--ff-only', plan.target], root)
    moved = true
    if (await readText(lock) !== oldLock) {
      installed = true
      await npm(root)
    }
    await launch(plan)
    return null
  } catch (error) {
    log(`update failed: ${error.message}; restoring the previous version`)
    // --keep: only what the merge changed goes back.
    if (moved) await git(['reset', '--keep', plan.head], root).catch((failure) => log(`git reset: ${failure.message}`))
    if (installed) await npm(root).catch((failure) => log(`npm install (restore): ${failure.message}`))
    return error
  }
}

function output(file, args, { cwd, shell = false, timeoutMs }, log) {
  return new Promise((resolve, reject) => {
    const child = shell
      // npm is a .cmd script on Windows, which only a shell can start; every argument is a constant.
      ? spawn(`${file} ${args.join(' ')}`, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { text += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { text += chunk })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (text.trim()) log(text.trim())
      if (code === 0) return resolve(text)
      reject(new Error(`${path.basename(file)} ${args[0] ?? ''} が失敗しました（コード ${code}）: ${text.trim().split('\n').at(-1) ?? ''}`.trim()))
    })
  })
}

/** The real steps: npm, git and the install's own launcher. */
export function systemSteps(log) {
  return {
    npm: (root) => {
      log('npm install')
      return output('npm', ['install', '--no-save', '--no-audit', '--no-fund'], { cwd: root, shell: process.platform === 'win32', timeoutMs: 15 * 60_000 }, log)
    },
    git: (args, root) => output('git', args, { cwd: root, timeoutMs: 120_000 }, log),
    // scripts/launch.mjs builds the UI when needed and exits 0 once the server listens.
    launch: async (plan) => {
      await fsp.writeFile(plan.files.handoff, JSON.stringify({ ...plan.handoff, at: Date.now() }))
      log('starting Agent Desk')
      await output(process.execPath, [path.join(plan.root, 'scripts', 'launch.mjs'), ...plan.args], { cwd: plan.root, timeoutMs: 5 * 60_000 }, log)
        .catch(() => { throw new Error('新しい版が起動しませんでした') })
    },
  }
}

export async function main(planFile) {
  const plan = JSON.parse(await fsp.readFile(planFile, 'utf8'))
  // It holds the window token; nothing needs it once read.
  await fsp.rm(planFile, { force: true })
  const files = plan.files
  await fsp.writeFile(files.log, `[${new Date().toISOString()}] ${plan.from} → ${plan.to} (${plan.method}) in ${plan.root}\n`)
  const log = (line) => fs.appendFileSync(files.log, `${line}\n`)
  const steps = systemSteps(log)
  let error
  try {
    await waitForExit(plan.pid, { log })
    error = await (plan.method === 'git' ? applyGit : applyZip)(plan, { ...steps, log })
  } catch (failure) {
    // The old server would not exit, or the old files could not be put back.
    error = failure
    log(`update stopped: ${failure.message}`)
  }
  // Written before the old version starts again, so that it shows what went wrong.
  const result = { from: plan.from, to: plan.to, ok: !error, error: error ? error.message : null, at: Date.now() }
  await fsp.writeFile(files.result, JSON.stringify(result))
  if (error) await steps.launch(plan).catch((failure) => log(`launch (previous version): ${failure.message}`))
  await fsp.rm(files.download, { recursive: true, force: true }).catch(() => {})
  log(error ? 'done: kept the previous version' : 'done')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2])
}
