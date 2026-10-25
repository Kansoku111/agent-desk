import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

test('the open menu offers the restart on the PC, behind a confirmation', async () => {
  const read = (file) => fs.readFile(new URL(`../web/src/${file}`, import.meta.url), 'utf8')
  const menu = await read('components/ThreadView.tsx')
  const app = await read('App.tsx')
  assert.match(menu, /label="ビルドして再起動"/)
  assert.match(menu, /setState\(\{ restartConfirm: true \}\)/)
  assert.match(app, /act\('app\.restart'\)/)
  const socket = await fs.readFile(new URL('../server/websocket.js', import.meta.url), 'utf8')
  assert.match(socket.split('const PC_ONLY')[1].split(']')[0], /'app\.restart'/)
})
