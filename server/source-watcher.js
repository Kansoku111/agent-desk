import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** Observe short-lived paths as well as paths that survive the next snapshot. */
export async function watchSource(folder, onChange, onError, signal) {
  if (process.platform !== 'linux') {
    const watcher = fs.watch(folder, { recursive: true }, onChange)
    watcher.on('error', onError)
    return watcher
  }
  // Node's recursive Linux watcher stats new paths after the event: a path
  // already deleted can disappear entirely, including whether it was a directory.
  const root = path.resolve(folder)
  return new Promise((resolve, reject) => {
    const child = spawn('inotifywait', [
      '--monitor', '--recursive', '--no-dereference', '--no-newline',
      '--event', 'modify,attrib,create,delete,moved_from,moved_to,delete_self,move_self,unmount',
      '--format', '%e%0%w%f%0', '--', root,
    ], { env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let ready = false, closed = false, stderr = '', pending = '', event = null
    const fail = (error) => {
      clearTimeout(timer)
      if (closed) return
      if (ready) { onError(error); return }
      closed = true
      child.kill()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('Linux のファイル監視の開始が制限時間を超えました。')), 10_000)
    child.once('error', (error) => fail(new Error(error.code === 'ENOENT'
      ? 'Linux の検証には inotifywait が必要です。inotify-tools をインストールしてください。'
      : 'Linux のファイル監視を開始できませんでした: ' + error.message)))
    child.once('close', (code) => fail(new Error('Linux のファイル監視が終了しました (' + code + '): ' + stderr.trim())))
    child.stderr.setEncoding('utf8').on('data', (text) => {
      stderr = (stderr + text).slice(-4096)
      if (!ready && stderr.includes('Watches established.')) {
        ready = true
        clearTimeout(timer)
        resolve({ close() { closed = true; child.kill() } })
      }
    })
    child.stdout.setEncoding('utf8').on('data', (text) => {
      pending += text
      let end
      while ((end = pending.indexOf('\0')) >= 0) {
        const value = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (event === null) { event = value; continue }
        const flags = event
        event = null
        const name = path.relative(root, value)
        if (!name || name === '..' || name.startsWith('../') || path.isAbsolute(name) || /Q_OVERFLOW|UNMOUNT/.test(flags)) {
          onError(new Error('Linux のファイル監視で変更範囲を確認できませんでした。'))
          continue
        }
        onChange(/CREATE|DELETE|MOVED|MOVE_SELF/.test(flags) ? 'rename' : 'change', name, flags.split(',').includes('ISDIR'))
      }
    })
  })
}
