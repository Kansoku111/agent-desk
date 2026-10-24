// The launch-time check on this data folder (see index.js): one instance per
// folder, replacing an idle instance that runs older code or waiting for a busy one.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { updateFiles } from './app-update.js'
import { tryAcquireDataLock } from './data-lock.js'
import { readJson } from './json-file.js'
import { openAppWindow } from './system.js'

/**
 * Claims the data folder before any shared state loads. Resolves to the instance
 * this launch took over (or null) and the data lock; exits when another launch serves.
 */
export async function claimDataFolder({ paths, serverInfoFile, codeStamp, openWindow, log }) {
  /** A launch waiting for a busy older instance to go idle (see {@link waitToReplace}). */
  const successorFile = path.join(paths.home, 'successor.json')

  async function ping(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) })
      const body = await response.json()
      return body?.app === 'agent-desk' ? body : null
    } catch {
      return null
    }
  }

  /** Whether the instance on this port accepts the token: after a crash, the port may belong to another data folder's instance. */
  async function accepts(port, token) {
    try {
      return await new Promise((resolve, reject) => {
        // No keep-alive: an open pooled connection makes process.exit trip a libuv assertion on Windows.
        const request = http.get({ host: '127.0.0.1', port, path: `/api/auth?t=${encodeURIComponent(token)}`, agent: false, timeout: 1500 }, (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode === 200))
        })
        request.on('timeout', () => request.destroy(new Error('no answer')))
        request.on('error', reject)
      })
    } catch {
      return false
    }
  }

  async function existingInstance() {
    const info = await readJson(serverInfoFile, null)
    if (!info?.port || !info?.token) return null
    const status = await ping(info.port)
    if (!status || !(await accepts(info.port, info.token))) return null
    return { ...info, status }
  }

  /** Asks an idle instance to exit and waits until it has; false when it is busy. */
  async function quitInstance(instance) {
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/api/quit?t=${instance.token}`, { method: 'POST', signal: AbortSignal.timeout(3000) })
      // An instance from before this endpoint existed answers with the app page instead.
      if (!response.ok || (await response.text()) !== 'bye') return false
    } catch {
      return false
    }
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (!(await ping(instance.port))) return true
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return false
  }

  /** Whether another live launch of this same code is already waiting to replace the instance. */
  function successorWaiting() {
    const info = (() => {
      try {
        return JSON.parse(fs.readFileSync(successorFile, 'utf8'))
      } catch {
        return null
      }
    })()
    if (!info?.pid || info.pid === process.pid || info.codeStamp !== codeStamp) return false
    try {
      process.kill(info.pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * Waits in the background until a busy instance running older code has no
   * task running, then lets the normal takeover replace it. A launch used to
   * give up when the instance was busy, so with tasks always running the new
   * code never took over. Returns the idle instance, or null when it went away
   * or something else replaced it (then this launch has nothing to do).
   */
  async function waitToReplace(running) {
    fs.writeFileSync(successorFile, JSON.stringify({ pid: process.pid, codeStamp }))
    const forget = () => {
      try {
        if (JSON.parse(fs.readFileSync(successorFile, 'utf8')).pid === process.pid) fs.rmSync(successorFile)
      } catch {}
    }
    process.once('exit', forget)
    try {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 10_000))
        const now = await existingInstance()
        if (!now || now.port !== running.port || now.status.codeStamp === codeStamp) return null
        if (!now.status.busy) return now
      }
    } finally {
      forget()
    }
  }

  let takeover = null
  let releaseDataLock = null
  let lockWaitStarted = null
  // Discovery alone is not a lock: two cold starts can both miss server.json.
  // Hold an OS-owned lock before loading any shared state, including in dev mode.
  while (!releaseDataLock) {
    let running = await existingInstance()
    let waited = false
    while (running) {
      const stale = running.status.codeStamp !== codeStamp
      if (stale && !running.status.busy && await quitInstance(running)) {
        log('replaced an instance that was running older code')
        takeover = { port: running.port, token: running.token, windows: running.status.clients ?? 0 }
        break
      }
      const url = `http://127.0.0.1:${running.port}/?t=${running.token}`
      // The window opens once, on the instance the user can use right now.
      if (openWindow && !waited) openAppWindow(url, paths.browserProfile)
      if (!stale) {
        log(`already running: ${url}`)
        process.exit(0)
      }
      // Idle yet it refused to quit (an instance from before /api/quit): it cannot be replaced.
      const now = running.status.busy ? running : await existingInstance()
      if (now && !now.status.busy) {
        log(`an instance running older code could not be replaced; using it: ${url}`)
        if (openWindow && waited) openAppWindow(url, paths.browserProfile)
        process.exit(0)
      }
      if (!waited && successorWaiting()) {
        log('an instance running older code is busy; another launch is already waiting to replace it')
        process.exit(0)
      }
      // Busy (or it turned busy just as it was asked to quit): wait for its tasks.
      log('an instance running older code is busy; replacing it once its tasks finish')
      waited = true
      running = await waitToReplace(running)
      if (!running) {
        log('the older instance went away or was replaced; nothing to do')
        process.exit(0)
      }
    }
    releaseDataLock = await tryAcquireDataLock(paths.home)
    if (!releaseDataLock) {
      lockWaitStarted ??= Date.now()
      if (Date.now() - lockWaitStarted > 60_000) {
        throw new Error('Agent Desk のデータフォルダーは別の起動処理が使用中です。しばらく待ってから再起動してください。')
      }
      // The winning launch has not published server.json yet. Wait for discovery
      // rather than starting a second writer on an automatically chosen port.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  // An update (scripts/apply-update.mjs) stopped the old instance itself and
  // left its port and token here, so the windows still open reconnect.
  takeover ??= handedOver(updateFiles(paths.home).handoff)

  return { takeover, releaseDataLock }
}

const HANDOFF_MAX_AGE_MS = 30 * 60_000

function handedOver(file) {
  let handoff
  try {
    handoff = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  } finally {
    // Used once: a later launch starts on its own port and token.
    fs.rmSync(file, { force: true })
  }
  const fresh = Date.now() - handoff?.at < HANDOFF_MAX_AGE_MS
  if (!fresh || !Number.isInteger(handoff.port) || typeof handoff.token !== 'string' || !handoff.token) return null
  return { port: handoff.port, token: handoff.token, windows: Number(handoff.windows) || 0 }
}
