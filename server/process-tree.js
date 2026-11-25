// Ending a timed-out child together with everything it started.
// On Windows, `git` on PATH is usually Git for Windows' cmd\git.exe, a launcher
// that runs the real git as its child, and npm or a .cmd shim runs under
// cmd.exe. Killing only the direct child (what execFile's own timeout and abort
// do) leaves the real program running: it keeps its locks (a snapshot's
// index.lock) and its CPU after the caller has given up on it.
import { execFile, spawn } from 'node:child_process'

/** Ends `child` and, on Windows, its whole process tree; resolves once the kill has been carried out. */
export function killTree(child, { platform = process.platform, spawnImpl = spawn } = {}) {
  const fallback = () => { try { child.kill() } catch {} }
  if (platform !== 'win32' || !child?.pid) {
    fallback()
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let killer
    try {
      killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      fallback()
      return resolve()
    }
    killer.on('error', () => { fallback(); resolve() })
    killer.on('exit', () => resolve())
  })
}

/**
 * execFile, but `timeout` and `signal` end the whole process tree, and the callback
 * runs only after that. The error then has `killed: true` (an abort is an AbortError).
 */
export function execFileTree(file, args, options = {}, callback) {
  const { timeout = 0, signal, ...rest } = options
  let ending = null
  let aborted = false
  const end = (byAbort) => {
    aborted ||= byAbort
    ending ??= killTree(child)
  }
  const onAbort = () => end(true)
  const child = execFile(file, args, rest, (error, stdout, stderr) => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (!ending) return callback(error, stdout, stderr)
    const stopped = aborted
      ? Object.assign(new Error('The operation was aborted', { cause: signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' })
      : (error ?? new Error(`Command timed out: ${file}`))
    Object.assign(stopped, { killed: true, stdout, stderr })
    void ending.then(() => callback(stopped, stdout, stderr))
  })
  const timer = timeout > 0 ? setTimeout(() => end(false), timeout) : null
  if (signal?.aborted) end(true)
  else signal?.addEventListener('abort', onAbort, { once: true })
  return child
}

/** The promise form of execFileTree, like promisify(execFile): resolves { stdout, stderr }, carries `child`. */
export function execFileTreeAsync(file, args, options = {}) {
  let child
  const promise = new Promise((resolve, reject) => {
    child = execFileTree(file, args, options, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stdout, stderr }))
      resolve({ stdout, stderr })
    })
  })
  promise.child = child
  return promise
}
