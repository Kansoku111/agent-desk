import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { observerPatch } from '../server/dsh-config.js'
import { apply, observerToolAllowed } from '../server/team-observer-policy.js'
import { RuntimePool, runtimeKey } from '../server/runtime.js'
import { createMcpServerList } from '../server/mcp-servers.js'
import { TeamManager } from '../server/teams.js'

test('observer runtime is separate and remains stopped until needed', () => {
  const pool = new RuntimePool({ paths: { teamChildPatch: 'child', observerPatch: 'observer' }, onUpdate() {}, onPermission() {} })
  assert.equal(runtimeKey({ team: { role: 'observer' }, permissionMode: 'read-only' }), 'team:observer')
  assert.equal(pool.runtimes.get('team:observer').state, 'stopped')
  assert.deepEqual(pool.runtimes.get('team:observer').patches, ['observer'])
  assert.equal(runtimeKey({ team: { role: 'leader' }, permissionMode: 'read-only' }), 'read-only')
})

test('only the owning observer mounts its own MCP capability', () => {
  const team = { id: 't', secret: 'leader-secret', observer: { id: 'observer-id', kind: 'thread', secret: 'observer-secret' } }
  const manager = Object.assign(Object.create(TeamManager.prototype), { teams: new Map([['t', team]]), node: process.execPath, apiUrl: () => 'http://127.0.0.1:1234/api/team' })
  const list = createMcpServerList({ paths: {}, getSettings: () => ({ browserTool: true, imageTool: true }), getTeams: () => manager })
  const thread = { id: 'observer-id', team: { id: 't', role: 'observer' } }
  const servers = list(thread)
  assert.equal(servers.length, 1)
  assert.equal(servers[0].name, 'observer')
  assert.equal(servers[0].env.find((item) => item.name === 'AGENT_DESK_OBSERVER_SECRET').value, 'observer-secret')
  assert.equal(servers[0].env.find((item) => item.name === 'AGENT_DESK_OBSERVER_URL').value, 'http://127.0.0.1:1234/api/team-observer')
  assert.throws(() => list({ ...thread, id: 'other' }), /確認できません/)
})

test('observer native runtime permits file readers and its four MCP tools, not mutation or execution', () => {
  for (const name of ['read', 'read_image', 'glob', 'grep', 'mcp__observer__status', 'mcp__observer__child_turns', 'mcp__observer__send', 'mcp__observer__stop']) assert.equal(observerToolAllowed(name), true, name)
  for (const name of ['run_code', 'write', 'edit', 'bash', 'pwsh', 'subagent', 'subagent_fork', 'create_goal', 'mcp__agent-team__spawn', 'mcp__observer__other']) assert.equal(observerToolAllowed(name), false, name)
  let guard
  apply({ tools: { guard: (fn) => { guard = fn } } })
  assert.equal(guard({ name: 'mcp__observer__status' }), undefined)
  for (const name of ['read', 'read_image', 'glob', 'grep']) assert.equal(guard({ name }), undefined, name)
  for (const name of ['write', 'edit', 'pwsh', 'run_code']) assert.match(guard({ name }), /unavailable/, name)
})

test('observer patch keeps read-only file tools and removes execution and delegation tools', () => {
  const rows = YAML.parse(observerPatch({ subagents: [{ provider: 'anthropic', model: 'model' }] }))
  const files = rows.find((row) => row.id === 'tool-fs')
  assert.deepEqual(files.config, { write: false, edit: false })
  assert.notEqual(files.disabled, true)
  assert.ok(!rows.some((row) => row.id === 'tool-fs-search' && row.disabled))
  for (const id of ['tool-bash', 'tool-pwsh', 'tool-web', 'tool-goal', 'tool-subagent', 'agent-desk-subagent-claude']) {
    assert.ok(rows.some((row) => row.id === id && row.disabled), id)
  }
  assert.ok(rows.some((row) => row.insert?.some((item) => item.id === 'agent-desk-observer-policy')))
  assert.ok(!rows.some((row) => row.insert?.some((item) => item.id === 'agent-desk-ab-policy')))
})
