import test from 'node:test'
import assert from 'node:assert/strict'
import YAML from 'yaml'
import { chatWebPatch } from '../server/dsh-config.js'
import { apply } from '../server/chat-web-policy.js'
import { RuntimePool, runtimeKey } from '../server/runtime.js'
import { createMcpServerList } from '../server/mcp-servers.js'

test('web-only mode has an isolated read-only runtime without MCPs', () => {
  const pool = new RuntimePool({ paths: { chatWebPatch: 'web.patch', teamChildPatch: 'child' }, onUpdate() {}, onPermission() {} })
  const runtime = pool.runtimes.get('chat-web')
  assert.equal(runtimeKey({ permissionMode: 'chat-web' }), 'chat-web')
  assert.equal(runtime.mode, 'read-only')
  assert.deepEqual(runtime.patches, ['web.patch'])
  const list = createMcpServerList({ paths: {}, getSettings: () => ({ browserTool: true, desktopTool: true, imageTool: true, historyTool: true }), getTeams: () => null })
  assert.deepEqual(list({ permissionMode: 'chat-web' }), [])
})

test('web-only patch removes tools and denies unexpected tool calls', () => {
  const rows = YAML.parse(chatWebPatch())
  for (const id of ['tool-fs', 'tool-fs-search', 'tool-bash', 'tool-pwsh', 'tool-working-directory', 'tool-skill', 'tool-goal', 'goal-round-driver', 'tool-subagent', 'agent-instructions']) {
    assert.ok(rows.some((row) => row.id === id && row.disabled), id)
  }
  assert.ok(!rows.some((row) => row.id === 'tool-web' && row.disabled))
  let guard
  apply({ tools: { guard: (fn) => { guard = fn } } })
  for (const name of ['web_search', 'web_fetch']) assert.equal(guard({ name }), undefined)
  for (const name of ['run_code', 'read', 'write', 'pwsh', 'mcp__chrome__click', 'future_tool']) assert.ok(guard({ name }), name)
})
