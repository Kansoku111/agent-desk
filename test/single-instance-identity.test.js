import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const singleInstance = pathToFileURL(fileURLToPath(new URL('../server/single-instance.js', import.meta.url))).href

/** An instance that answers ping like Agent Desk does and accepts only `token`. */
async function instanceAccepting(token) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/ping') {
      return res.end(JSON.stringify({ app: 'agent-desk', version: 'test', codeStamp: 'current', busy: false, clients: 0, remoteClients: 0 }))
    }
    if (url.pathname === '/api/auth') {
      res.statusCode = url.searchParams.get('t') === token ? 200 : 403
      return res.end(res.statusCode === 200 ? 'ok' : 'forbidden')
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

/** One launch's check of its data folder, run in a child process (an existing instance ends that process). */
async function claimFolder(home, serverInfo) {
  await fs.writeFile(path.join(home, 'server.json'), JSON.stringify(serverInfo))
  const script = path.join(home, 'claim.mjs')
  await fs.writeFile(script, `import path from 'node:path'
import { claimDataFolder } from ${JSON.stringify(singleInstance)}
const home = process.env.TEST_HOME
const { releaseDataLock } = await claimDataFolder({
  paths: { home, browserProfile: path.join(home, 'browser') }, serverInfoFile: path.join(home, 'server.json'),
  codeStamp: 'current', openWindow: false, log: (...parts) => console.log(...parts),
})
console.log('claimed')
await releaseDataLock()
`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, TEST_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { output += data })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}

test('a server.json whose port another folder\'s instance answers for does not make this launch a duplicate', { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-identity-'))
  const other = await instanceAccepting('the other folder\'s token')
  t.after(async () => {
    other.close()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const { port } = other.address()
  // A crash left this folder's server.json behind; its port now belongs to the other folder's instance.
  const result = await claimFolder(home, { port, token: 'this folder\'s stale token', pid: 1 })
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /claimed/)
  assert.doesNotMatch(result.output, /already running/)
})

test('an instance that accepts the server.json token is the one this launch joins', { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-identity-'))
  const token = 'a'.repeat(48)
  const running = await instanceAccepting(token)
  t.after(async () => {
    running.close()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const { port } = running.address()
  const result = await claimFolder(home, { port, token, pid: 1 })
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /already running/)
  assert.doesNotMatch(result.output, /claimed/)
})
