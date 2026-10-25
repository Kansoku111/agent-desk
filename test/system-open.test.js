import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { openIn, openTargets } from '../server/system.js'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../server/open-terminal.ps1', import.meta.url))
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-open-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, "日本語 space & [project] 'quoted'")
  await fs.mkdir(dir)
  return dir
}

test('open targets no longer advertise Explorer', () => {
  assert.deepEqual(openTargets(), { terminal: ['win32', 'darwin'].includes(process.platform) })
})

test('Windows terminal uses an awaited visible-window launcher with a literal working directory', async (t) => {
  const dir = await workspace(t)
  let finish
  let call
  let completed = false
  const opening = openIn('terminal', dir, { platform: 'win32', runCommand: (...args) => {
    call = args
    return new Promise(resolve => { finish = resolve })
  } }).then(() => { completed = true })
  assert.equal(completed, false)
  assert.equal(call[0], 'powershell.exe')
  assert.deepEqual(call[1], ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script])
  assert.equal(call[2].windowsHide, true, 'only the short-lived launcher is hidden')
  assert.equal(call[2].timeout, 15_000)
  assert.equal(call[2].env.AGENT_DESK_TERMINAL_DIR, dir)
  finish({})
  await opening
  assert.equal(completed, true)
})

test('macOS terminal launch keeps the path as one argument and reports launcher errors', async (t) => {
  const dir = await workspace(t)
  await openIn('terminal', dir, { platform: 'darwin', runCommand: async (...args) => {
    assert.deepEqual(args, ['open', ['-a', 'Terminal', dir], { timeout: 15_000 }])
  } })
  for (const platform of ['win32', 'darwin']) {
    await assert.rejects(openIn('terminal', dir, { platform, runCommand: async () => {
      throw Object.assign(new Error('launcher failed'), { stderr: 'native error details\n' })
    } }), /ターミナルを開けませんでした: native error details/)
    await assert.rejects(openIn('terminal', dir, { platform, runCommand: async () => {
      throw new Error('spawn ENOENT')
    } }), /ターミナルを開けませんでした: spawn ENOENT/)
  }
})

test('removed Explorer target, unsupported platforms and non-directories do not launch a process', async (t) => {
  const dir = await workspace(t)
  const file = path.join(dir, 'file.txt')
  await fs.writeFile(file, '')
  const options = { platform: 'win32', runCommand: async () => assert.fail('must not launch') }
  for (const target of ['files', 'unknown']) await assert.rejects(openIn(target, dir, options), /この環境では開けません/)
  await assert.rejects(openIn('terminal', dir, { ...options, platform: 'linux' }), /この環境では開けません/)
  for (const invalid of [file, path.join(dir, 'missing'), '', '.', undefined]) {
    await assert.rejects(openIn('terminal', invalid, options), /フォルダが見つかりません/)
  }
})

test('Windows helper opens a normal new window and keeps special characters out of executable arguments', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = await workspace(t)
  // Execute the real helper, replacing only Start-Process so tests open no desktop windows.
  const command = `function Start-Process {
    param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $ErrorAction)
    @{ file = $FilePath; args = $ArgumentList; cwd = $WorkingDirectory; style = $WindowStyle; errors = $ErrorAction } | ConvertTo-Json -Compress
  }; & $env:AGENT_DESK_TEST_TERMINAL_SCRIPT`
  const env = { ...process.env, AGENT_DESK_TERMINAL_DIR: dir, AGENT_DESK_TEST_TERMINAL_SCRIPT: script }
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env, windowsHide: true })
  const result = JSON.parse(stdout)
  assert.equal(result.file, path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  assert.deepEqual(result.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand'])
  assert.equal(Buffer.from(result.args[3], 'base64').toString('utf16le'), 'Set-Location -LiteralPath $env:AGENT_DESK_TERMINAL_DIR')
  assert.equal(result.cwd, dir)
  assert.equal(result.style, 'Normal')
  assert.equal(result.errors, 'Stop')
  await assert.rejects(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'function Start-Process { throw "test launch failure" }; & $env:AGENT_DESK_TEST_TERMINAL_SCRIPT'], { env, windowsHide: true }), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /test launch failure/)
    return true
  })
})
