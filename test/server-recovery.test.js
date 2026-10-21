// Exercise the real RPC wiring and bootstrap with an isolated home and an
// already-blocked updater. No dsh process, npm install or provider call may run.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import WebSocket from 'ws'

const root = fileURLToPath(new URL('../', import.meta.url))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('recovery bootstrap keeps runtimes stopped and settings RPC commits atomically', { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-server-review-'))
  assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()))
  let child, ws
  t.after(async () => {
    ws?.terminate()
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    // Only this test's observed mkdtemp result is removed.
    assert.ok(path.basename(home).startsWith('agent-desk-server-review-'))
    await fs.rm(home, { recursive: true, force: true })
  })
  await fs.mkdir(path.join(home, 'dsh-home'))
  const patch = path.join(home, 'dsh-home', 'cordis.patch.yml')
  await fs.writeFile(patch, '# recovery must leave this intact\n')
  const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const messageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  await fs.mkdir(path.join(home, 'threads'))
  await fs.writeFile(path.join(home, 'threads.json'), JSON.stringify({ version: 1, threads: [{
    id: threadId, title: 'fixture', workspace: home, model: '["test","model"]', effort: 'medium',
    permissionMode: 'read-only', sessionId: null, createdAt: 0, updatedAt: 1, archived: false,
  }] }))
  await fs.writeFile(path.join(home, 'threads', `${threadId}.json`), JSON.stringify({ version: 1,
    turns: [{ id: 'turn', status: 'done', startedAt: 0, endedAt: 1, stopReason: 'end_turn', error: null,
      user: { messageId, text: 'accepted before restart', images: [] }, items: [] }],
    receipts: [{ messageId, status: 'accepted', kind: 'send', turnId: 'turn', payload: { text: 'accepted before restart', images: [] } }],
  }))
  await fs.writeFile(path.join(home, 'dsh-update.json'), JSON.stringify({
    phase: 'recovery-required', installed: '0.2.0-rc.2',
    recovery: { from: '0.2.0-rc.2', version: '0.2.1', stage: 'verify', packages: true, home: false, errors: { packages: 'simulated failure' } },
  }))
  child = spawn(process.execPath, ['server/index.js', '--no-open', '--port', '0'], {
    cwd: root,
    env: { ...process.env, AGENT_DESK_HOME: home },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  let info
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) assert.fail(`isolated server exited: ${output}`)
    try { info = JSON.parse(await fs.readFile(path.join(home, 'server.json'), 'utf8')); break } catch {}
    await wait(50)
  }
  assert.ok(info, `isolated server did not listen: ${output}`)
  const origin = `http://127.0.0.1:${info.port}`
  ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?t=${info.token}`, { origin })
  const replies = new Map()
  let sequence = 0
  let helloResolve
  const hello = new Promise((resolve) => { helloResolve = resolve })
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    if (frame.event === 'hello') helloResolve(frame.state)
    if (replies.has(frame.id)) { replies.get(frame.id)(frame); replies.delete(frame.id) }
  })
  const state = await hello
  assert.equal(state.dshUpdate.phase, 'recovery-required')
  assert.ok(Object.values(state.runtime).every((value) => value === 'stopped'))
  const request = (type, params = {}) => new Promise((resolve) => {
    const id = ++sequence
    replies.set(id, resolve)
    ws.send(JSON.stringify({ ...params, type, id }))
  })
  assert.equal((await request('thread.create', { workspace: home, model: '["test","model"]', text: 'must not run' })).ok, false)
  assert.equal((await request('catalog.refresh')).ok, false)
  const receipt = await request('thread.messageStatus', { threadId, messageId })
  assert.deepEqual(receipt.result, { status: 'accepted', turnId: 'turn', kind: 'send' })
  const check = await request('dshUpdate.check')
  assert.equal(check.result.update.phase, 'recovery-required')
  const invalid = await request('settings.update', { patch: { customInstructions: 'must not commit', dshUpdateChannel: 'invalid' } })
  assert.equal(invalid.ok, false)
  const unchanged = await request('state.get')
  assert.equal(unchanged.result.settings.customInstructions, '')
  const terra = '["openai-codex","gpt-5.6-terra"]'
  const saved = await request('settings.update', { patch: {
    customInstructions: 'valid', browserTool: false, modelVisibility: { [terra]: false, '["test","model"]': false },
  } })
  assert.equal(saved.ok, true)
  assert.equal(saved.result.settings.customInstructions, 'valid')
  assert.equal((await fs.readFile(patch, 'utf8')), '# recovery must leave this intact\n')
  const disk = JSON.parse(await fs.readFile(path.join(home, 'settings.json'), 'utf8'))
  assert.equal(disk.customInstructions, 'valid')
  assert.equal(disk.browserTool, false)
  assert.deepEqual(disk.modelVisibility, { [terra]: false, '["test","model"]': false })
  const restored = await request('settings.update', { patch: { modelVisibility: { [terra]: true } } })
  assert.equal(restored.ok, true)
  assert.deepEqual(restored.result.settings.modelVisibility, { [terra]: true, '["test","model"]': false })
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'settings.json'), 'utf8')).modelVisibility,
    restored.result.settings.modelVisibility)
  // Malformed and inherited method names must not crash or call prototype methods.
  ws.send('null')
  ws.send('[]')
  assert.equal((await request('toString')).ok, false)
  const final = await request('state.get')
  assert.equal(final.ok, true)
  assert.equal(final.result.threads.find((thread) => thread.id === threadId).model, '["test","model"]')
  assert.ok(Object.values(final.result.runtime).every((value) => value === 'stopped'))
})
