// A lifetime lock for the one process allowed to write a data folder.
// Windows named pipes and Linux abstract sockets are kernel-owned: process
// death releases them, without PID files or a racy stale-owner unlink.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

export async function tryAcquireDataLock(home) {
  await fs.mkdir(home, { recursive: true })
  const realHome = await fs.realpath(home)
  const identity = process.platform === 'win32' ? realHome.toLowerCase() : realHome
  const hash = createHash('sha256').update(identity).digest('hex')
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\agent-desk-data-${hash}`
    : process.platform === 'linux'
      ? `\0agent-desk-data-${hash}`
      : path.join(realHome, '.agent-desk-owner.sock')
  const server = net.createServer((connection) => connection.destroy())
  const acquired = await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      // Other Unix platforms deliberately fail closed on a stale socket. Do
      // not unlink on ECONNREFUSED: another claimant could already own it.
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false)
      else reject(error)
    })
    server.listen(socket, () => resolve(true))
  })
  if (!acquired) return null
  server.unref()
  let releasing
  return function release() {
    releasing ??= new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    return releasing
  }
}
