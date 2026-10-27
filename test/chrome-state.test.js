import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { debugPort, readState } from '../server/chrome-state.js'

const moduleUrl = pathToFileURL(fileURLToPath(new URL('../server/chrome-state.js', import.meta.url))).href

/** A temporary state file (and folder) for one test. */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-chrome-state-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return path.join(dir, 'chrome-tool.json')
}

/** Runs `debugPort(stateFile)` in its own process after a shared start time, like two sessions starting together. */
function askInChild(childScript, stateFile, startAt) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [childScript, stateFile, startAt], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    proc.once('error', reject)
    proc.once('close', (code) => {
      if (code !== 0) reject(new Error(`child exited ${code}: ${stderr.trim()}`))
      else resolve(stdout.trim())
    })
  })
}

test('a stored port is reused as is, without rewriting the file', async (t) => {
  const stateFile = await fixture(t)
  const written = `{\n  "port": 45678,\n  "note": "kept"\n}\n`
  await fs.writeFile(stateFile, written)
  assert.equal(await debugPort(stateFile), 45678)
  assert.equal(await fs.readFile(stateFile, 'utf8'), written)
  assert.equal(readState(stateFile).note, 'kept')
  await assert.rejects(fs.stat(`${stateFile}.lock`), { code: 'ENOENT' })
})

test('sessions that start together all take the one port the first one stores', async (t) => {
  const stateFile = await fixture(t)
  const childScript = path.join(path.dirname(stateFile), 'child.mjs')
  await fs.writeFile(childScript, `import { debugPort } from '${moduleUrl}'
const [stateFile, startAt] = process.argv.slice(2)
const wait = Number(startAt) - Date.now()
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
process.stdout.write(String(await debugPort(stateFile)))
`)
  const startAt = String(Date.now() + 700)
  const ports = await Promise.all([1, 2, 3, 4].map(() => askInChild(childScript, stateFile, startAt)))
  assert.equal(new Set(ports).size, 1, `separate ports: ${ports.join(', ')}`)
  assert.match(ports[0], /^\d+$/)
  assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).port, Number(ports[0]))
  await assert.rejects(fs.stat(`${stateFile}.lock`), { code: 'ENOENT' })
})

test('an unreadable state file is replaced with a fresh port', async (t) => {
  const stateFile = await fixture(t)
  await fs.writeFile(stateFile, '{"port":')
  assert.deepEqual(readState(stateFile), {})
  const port = await debugPort(stateFile)
  assert.ok(Number.isInteger(port) && port > 0)
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), { port })
})
