import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { execFileTree, execFileTreeAsync } from '../server/process-tree.js'

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

// Stands in for Git for Windows' cmd\\git.exe: cmd.exe runs the real program as its child.
// (A Node launcher would not do: libuv's job object ends its children with it.)
const SPIN = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)"
const launch = (pidFile) => [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${process.execPath}" -e "${SPIN}" "${pidFile}""`]]

async function waitFor(file) {
  for (let i = 0; i < 100; i += 1) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (text) return Number(text)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('the launcher never started its child')
}

test('a timeout ends the program a launcher started, not only the launcher', { timeout: 20_000, skip: process.platform !== 'win32' && 'launchers like cmd\\git.exe are a Windows concern' }, async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-tree-'))
  const pidFile = path.join(base, 'child.pid')
  let pid = null
  t.after(async () => {
    if (pid && alive(pid)) process.kill(pid)
    await fs.rm(base, { recursive: true, force: true })
  })
  const error = await new Promise((resolve) => {
    const [file, args] = launch(pidFile)
    execFileTree(file, args, { timeout: 2500, windowsHide: true, windowsVerbatimArguments: true }, (failure) => resolve(failure))
    waitFor(pidFile).then((value) => { pid = value })
  })
  assert.equal(error?.killed, true)
  pid ??= await waitFor(pidFile)
  assert.equal(alive(pid), false, 'the real program was left running')
})

test('an abort ends the tree and rejects with an AbortError carrying the output so far', async () => {
  const controller = new AbortController()
  const pending = execFileTreeAsync(process.execPath, ['-e', 'process.stdout.write("partial"); setInterval(() => {}, 1000)'], { signal: controller.signal, windowsHide: true, encoding: 'utf8' })
  assert.ok(pending.child.pid)
  setTimeout(() => controller.abort(), 500)
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.killed, true)
    assert.equal(error.stdout, 'partial')
    return true
  })
})

test('a command that finishes in time reports its own result', async () => {
  const { stdout } = await execFileTreeAsync(process.execPath, ['-e', 'process.stdout.write("done")'], { timeout: 30_000, encoding: 'utf8' })
  assert.equal(stdout, 'done')
  await assert.rejects(execFileTreeAsync(process.execPath, ['-e', 'process.exit(3)'], { timeout: 30_000 }), (error) => error.code === 3 && !error.killed)
})
