// The desktop launcher (Start menu / taskbar). Brings the install up to date
// and starts the app without a console window:
//   1. installs dependencies when package-lock.json changed,
//   2. rebuilds the UI when its sources changed,
//   3. starts the server, which opens the app window (and replaces an
//      instance that is still running older code, once it has no task
//      running; until then the server waits in the background).
// Output goes to <data folder>/launcher.log; a non-zero exit makes launch.vbs
// show where to look.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appPaths } from '../server/paths.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const paths = appPaths()
fs.mkdirSync(paths.home, { recursive: true })
const logFile = path.join(paths.home, 'launcher.log')
fs.writeFileSync(logFile, `[${new Date().toISOString()}] launching from ${root}\n`)
const log = (line) => fs.appendFileSync(logFile, `${line}\n`)

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function run(command, args) {
  log(`> ${command} ${args.join(' ')}`)
  const output = execFileSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' && /npm(\.cmd)?$/.test(command), stdio: ['ignore', 'pipe', 'pipe'] })
  if (output.trim()) log(output.trim())
}

try {
  // npm records the installed tree in node_modules/.package-lock.json.
  const installed = mtime(path.join(root, 'node_modules', '.package-lock.json'))
  if (!installed || mtime(path.join(root, 'package-lock.json')) > installed) {
    run('npm', ['install', '--no-save', '--no-audit', '--no-fund'])
  }
  run(process.execPath, [path.join(root, 'scripts', 'ensure-build.mjs')])

  const out = fs.openSync(logFile, 'a')
  const server = spawn(process.execPath, [path.join(root, 'server', 'index.js'), ...process.argv.slice(2)], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  })
  // Wait until the server answers, hands over to a running instance and exits,
  // or settles in to wait for a busy older instance to finish its tasks.
  const outcome = await new Promise((resolve) => {
    const deadline = Date.now() + 120_000
    server.once('exit', (code) => resolve(code === 0 ? 'handed-over' : `exited with code ${code}`))
    const poll = async () => {
      try {
        const info = JSON.parse(fs.readFileSync(path.join(paths.home, 'server.json'), 'utf8'))
        if (info.pid === server.pid) return resolve('started')
      } catch {}
      try {
        const waiting = JSON.parse(fs.readFileSync(path.join(paths.home, 'successor.json'), 'utf8'))
        if (waiting.pid === server.pid) return resolve('waiting')
      } catch {}
      if (Date.now() > deadline) return resolve('timed out')
      setTimeout(poll, 300)
    }
    void poll()
  })
  log(`server: ${outcome}`)
  if (outcome !== 'started' && outcome !== 'handed-over' && outcome !== 'waiting') process.exit(1)
  server.unref()
  process.exit(0)
} catch (error) {
  log(`failed: ${error instanceof Error ? `${error.message}\n${error.stderr ?? ''}` : String(error)}`)
  process.exit(1)
}
