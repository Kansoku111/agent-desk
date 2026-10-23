// Concurrent launches must never become independent writers of the same index.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import WebSocket from 'ws'

const root = fileURLToPath(new URL('../', import.meta.url))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('simultaneous cold starts and dev launch share one writer; deleted tasks stay deleted', { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-single-instance-'))
  const children = []
  let ws, info
  t.after(async () => {
    ws?.terminate()
    // Quit the surviving server the normal way, so it stops the Codex app-server it started.
    if (info) await fetch(`http://127.0.0.1:${info.port}/api/quit?t=${info.token}`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {})
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      const fallback = setTimeout(() => child.kill(), 5000)
      await exited
      clearTimeout(fallback)
    }))
    assert.equal(path.dirname(home), os.tmpdir())
    assert.ok(path.basename(home).startsWith('agent-desk-single-instance-'))
    await fs.rm(home, { recursive: true, force: true })
  })
  // No provider requests or npm lookups from the fixture; the instances still reach each other.
  const hook = path.join(home, 'offline-fetch.mjs')
  await fs.writeFile(hook, `const local = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (new URL(String(url)).hostname === '127.0.0.1') return local(url, init)
  throw new Error('offline single-instance test')
}`)
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ modelAutoUpdate: false }))
  const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  await fs.writeFile(path.join(home, 'threads.json'), JSON.stringify({ version: 1, threads: [{
    id: threadId, title: 'delete fixture', workspace: home, model: null,
    permissionMode: 'read-only', sessionId: null, createdAt: 0, updatedAt: 1,
  }] }))
  const launch = (...extra) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, 'server/index.js', '--no-open', '--port', '0', ...extra], {
      cwd: root, env: { ...process.env, AGENT_DESK_HOME: home }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.output = ''
    child.stdout.on('data', (data) => { child.output += data })
    child.stderr.on('data', (data) => { child.output += data })
    children.push(child)
    return child
  }
  for (let i = 0; i < 3; i++) launch()
  for (let attempt = 0; attempt < 300; attempt++) {
    try { info = JSON.parse(await fs.readFile(path.join(home, 'server.json'), 'utf8')) } catch {}
    if (info && children.filter((child) => child.exitCode === 0).length === 2) break
    await wait(25)
  }
  assert.ok(info, children.map((child) => child.output).join('\n'))
  assert.equal(children.filter((child) => child.exitCode === null).length, 1, children.map((child) => child.output).join('\n'))
  assert.equal(children.filter((child) => child.exitCode === 0).length, 2)
  const origin = `http://127.0.0.1:${info.port}`
  ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?t=${info.token}`, { origin })
  const hello = new Promise((resolve) => ws.on('message', (raw) => {
    if (JSON.parse(String(raw)).event === 'hello') resolve()
  }))
  await hello
  const removed = new Promise((resolve) => ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    if (frame.id === 1) resolve(frame)
  }))
  ws.send(JSON.stringify({ id: 1, type: 'thread.remove', threadId }))
  assert.equal((await removed).ok, true)
  const dev = launch('--dev')
  await once(dev, 'exit')
  assert.equal(dev.exitCode, 0, dev.output)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'threads.json'), 'utf8')).threads, [])
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'server.json'), 'utf8')).pid, info.pid)
})
