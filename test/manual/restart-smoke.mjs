// Starts an isolated Agent Desk, presses "build and restart" over its WebSocket and
// checks that a new server answers on the same port and token. Never sends a prompt.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const root = path.resolve(import.meta.dirname, '..', '..')
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-restart-smoke-'))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const env = { ...process.env, AGENT_DESK_HOME: home }
const info = async () => JSON.parse(await fs.readFile(path.join(home, 'server.json'), 'utf8'))
const ping = (port) => fetch(`http://127.0.0.1:${port}/api/ping`).then((response) => response.json()).catch(() => null)

async function until(label, check, ms = 90_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await check().catch(() => null)
    if (value) return value
    await wait(300)
  }
  throw new Error(`timed out: ${label}`)
}

const first = spawn(process.execPath, [path.join(root, 'server', 'index.js'), '--no-open', '--keep-alive'], { cwd: root, env, stdio: 'ignore', windowsHide: true })
let second
try {
  const before = await until('first server', async () => {
    const value = await info()
    return (await ping(value.port)) ? value : null
  })
  console.log(`first:  pid ${before.pid} port ${before.port}`)

  const reply = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${before.port}/ws?t=${before.token}`, { origin: `http://127.0.0.1:${before.port}` })
    socket.on('error', reject)
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, type: 'app.restart' })))
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw))
      if (frame.id === 1) { resolve(frame); socket.close() }
    })
  })
  console.log(`reply:  ${JSON.stringify(reply)}`)
  if (!reply.ok) throw new Error(reply.error)

  const after = await until('second server', async () => {
    const value = await info()
    return value.pid !== before.pid && (await ping(value.port)) ? value : null
  })
  second = after.pid
  console.log(`second: pid ${after.pid} port ${after.port} (same port: ${after.port === before.port}, same token: ${after.token === before.token})`)
  if (after.port !== before.port || after.token !== before.token) throw new Error('the new server did not take over the port and token')
  await until('old server gone', async () => first.exitCode !== null || first.signalCode !== null)
  console.log('old server exited')
} finally {
  // Both servers started here, with the helper processes they spawned.
  for (const pid of [first.pid, second]) {
    if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  await wait(1500)
  // This directory was created by this process exclusively for the smoke test.
  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
}
