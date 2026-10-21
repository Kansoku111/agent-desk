// Development: the server (with --dev) plus Vite's dev server with hot reload.
// Open the "dev UI" URL the server prints.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const children = [
  spawn(process.execPath, ['server/index.js', '--dev'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', 'web/vite.config.ts'], { cwd: root, stdio: 'inherit' }),
]
const stop = () => {
  for (const child of children) child.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of children) child.on('exit', stop)
