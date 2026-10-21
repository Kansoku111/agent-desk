// Builds the UI before `npm start` when web/dist is missing or older than the sources.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'web', 'dist', 'index.html')

function newest(dir) {
  let latest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    latest = Math.max(latest, entry.isDirectory() ? newest(full) : fs.statSync(full).mtimeMs)
  }
  return latest
}

const built = fs.existsSync(dist) ? fs.statSync(dist).mtimeMs : 0
const sources = Math.max(newest(path.join(root, 'web', 'src')), fs.statSync(path.join(root, 'web', 'index.html')).mtimeMs)
if (built < sources) {
  console.log('[agent-desk] building the UI…')
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'web/vite.config.ts', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' })
}
