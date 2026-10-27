// The debugging port of the browser tool's shared Chrome, remembered in one
// small JSON file (see chrome-mcp.js).
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { writeJson } from './json-file.js'

/** The state file's content; a missing or unreadable file counts as empty. */
export function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    return {}
  }
}

/** A port that is free right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * The debugging port the shared Chrome uses; chosen once and remembered.
 * Sessions start together, so choosing it is a read-modify-write another session
 * may interleave with: under the lock the later session sees the port the first
 * one stored and both point at the same Chrome. The file is written whole into
 * a temp file and renamed, so no session reads a half-written state.
 */
export async function debugPort(stateFile) {
  const stored = readState(stateFile).port
  if (Number.isInteger(stored)) return stored
  // withFileLock needs the folder for its sibling lock file.
  await fs.promises.mkdir(path.dirname(stateFile), { recursive: true })
  return withFileLock(stateFile, async () => {
    const state = readState(stateFile)
    if (Number.isInteger(state.port)) return state.port
    const port = await freePort()
    await writeJson(stateFile, { ...state, port })
    return port
  })
}
