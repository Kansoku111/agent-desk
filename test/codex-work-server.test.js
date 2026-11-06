import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexWorkServer } from '../server/codex-work-server.js'
import { CodexAppServer, DISABLED_CODEX_FEATURES } from '../server/codex-app-server.js'

function fakeSpawn(calls) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 1
    child.exitCode = null
    child.signalCode = null
    const writes = []
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const message = JSON.parse(chunk.toString())
      writes.push(message)
      if (message.method && message.id !== undefined) {
        child.stdout.write(JSON.stringify({ id: message.id, result: { method: message.method } }) + '\n')
      }
      done()
    } })
    child.stdin.on('finish', () => { child.exitCode = 0; child.emit('exit', 0) })
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0) }
    calls.push({ command, args, options, child, writes })
    return child
  }
}

test('work process shares authentication but keeps its own policy, data and RPC requests', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-work-'))
  const home = path.join(dir, 'home')
  const calls = []
  const spawn = fakeSpawn(calls)
  const work = new CodexWorkServer({ home, cwd: dir, spawn, command: 'fake' })
  const image = new CodexAppServer({ home, spawn, command: 'fake' })
  t.after(async () => { await work.stop(); await image.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  await work.start()
  const w = calls[0]
  assert.equal(w.options.cwd, dir)
  assert.equal(w.options.env.CODEX_HOME, home)
  assert.equal(w.options.env.OPENAI_API_KEY, undefined)
  assert.ok(w.args.includes('features.shell_tool=true'))
  assert.ok(w.args.includes('features.unified_exec=true'))
  for (const feature of DISABLED_CODEX_FEATURES.filter(x => !['shell_tool', 'unified_exec', 'view_image'].includes(x))) {
    assert.ok(w.args.includes(`features.${feature}=false`))
  }
  assert.ok(!w.args.some(x => /project_doc_max_bytes|model_instructions_file|sandbox_mode/.test(x)))
  assert.equal((await work.rawRequest('model/list')).method, 'model/list')
  assert.equal((await work.rawRequest('account/read')).method, 'account/read')
  const requests = [], notifications = []
  work.on('request', request => requests.push(request))
  work.on('notification', (method, params) => notifications.push({ method, params }))
  w.child.stdout.write('{"id":"server-1","method":"item/commandExecution/requestApproval","params":{"command":"test"}}\n')
  w.child.stdout.write('{"method":"thread/started","params":{"value":1}}\n')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests, [{ id: 'server-1', method: 'item/commandExecution/requestApproval', params: { command: 'test' } }])
  assert.deepEqual(notifications, [{ method: 'thread/started', params: { value: 1 } }])
  assert.ok(!w.writes.some(x => x.id === 'server-1'))
  work.respond('server-1', { decision: 'decline' })
  assert.deepEqual(w.writes.at(-1), { id: 'server-1', result: { decision: 'decline' } })
  work.reject(42, { code: -32601, message: 'unsupported' })
  assert.deepEqual(w.writes.at(-1), { id: 42, error: { code: -32601, message: 'unsupported' } })
  await fs.writeFile(path.join(work.runtimeHome, 'persistent.sqlite'), 'work')
  await fs.mkdir(path.join(home, '.sandbox'), { recursive: true })
  await fs.writeFile(path.join(home, '.sandbox', 'sandbox.2026-10-21.log'), 'work log')
  await image.start()
  assert.ok(calls[1].args.includes('sandbox_mode="read-only"'))
  let imageRequest = false
  image.on('request', () => { imageRequest = true })
  calls[1].child.stdout.write('{"id":7,"method":"item/commandExecution/requestApproval","params":{}}\n')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(imageRequest, false)
  assert.deepEqual(calls[1].writes.at(-1), { id: 7, error: { code: -32601, message: 'Agent Desk image runtime does not allow this operation' } })
  await image.stop()
  await work.stop()
  assert.equal(await fs.readFile(path.join(work.runtimeHome, 'persistent.sqlite'), 'utf8'), 'work')
  assert.equal(await fs.readFile(path.join(home, '.sandbox', 'sandbox.2026-10-21.log'), 'utf8'), 'work log')
  const config = await fs.readFile(path.join(home, 'config.toml'), 'utf8')
  assert.doesNotMatch(config, /project_doc_max_bytes|sandbox_mode|\[features\]/)
})
