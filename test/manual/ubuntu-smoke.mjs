// Isolated Ubuntu smoke check: no provider credentials or model prompts are used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import * as pty from 'node-pty'

if (process.platform !== 'linux') throw new Error('Run this smoke check on Ubuntu.')
const root = path.resolve(import.meta.dirname, '..', '..')
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-ubuntu-smoke-'))
const workspace = path.join(home, '日本語 space [project]')
await fs.mkdir(workspace)
let child, socket, shell
async function within(promise, label, ms = 30_000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out: ' + label)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function start() {
  child = spawn(process.execPath, [path.join(root, 'server/index.js'), '--no-open', '--port', '0'], {
    cwd: root, env: { ...process.env, AGENT_DESK_HOME: home }, stdio: 'ignore',
  })
  child.on('error', () => {})
  const info = await within((async () => {
    while (child.exitCode === null && child.signalCode === null) {
      try { return JSON.parse(await fs.readFile(path.join(home, 'server.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('server exited before startup')
  })(), 'server startup')
  const base = 'http://127.0.0.1:' + info.port
  assert.equal((await fetch(base + '/api/ping')).status, 200)
  const page = await fetch(base + '/?t=' + encodeURIComponent(info.token))
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<html/)
  socket = new WebSocket('ws://127.0.0.1:' + info.port + '/ws?t=' + info.token, { origin: base })
  const hello = new Promise((resolve, reject) => {
    socket.on('error', reject)
    socket.on('message', raw => { const frame = JSON.parse(String(raw)); if (frame.event === 'hello') resolve(frame.state) })
  })
  return within(hello, 'authenticated hello')
}
async function rpc(type, params) {
  const active = socket
  return within(new Promise((resolve, reject) => {
    const reply = raw => {
      const frame = JSON.parse(String(raw))
      if (frame.id !== 1) return
      active.off('message', reply)
      if (frame.ok) resolve(frame.result); else reject(new Error(frame.error))
    }
    active.on('message', reply)
    active.send(JSON.stringify({ id: 1, type, ...params }))
  }), type)
}
async function stop() {
  socket?.terminate(); socket = null
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await within(exited, 'server shutdown')
  }
  child = null
}
try {
  await start()
  await rpc('settings.update', { patch: { theme: 'light', modelAutoUpdate: false } })
  await rpc('workspace.add', { path: workspace })
  await stop()
  const restored = await start()
  assert.equal(restored.settings.theme, 'light')
  assert.equal(restored.settings.lastWorkspace, workspace)
  assert.ok(restored.settings.workspaces.includes(workspace))
  await stop()
  shell = pty.spawn('/bin/sh', [], { cwd: workspace, env: { ...process.env, TERM: 'xterm-256color' }, cols: 80, rows: 24 })
  shell.onData(() => {})
  const exited = new Promise(resolve => shell.onExit(resolve))
  shell.write("printf 'ubuntu-pty-ok' > pty-marker.txt\nexit\n")
  assert.equal((await within(exited, 'PTY input/output')).exitCode, 0)
  shell = null
  assert.equal(await fs.readFile(path.join(workspace, 'pty-marker.txt'), 'utf8'), 'ubuntu-pty-ok')
  console.log('PASS: startup, HTTP, authenticated RPC, settings/workspace restore, shutdown and native PTY')
} finally {
  shell?.kill()
  try { await stop() } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    assert.equal(path.dirname(home), os.tmpdir())
    await fs.rm(home, { recursive: true, force: true })
  }
}
