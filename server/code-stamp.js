// A fingerprint of the code a server process runs: the server sources, the
// installed dependencies and the built UI. A launcher compares it with the
// running instance and replaces an instance that predates an update.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** Fingerprint of the files that change what the app does. */
export function codeStamp(root = projectRoot) {
  const serverDir = path.join(root, 'server')
  const files = fs.readdirSync(serverDir)
    .filter((name) => /\.(js|json|ps1)$/.test(name))
    .sort()
    .map((name) => path.join(serverDir, name))
  // The code the server shares with the UI: an older install may not have it.
  const sharedDir = path.join(root, 'shared')
  if (fs.existsSync(sharedDir)) {
    files.push(...fs.readdirSync(sharedDir)
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => path.join(sharedDir, name)))
  }
  files.push(
    path.join(root, 'package.json'),
    path.join(root, 'node_modules', '.package-lock.json'),
    path.join(root, 'web', 'dist', 'index.html'),
  )
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${path.relative(root, file)}:${mtime(file)}\n`)
  return hash.digest('hex').slice(0, 16)
}

/** When the UI bundle was built; the page reloads itself when this changes. */
export function uiBuild(root = projectRoot) {
  return String(Math.round(mtime(path.join(root, 'web', 'dist', 'index.html'))))
}
