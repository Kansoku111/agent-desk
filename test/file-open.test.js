import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { openFile } from '../server/system.js'
import { createWorkspaceHandlers } from '../server/rpc-handlers-workspaces.js'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../server/open-front.ps1', import.meta.url))
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-file-open-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const folder = path.join(dir, "日本語 space & [folder] 'quoted'")
  await fs.mkdir(folder)
  const file = path.join(folder, "report, & [1] '引用'.txt")
  await fs.writeFile(file, 'test')
  return { dir, folder, file }
}

for (const how of ['open', 'reveal']) {
  test('Windows file ' + how + ' waits for the STA launcher and passes the path literally', async (t) => {
    const { file } = await fixture(t)
    let finish, call, completed = false
    const opening = openFile(file, how, { platform: 'win32', runCommand: (...args) => {
      call = args
      return new Promise(resolve => { finish = resolve })
    } }).then(() => { completed = true })
    assert.equal(completed, false)
    assert.equal(call[0], 'powershell.exe')
    assert.deepEqual(call[1], ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, ...(how === 'reveal' ? ['-Reveal'] : [])])
    assert.equal(call[2].env.AGENT_DESK_FILE_PATH, file)
    assert.equal(call[2].windowsHide, true)
    assert.equal(call[2].timeout, 15_000)
    assert.equal(call[2].detached, undefined)
    finish({})
    await opening
    assert.equal(completed, true)
  })
}

test('Windows file actions report launcher failures instead of succeeding', async (t) => {
  const { file } = await fixture(t)
  for (const how of ['open', 'reveal']) {
    for (const error of [Object.assign(new Error('launcher failed'), { stderr: 'native error details' }), new Error('spawn ENOENT'), new Error('command timed out')]) {
      await assert.rejects(openFile(file, how, { platform: 'win32', runCommand: async () => { throw error } }),
        message => message.message.includes(how === 'reveal' ? '場所を表示できませんでした' : '開けませんでした') && message.message.includes(error.stderr || error.message))
    }
  }
})

test('file.open RPC waits for display completion, propagates errors, and keeps scripts non-executable', async (t) => {
  const { folder, file } = await fixture(t)
  let release, started
  const launching = new Promise(resolve => { started = resolve })
  const calls = []
  const handlers = createWorkspaceHandlers({ openFile: (...args) => {
    calls.push(args)
    started()
    return new Promise(resolve => { release = resolve })
  } })
  let completed = false
  const result = handlers['file.open']({ ref: path.basename(file), workspace: folder, how: 'reveal' }).then(value => { completed = true; return value })
  await launching
  assert.equal(completed, false)
  assert.deepEqual(calls, [[file, 'reveal']])
  release()
  assert.deepEqual(await result, { file, revealed: false })

  const scriptFile = path.join(folder, 'do-not-run.ps1')
  await fs.writeFile(scriptFile, 'throw "must not run"')
  const guarded = createWorkspaceHandlers({ openFile: async (...args) => { calls.push(args) } })
  assert.deepEqual(await guarded['file.open']({ ref: scriptFile, how: 'open' }), { file: scriptFile, revealed: true })
  assert.deepEqual(calls.at(-1), [scriptFile, 'reveal'])
  await guarded['file.open']({ ref: folder + path.sep, how: 'open' })
  assert.deepEqual(calls.at(-1), [folder + path.sep, 'open'])
  await assert.rejects(guarded['file.open']({ ref: path.join(folder, 'missing.txt'), how: 'reveal' }), /ファイルが見つかりません/)
  await assert.rejects(guarded['file.open']({ ref: file, how: 'unknown' }), /不明な開き方/)
  const failed = createWorkspaceHandlers({ openFile: async () => { throw new Error('Explorer foreground denied') } })
  await assert.rejects(failed['file.open']({ ref: file, how: 'reveal' }), /Explorer foreground denied/)
})

// Mock only OS interaction. The real helper still resolves literal paths,
// matches the view/selection, waits, chooses a handle and reports failures.
const mockShell = `
Add-Type @"
using System;
public static class Front {
  public static string Folder, Target;
  public static long Raised;
  public static void Reveal(string folder, string target) {
    if (Environment.GetEnvironmentVariable("TEST_EXPLORER_MODE") == "native-error") throw new Exception("native selection failed");
    Folder = folder; Target = target;
  }
  public static bool Raise(long handle) {
    Raised = handle;
    return Environment.GetEnvironmentVariable("TEST_EXPLORER_MODE") != "focus-error";
  }
}
"@
function Add-Type { param($TypeDefinition) }
function New-Object {
  param($ComObject)
  if ($ComObject -ne 'Shell.Application') { throw 'Unexpected COM object' }
  $shell = [pscustomobject]@{}
  $shell | Add-Member ScriptMethod Windows {
    if ($env:TEST_EXPLORER_MODE -eq 'missing-window') { return @() }
    $wrongFolder = [pscustomobject]@{ Folder = @{ Self = @{ Path = 'unrelated' } } }
    $wrongSelection = [pscustomobject]@{ Folder = @{ Self = @{ Path = [Front]::Folder } } }
    $wrongSelection | Add-Member ScriptMethod SelectedItems { @([pscustomobject]@{ Path = 'another file' }) }
    $correct = [pscustomobject]@{ Folder = @{ Self = @{ Path = [Front]::Folder } } }
    $correct | Add-Member ScriptMethod SelectedItems { @([pscustomobject]@{ Path = [Front]::Target }) }
    @([pscustomobject]@{ HWND = 100; Document = $wrongFolder },
      [pscustomobject]@{ HWND = 200; Document = $wrongSelection },
      [pscustomobject]@{ HWND = 42; Document = $correct })
  }
  return $shell
}
function Start-Sleep { Set-Variable -Name deadline -Value ([DateTime]::MinValue) -Scope 1 }
function Start-Process {
  param($FilePath, $ErrorAction)
  if ($env:TEST_EXPLORER_MODE -eq 'open-error') { throw 'association launch failed' }
  $global:opened = $FilePath
}
& $env:TEST_EXPLORER_SCRIPT -Reveal:($env:TEST_EXPLORER_HOW -eq 'reveal')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
@{ folder = [Front]::Folder; target = [Front]::Target; raised = [Front]::Raised; opened = $global:opened } | ConvertTo-Json -Compress
`

const windows = { skip: process.platform !== 'win32' }
async function mockedHelper(file, how = 'reveal', mode = '') {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', mockShell], {
    env: { ...process.env, AGENT_DESK_FILE_PATH: file, TEST_EXPLORER_SCRIPT: script, TEST_EXPLORER_MODE: mode, TEST_EXPLORER_HOW: how }, windowsHide: true, timeout: 15_000,
  })
}

test('Explorer helper focuses a matching existing view, ignores unrelated windows and verifies selection', windows, async (t) => {
  const { file, folder } = await fixture(t)
  const { stdout } = await mockedHelper(file)
  assert.deepEqual(JSON.parse(stdout), { folder, target: file, raised: 42, opened: null })
})

test('Explorer helper handles folders, drive roots and default-app paths literally', windows, async (t) => {
  const { folder, file } = await fixture(t)
  for (const [target, how, expectedFolder] of [[folder, 'reveal', path.dirname(folder)], [folder, 'open', folder], [path.parse(folder).root, 'reveal', path.parse(folder).root]]) {
    const result = JSON.parse((await mockedHelper(target, how)).stdout)
    assert.equal(result.folder, expectedFolder)
    assert.equal(result.target, target)
    assert.equal(result.opened, null)
    if (target !== expectedFolder) assert.equal(result.raised, 42)
  }
  const opened = JSON.parse((await mockedHelper(file, 'open')).stdout)
  assert.equal(opened.opened, file)
  assert.equal(opened.raised, 0, 'no unrelated new-window focus scan for associated apps')
})

test('Explorer helper reports native, missing-window, foreground and associated-app failures with exit 1', windows, async (t) => {
  const { file } = await fixture(t)
  for (const [mode, how, error] of [['native-error', 'reveal', /native selection failed/], ['missing-window', 'reveal', /did not show/], ['focus-error', 'reveal', /did not allow/], ['open-error', 'open', /association launch failed/]]) {
    await assert.rejects(mockedHelper(file, how, mode), cause => {
      assert.equal(cause.code, 1)
      assert.match(cause.stderr, error)
      return true
    })
  }
  await assert.rejects(mockedHelper(path.join(path.dirname(file), 'missing.txt')), cause => cause.code === 1 && cause.stderr.length > 0)
})
