// The "build and restart" button: rebuilds the UI, then restarts this server
// on the same port and token, so open windows reconnect and reload by
// themselves. Running tasks are stopped (shutdown), unlike an update, which
// waits for them. The build runs first: when it fails the app keeps running.
import { execFile, spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { updateFiles } from './app-update.js'

/** Files the restart leaves in the data folder (under app-update/, next to an update's). */
export function restartFiles(home) {
  const files = updateFiles(home)
  return { ...files, restartPlan: path.join(files.dir, 'restart-plan.json'), restartLog: path.join(files.dir, 'restart.log') }
}

/** The UI build, as `npm run build` does it. Rejects with the build's last line. */
export function buildUi(root) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'web/vite.config.ts', '--logLevel', 'warn'],
      { cwd: root, windowsHide: true, timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve()
        const last = `${stderr}\n${stdout}`.trim().split('\n').at(-1)?.trim()
        reject(new Error(`ビルドに失敗しました${last ? `: ${last}` : ''}`))
      },
    )
  })
}

/** Starts scripts/restart-app.mjs, which outlives this server. */
function startRestarter({ root, planFile }) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'restart-app.mjs'), planFile], {
    cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
  })
  child.unref()
}

/**
 * `handoff` gives the port, token and number of open windows the next server
 * takes over; `shutdown` stops this one after the reply went out.
 */
export function createAppRestarter({ root, home, args, handoff, shutdown, build = buildUi, start = startRestarter, log = () => {} }) {
  const files = restartFiles(home)
  let pending = false
  return async () => {
    if (pending) throw new Error('再起動の準備中です')
    pending = true
    try {
      await build(root)
      await fsp.mkdir(files.dir, { recursive: true })
      await fsp.writeFile(files.restartPlan, JSON.stringify({ pid: process.pid, root, args, handoff: handoff(), files }, null, 2))
      start({ root, planFile: files.restartPlan })
      log('restarting; the restarter takes over')
      // Give the windows a moment to hear that the restart is under way.
      setTimeout(() => void shutdown(0), 300)
    } catch (error) {
      pending = false
      throw error
    }
  }
}
