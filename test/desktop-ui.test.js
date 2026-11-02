import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { actArgs, agentDesktopBinary, createUiTools, findArgs, listArgs, runAgentDesktop, snapshotArgs } from '../server/desktop-ui.js'
import { createMcpServerList } from '../server/mcp-servers.js'
import { appPaths } from '../server/paths.js'

const ref = '@s8f3k2p9:e12'

/** An execFile stand-in that answers every call with the given result and records the command lines. */
function fakeExec({ stdout = '', stderr = '', error = null } = {}) {
  const calls = []
  const impl = (file, argv, options, callback) => {
    calls.push({ file, argv, options })
    callback(error, stdout, stderr)
  }
  return { impl, calls }
}

test('snapshot defaults to interactive, compact output and passes the chosen scope', () => {
  assert.deepEqual(snapshotArgs({}), ['snapshot', '--interactive-only', '--compact'])
  assert.deepEqual(
    snapshotArgs({ app: 'Notepad.exe', window_id: 'w-4521', surface: 'sheet', root: ref, skeleton: true, interactive_only: false, compact: false, max_depth: 3, timeout_ms: 8000 }),
    ['snapshot', '--app=Notepad.exe', '--window-id=w-4521', '--surface=sheet', `--root=${ref}`, '--timeout-ms=8000', '--skeleton', '--max-depth=3'],
  )
})

test('a root or ref must be the qualified form, and numbers must be in range', () => {
  assert.throws(() => snapshotArgs({ root: '@e3' }), /@<snapshot_id>:eN/)
  assert.throws(() => snapshotArgs({ root: 'e3' }), /@<snapshot_id>:eN/)
  assert.throws(() => actArgs({ action: 'click', ref: '@e3' }), /@<snapshot_id>:eN/)
  assert.throws(() => actArgs({ action: 'click' }), /@<snapshot_id>:eN/)
  assert.throws(() => snapshotArgs({ max_depth: 0 }), /max_depth/)
  assert.throws(() => snapshotArgs({ timeout_ms: 1.5 }), /timeout_ms/)
})

test('find limits matches by default and keeps a dash-leading value out of the option parser', () => {
  assert.deepEqual(findArgs({ role: 'button', name: '保存', exact: true }), ['find', '--role=button', '--name=保存', '--exact', '--limit=20'])
  assert.deepEqual(findArgs({ app: 'calc', text: '-5', limit: 3 }), ['find', '--app=calc', '--text=-5', '--limit=3'])
})

test('list needs a kind; only apps are narrowed, because list-windows would need the exact app name', () => {
  assert.deepEqual(listArgs({ kind: 'apps' }), ['list-apps'])
  assert.deepEqual(listArgs({ kind: 'apps', app: 'note' }), ['list-apps', '--app=note'])
  assert.deepEqual(listArgs({ kind: 'windows', app: 'Calculator' }), ['list-windows'])
  assert.throws(() => listArgs({}), /kind/)
})

test('act puts options before the separator and the ref and text after it', () => {
  assert.deepEqual(actArgs({ action: 'click', ref }), ['click', '--', ref])
  assert.deepEqual(actArgs({ action: 'set-value', ref, text: '-abc' }), ['set-value', '--', ref, '-abc'])
  assert.deepEqual(actArgs({ action: 'set-value', ref, text: '' }), ['set-value', '--', ref, ''])
  assert.deepEqual(actArgs({ action: 'type', ref, text: 'こんにちは', headed: true }), ['type', '--headed', '--', ref, 'こんにちは'])
  assert.deepEqual(actArgs({ action: 'scroll', ref, direction: 'up', amount: 5 }), ['scroll', '--direction=up', '--amount=5', '--', ref])
  assert.deepEqual(actArgs({ action: 'scroll', ref }), ['scroll', '--', ref])
})

test('act rejects an unknown action and a missing value', () => {
  assert.throws(() => actArgs({ action: 'launch', ref }), /action/)
  assert.throws(() => actArgs({ action: 'type', ref }), /text/)
  assert.throws(() => actArgs({ action: 'select', ref, text: 5 }), /text/)
})

test('physical input is never switched on unless the agent asks for it', () => {
  for (const action of ['click', 'right-click', 'type', 'focus']) assert.ok(!actArgs({ action, ref, text: 'x' }).includes('--headed'))
})

test('the CLI is found inside the installed package for each supported architecture', () => {
  for (const [arch, name] of [['x64', 'agent-desktop-win32-x64.exe'], ['arm64', 'agent-desktop-win32-arm64.exe']]) {
    const file = agentDesktopBinary(arch)
    assert.ok(file.endsWith(name), file)
    assert.ok(existsSync(file), `${file} is missing: run npm install`)
  }
  assert.throws(() => agentDesktopBinary('ia32'), /ia32/)
  assert.throws(() => agentDesktopBinary('x64', () => false), /npm install/)
})

test('an envelope with ok:true is a success', async () => {
  const exec = fakeExec({ stdout: '{"version":"2.5","ok":true,"command":"list-apps","data":{"apps":[]}}\n' })
  const result = await runAgentDesktop(['list-apps'], { binary: () => 'ad.exe', execFileImpl: exec.impl, env: { AGENT_DESKTOP_HOME: 'C:\\h' } })
  assert.deepEqual(result, { ok: true, text: '{"version":"2.5","ok":true,"command":"list-apps","data":{"apps":[]}}' })
  assert.equal(exec.calls[0].file, 'ad.exe')
  assert.deepEqual(exec.calls[0].argv, ['list-apps'])
  assert.equal(exec.calls[0].options.windowsHide, true)
  assert.equal(exec.calls[0].options.env.AGENT_DESKTOP_HOME, 'C:\\h')
})

test('a refused action keeps its envelope, with the suggestion the agent needs', async () => {
  const envelope = '{"ok":false,"command":"right-click","error":{"code":"POLICY_DENIED","suggestion":"use headed"}}'
  const failed = Object.assign(new Error('Command failed'), { code: 1 })
  const result = await runAgentDesktop(['right-click'], { binary: () => 'ad.exe', execFileImpl: fakeExec({ stdout: envelope, error: failed }).impl })
  assert.deepEqual(result, { ok: false, text: envelope })
})

test('output that is not an envelope is shown as it is', async () => {
  const result = await runAgentDesktop(['x'], { binary: () => 'ad.exe', execFileImpl: fakeExec({ stdout: 'plain text' }).impl })
  assert.deepEqual(result, { ok: false, text: 'plain text' })
})

test('very long output is cut with a note on how to narrow it', async () => {
  const result = await runAgentDesktop(['snapshot'], { binary: () => 'ad.exe', execFileImpl: fakeExec({ stdout: `{"ok":true,"pad":"${'あ'.repeat(50_000)}"}` }).impl })
  assert.equal(result.ok, true)
  assert.ok(result.text.length < 41_000)
  assert.match(result.text, /切り詰めました/)
})

test('a crash without output is explained: timeout, blocked start, or the CLI own message', async () => {
  const run = (error, stderr = '') => runAgentDesktop(['x'], { binary: () => 'ad.exe', execFileImpl: fakeExec({ error, stderr }).impl })
  await assert.rejects(run(Object.assign(new Error('timed out'), { killed: true })), /時間内に終わりませんでした/)
  await assert.rejects(run(Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' })), /Smart App Control/)
  await assert.rejects(run(new Error('exit 2'), 'panic: boom\n'), /^Error: panic: boom$/)
})

test('a missing package is reported when a tool runs, not when the server starts', async () => {
  const tools = createUiTools({ binary: () => { throw new Error('agent-desktop が見つかりません') }, execFileImpl: fakeExec().impl })
  await assert.rejects(tools.find((tool) => tool.name === 'ui_list').run({ kind: 'apps' }), /見つかりません/)
})

test('a tool reports a refused action as an error carrying the envelope', async () => {
  const envelope = '{"ok":false,"error":{"code":"STALE_REF"}}'
  const exec = fakeExec({ stdout: envelope, error: Object.assign(new Error('x'), { code: 1 }) })
  const act = createUiTools({ binary: () => 'ad.exe', execFileImpl: exec.impl }).find((tool) => tool.name === 'ui_act')
  await assert.rejects(act.run({ action: 'click', ref }), (error) => error.message === envelope)
  assert.deepEqual(exec.calls[0].argv, ['click', '--', ref])
})

test('a tool returns the envelope as text', async () => {
  const stdout = '{"ok":true,"data":{"ref_count":2}}'
  const snapshot = createUiTools({ binary: () => 'ad.exe', execFileImpl: fakeExec({ stdout }).impl }).find((tool) => tool.name === 'ui_snapshot')
  assert.deepEqual(await snapshot.run({ app: 'calc' }), [{ type: 'text', text: stdout }])
})

test('the observing tools are read-only and the acting tool is not', () => {
  const tools = createUiTools()
  assert.deepEqual(tools.map((tool) => tool.name), ['ui_list', 'ui_snapshot', 'ui_find', 'ui_act'])
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.annotations?.readOnlyHint === true, tool.name !== 'ui_act', tool.name)
  }
})

test('the desktop MCP server lists the ui tools next to the pixel tools', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/desktop-mcp.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] })
  try {
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
    const { value } = await lines.next()
    const names = JSON.parse(value).result.tools.map((tool) => tool.name)
    for (const name of ['screenshot', 'click', 'ui_list', 'ui_snapshot', 'ui_find', 'ui_act']) assert.ok(names.includes(name), name)
  } finally {
    child.kill()
  }
})

test('the CLI state lives in its own folder under the app home', () => {
  const home = path.resolve('agent-desk-home')
  assert.equal(appPaths(home).desktopUiHome, path.join(home, 'desktop-ui'))
})

test('the desktop server keeps the CLI state in the app folder, and nothing changes without one', { skip: process.platform !== 'win32' }, () => {
  const desktop = (paths) => createMcpServerList({ paths, getSettings: () => ({ desktopTool: true }), getTeams: () => null })({ workspace: 'W' })
    .find((server) => server.name === 'desktop')
  const paths = appPaths(path.resolve('agent-desk-home'))
  assert.deepEqual(desktop(paths).env, [{ name: 'AGENT_DESKTOP_HOME', value: paths.desktopUiHome }])
  assert.deepEqual(desktop({}).env, [])
})
