import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserUseCall, BROWSER_USE_TOOLS } from '../server/browser-use-mcp.js'
import { browserUseEnv } from '../server/browser-use.js'
import { createMcpServerList } from '../server/mcp-servers.js'
import { abToolAllowed } from '../server/ab-policy-plugin.js'
import { apply as applyPresetPolicy } from '../server/task-preset-policy-plugin.js'

test('mounts only the selected browser on normal and opted-in preset sessions', () => {
  const thread = { workspace: 'workspace', permissionMode: 'workspace-write' }
  const paths = { chromeState: 'state', chromeProfile: 'profile' }
  const settings = { browserTool: true }
  const deps = { paths, getSettings: () => settings, getTeams: () => null }
  const mount = createMcpServerList({ ...deps, browserUseCommand: process.execPath })
  const preset = { ...thread, preset: { browser: true } }
  const names = thread => mount(thread).map(server => server.name)
  assert.deepEqual(names(thread), ['chrome'])
  assert.deepEqual(names(preset), ['chrome'])
  settings.browserBackend = 'browser-use'
  settings.browserHeadless = true
  assert.deepEqual(names(thread), ['browser_use'])
  assert.deepEqual(names(preset), ['browser_use'])
  const browser = mount(thread)[0]
  assert.ok(browser.args.includes('--headless'))
  assert.deepEqual(browser.args.slice(-2), ['--browser-use', process.execPath])
  assert.deepEqual(names({ ...thread, preset: { browser: false } }), [])
  assert.deepEqual(names({ ...thread, permissionMode: 'chat-web' }), [])
  assert.deepEqual(names({ ...thread, ab: { writable: false } }), [])
  assert.deepEqual(createMcpServerList(deps)(thread), [])
  settings.browserTool = false
  assert.deepEqual(names(thread), [])
  assert.deepEqual(names(preset), [])
})

test('Browser Use advertises browser operations and rejects direct Python and cloud tools', () => {
  assert.deepEqual(BROWSER_USE_TOOLS.map(tool => tool.name), ['browser_action', 'browser_screenshot'])
  for (const name of ['browser_exec', 'browser_login']) assert.throws(() => browserUseCall({ name }))
  const action = args => browserUseCall({ name: 'browser_action', arguments: args })
  assert.throws(() => action({ action: 'navigate', url: 'file:///local.txt' }), /HTTP/)
  assert.throws(() => action({ action: 'read_page', code: 'exit()' }), /arguments/)
  assert.throws(() => action({ action: 'click', x: 1 }), /Invalid y/)
  const data = ['#item', '");\n__import__("os") # 日本語']
  const call = action({ action: 'fill', selector: data[0], text: data[1] })
  const [, decode, execute] = call.arguments.code.split('\n')
  assert.deepEqual(JSON.parse(JSON.parse(decode.slice('v = json.loads('.length, -1))), data)
  assert.equal(execute, 'print(fill_input(*v))')
  assert.deepEqual(browserUseEnv({ HOME: 'home', Path: 'path', OPENAI_API_KEY: 'key', BU_CDP_URL: 'remote', BROWSER_USE_API_KEY: 'key' }),
    { HOME: 'home', Path: 'path', ANONYMIZED_TELEMETRY: 'false', PYTHON_DOTENV_DISABLED: '1' })
})

test('the AB implementer and a delegated worker may call the browser of either backend', () => {
  let guard
  applyPresetPolicy({ tools: { guard: (fn) => { guard = fn } }, systemPrompt: { section() {} } })
  for (const name of ['mcp__chrome__take_snapshot', 'mcp__browser_use__browser_action']) {
    assert.equal(abToolAllowed(name, true), true, name)
    assert.equal(abToolAllowed(name, false), false, name)
    assert.equal(guard({ name }), undefined, name)
  }
  assert.ok(guard({ name: 'mcp__desktop__click' }))
})
