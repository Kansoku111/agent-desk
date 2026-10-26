import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createSocketServer } from '../server/websocket.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildUi, createAppRestarter, restartFiles } from '../server/app-restart.js'
import { main as restart } from '../scripts/restart-app.mjs'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-restart-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

test('restart builds first, hands the port and token over, starts the restarter, then shuts down', async (t) => {
  const home = await temp(t)
  const steps = []
  const restartApp = createAppRestarter({
    root: 'ROOT', home, args: ['--no-open'],
    handoff: () => ({ port: 47130, token: 'tok', windows: 1 }),
    shutdown: async (code) => { steps.push(`shutdown ${code}`) },
    build: async (root) => { steps.push(`build ${root}`) },
    start: ({ root, planFile }) => { steps.push(`start ${root}`); steps.push(planFile) },
  })
  await restartApp()
  // The reply goes out before the server stops.
  assert.deepEqual(steps, ['build ROOT', 'start ROOT', restartFiles(home).restartPlan])
  await wait(450)
  assert.equal(steps.at(-1), 'shutdown 0')
  const plan = JSON.parse(await fs.readFile(restartFiles(home).restartPlan, 'utf8'))
  assert.equal(plan.pid, process.pid)
  assert.deepEqual(plan.args, ['--no-open'])
  assert.deepEqual(plan.handoff, { port: 47130, token: 'tok', windows: 1 })
})

test('a failed build leaves the app running and can be tried again', async (t) => {
  const home = await temp(t)
  let fail = true
  let started = 0
  let stopped = 0
  const restartApp = createAppRestarter({
    root: 'ROOT', home, args: [], handoff: () => ({}),
    shutdown: async () => { stopped += 1 },
    build: async () => { if (fail) throw new Error('ビルドに失敗しました: boom') },
    start: () => { started += 1 },
  })
  await assert.rejects(restartApp(), /ビルドに失敗しました: boom/)
  await wait(450)
  assert.equal(started, 0)
  assert.equal(stopped, 0)
  await assert.rejects(fs.access(restartFiles(home).restartPlan))
  fail = false
  await restartApp()
  assert.equal(started, 1)
})

test('a second press while the first is working is refused', async (t) => {
  const home = await temp(t)
  let release
  const restartApp = createAppRestarter({
    root: 'ROOT', home, args: [], handoff: () => ({}), shutdown: async () => {},
    build: () => new Promise((resolve) => { release = resolve }),
    start: () => {},
  })
  const first = restartApp()
  await assert.rejects(restartApp(), /準備中/)
  release()
  await first
})

test('buildUi reports a build that cannot run', async (t) => {
  await assert.rejects(buildUi(await temp(t)), /ビルドに失敗しました/)
})

test('the restarter waits for the old server to exit, hands over, and launches', async (t) => {
  const root = await temp(t)
  const home = await temp(t)
  await fs.mkdir(path.join(root, 'scripts'))
  const marker = path.join(root, 'launched.txt')
  await fs.writeFile(path.join(root, 'scripts', 'launch.mjs'),
    `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '))\n`)
  const files = restartFiles(home)
  await fs.mkdir(files.dir, { recursive: true })
  const planFile = files.restartPlan
  const finished = spawnSync(process.execPath, ['-e', ''])
  await fs.writeFile(planFile, JSON.stringify({ pid: finished.pid, root, args: ['--no-open'], handoff: { port: 47130, token: 'tok', windows: 1 }, files }))
  await restart(planFile)
  assert.equal(await fs.readFile(marker, 'utf8'), '--no-open')
  const handoff = JSON.parse(await fs.readFile(files.handoff, 'utf8'))
  assert.deepEqual({ port: handoff.port, token: handoff.token, windows: handoff.windows }, { port: 47130, token: 'tok', windows: 1 })
  assert.ok(Date.now() - handoff.at < 60_000)
  // The plan holds the window token and does not stay behind.
  await assert.rejects(fs.access(planFile))
  assert.match(await fs.readFile(files.restartLog, 'utf8'), /done/)
})

test('the open menu offers restart on PC and phone, behind a confirmation', async () => {
  const read = (file) => fs.readFile(new URL(`../web/src/${file}`, import.meta.url), 'utf8')
  const menu = await read('components/ThreadView.tsx')
  const app = await read('App.tsx')
  assert.match(menu, /label="ビルドして再起動"/)
  assert.match(menu, /setState\(\{ restartConfirm: true \}\)/)
  assert.match(app, /act\('app\.restart'\)/)
  const socket = await fs.readFile(new URL('../server/websocket.js', import.meta.url), 'utf8')
  assert.doesNotMatch(socket.split('const PC_ONLY')[1].split(']')[0], /'app\.restart'/)
  assert.match(menu, /!remote && targets\?\.terminal/)
  for (const [file, workspace] of [['ThreadView', 'thread'], ['TerminalView', 'terminal'], ['AgentView', 'team'], ['Ab', 'run']]) {
    const code = await read(`components/${file}.tsx`)
    assert.ok(code.includes(`<OpenInMenu workspace={${workspace}.workspace} />`), file)
    assert.ok(!code.includes('{!remote && <OpenInMenu'), file)
  }
})

test('authenticated PC and phone RPCs allow restart but phone keeps other PC-only restrictions', async (t) => {
  for (const remote of [false, true]) await t.test(remote ? 'phone' : 'PC', async (t) => {
    const clients = new Map()
    const server = http.createServer()
    const calls = []
    let buildFails = false
    const pcOnly = ['workspace.open', 'file.open', 'updates.installApp', 'remote.set']
    const { handleUpgrade } = createSocketServer({
      dev: false, clients,
      handlers: {
        'app.restart': async (_params, client) => {
          calls.push(['app.restart', client.remote])
          if (buildFails) throw new Error('ビルドに失敗しました: fixture')
          return null
        },
        ...Object.fromEntries(pcOnly.map((type) => [type, async () => { calls.push([type]); return null }])),
      },
      fullState: async (client) => ({ app: { remote: client.remote } }),
      terminals: { dropClient() {} }, broadcastRemote() {}, scheduleIdleExit() {},
      cancelIdleExit() {}, isShuttingDown: () => false,
    })
    server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, {
      port: server.address().port, token: 'test-token', remote,
      hostOk: (host) => host === '127.0.0.1:' + server.address().port,
    }))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    const client = new WebSocket(origin.replace('http:', 'ws:') + '/ws?t=test-token', { origin })
    t.after(async () => {
      client.terminate()
      for (const socket of clients.keys()) socket.terminate()
      await new Promise((resolve) => server.close(resolve))
    })
    const [hello] = await once(client, 'message')
    assert.equal(JSON.parse(String(hello)).state.app.remote, remote)
    let id = 0
    const request = async (type) => {
      const reply = once(client, 'message')
      client.send(JSON.stringify({ id: ++id, type }))
      const [raw] = await reply
      const response = JSON.parse(String(raw))
      assert.equal(response.id, id)
      return response
    }
    assert.deepEqual(await request('app.restart'), { id: 1, ok: true, result: null })
    assert.deepEqual(calls, [['app.restart', remote]])
    buildFails = true
    assert.deepEqual(await request('app.restart'), { id: 2, ok: false, error: 'ビルドに失敗しました: fixture' })
    for (const type of pcOnly) {
      const response = await request(type)
      assert.equal(response.ok, !remote, type)
      if (remote) assert.match(response.error, /PC の Agent Desk/)
    }
    assert.deepEqual(calls.slice(2), remote ? [] : pcOnly.map((type) => [type]))
  })
})
