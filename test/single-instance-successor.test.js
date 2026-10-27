// A launch that waited for a busy instance running older code must still start
// when that instance goes away, and must join a same-code replacement without
// becoming a second writer of the folder.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tryAcquireDataLock } from '../server/data-lock.js'

const singleInstance = pathToFileURL(fileURLToPath(new URL('../server/single-instance.js', import.meta.url))).href
const TOKEN = 'd'.repeat(48)
const OLD_STAMP = 'old-code'
const NEW_STAMP = 'new-code'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A stand-in Agent Desk instance: ping/auth only, no real server or data. */
function fakeInstance({ codeStamp, busy, token = TOKEN }) {
  let isBusy = busy
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/ping') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ app: 'agent-desk', version: 'test', codeStamp, busy: isBusy, clients: 0, remoteClients: 0 }))
      return
    }
    if (url.pathname === '/api/auth') {
      res.statusCode = url.searchParams.get('t') === token ? 200 : 403
      res.end(res.statusCode === 200 ? 'ok' : 'forbidden')
      return
    }
    res.statusCode = 404
    res.end()
  })
  return {
    async listen(port = 0) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await new Promise((resolve, reject) => {
            const failed = (error) => reject(error)
            server.once('error', failed)
            server.listen(port, '127.0.0.1', () => {
              server.off('error', failed)
              resolve()
            })
          })
          return server.address().port
        } catch (error) {
          if (error.code !== 'EADDRINUSE' || attempt >= 20) throw error
          await wait(100)
        }
      }
    },
    async close() {
      server.closeAllConnections?.()
      if (!server.listening) return
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** One launch's claimDataFolder() in a child: an existing instance ends that process. */
async function launch(home, codeStamp) {
  const script = path.join(home, 'claim.mjs')
  await fs.writeFile(script, `import path from 'node:path'
import { claimDataFolder } from ${JSON.stringify(singleInstance)}
const home = process.env.TEST_HOME
const { takeover, releaseDataLock } = await claimDataFolder({
  paths: { home, browserProfile: path.join(home, 'browser') },
  serverInfoFile: path.join(home, 'server.json'),
  codeStamp: process.env.TEST_STAMP, openWindow: false,
  log: (...parts) => console.log('LOG ' + parts.join(' ')),
})
console.log('CLAIMED ' + JSON.stringify({ takeover }))
await releaseDataLock()
console.log('RELEASED')
`)
  const child = spawn(process.execPath, [script], {
    cwd: home,
    env: { ...process.env, TEST_HOME: home, TEST_STAMP: codeStamp, AGENT_DESK_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)))
  return {
    get output() { return output },
    async waitFor(pattern, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (pattern.test(output)) return
        await wait(25)
      }
      throw new Error(`timed out waiting for ${pattern}:\n${output}`)
    },
    async exit(timeoutMs = 25_000) {
      const code = await Promise.race([exited, wait(timeoutMs).then(() => null)])
      return { code, output }
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill()
      await Promise.race([exited, wait(3000)])
    },
  }
}

async function temporaryHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-successor-'))
}

test('a waiting launch starts after the busy old instance goes away', { timeout: 45_000 }, async (t) => {
  const home = await temporaryHome()
  const old = fakeInstance({ codeStamp: OLD_STAMP, busy: true })
  const port = await old.listen()
  await fs.writeFile(path.join(home, 'server.json'), JSON.stringify({ port, token: TOKEN, pid: process.pid }))
  const run = await launch(home, NEW_STAMP)
  t.after(async () => {
    await run.stop()
    await old.close()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  await run.waitFor(/replacing it once its tasks finish/)
  // The old instance dies (crash or forced quit): its OS lock dies with it.
  await old.close()
  const { code, output } = await run.exit()
  assert.equal(code, 0, output)
  // It took the folder instead of reporting that there was nothing to do.
  assert.match(output, /CLAIMED \{"takeover":null\}/, output)
  assert.match(output, /RELEASED/, output)
})

test('a waiting launch joins a same-code replacement instead of taking the lock', { timeout: 45_000 }, async (t) => {
  const home = await temporaryHome()
  // Stands in for the replacement process's OS lock: it is held for the whole test.
  const lock = await tryAcquireDataLock(home)
  assert.equal(typeof lock, 'function')
  let lockReleased = false
  const releaseLock = async () => {
    if (lockReleased) return
    lockReleased = true
    await lock()
  }
  const old = fakeInstance({ codeStamp: OLD_STAMP, busy: true })
  const oldPort = await old.listen()
  await fs.writeFile(path.join(home, 'server.json'), JSON.stringify({ port: oldPort, token: TOKEN, pid: process.pid }))
  const run = await launch(home, NEW_STAMP)
  let replacement = null
  t.after(async () => {
    await run.stop()
    await replacement?.close()
    await old.close()
    await releaseLock()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  await run.waitFor(/replacing it once its tasks finish/)
  // Another launch of this same new code replaced the old instance and already
  // holds the folder lock. Keep its port and token in server.json for discovery.
  await old.close()
  replacement = fakeInstance({ codeStamp: NEW_STAMP, busy: false })
  let replacementPort
  try {
    replacementPort = await replacement.listen(oldPort)
  } catch {
    replacementPort = await replacement.listen(0)
  }
  await fs.writeFile(path.join(home, 'server.json'), JSON.stringify({ port: replacementPort, token: TOKEN, pid: process.pid }))

  const { code, output } = await run.exit()
  assert.equal(code, 0, output)
  // It found the replacement and joined it; it never claimed the folder.
  assert.match(output, /already running/, output)
  assert.doesNotMatch(output, /CLAIMED/, output)
  // The replacement still owns the folder lock, so a second writer cannot start.
  const extra = await tryAcquireDataLock(home)
  if (extra) await extra()
  assert.equal(extra, null)
})
