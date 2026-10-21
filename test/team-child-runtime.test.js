import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch, teamChildPatch } from '../server/dsh-config.js'
import { RuntimePool, runtimeKey } from '../server/runtime.js'

test('the team children\'s layer turns every subagent tool off', () => {
  const rows = YAML.parse(teamChildPatch())
  assert.deepEqual(rows, ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents'].map((id) => ({ id, disabled: true })))
})

test('the layer also removes the fixed-model tools the home patch adds, with their prompt section', () => {
  const subagents = [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'openai-codex', model: 'gpt-6.1-sol' }]
  const persona = { personaPrefix: 'You are a coding agent.', personaSuffix: 'Your working directory is {{cwd}}.' }
  const added = YAML.parse(homePatch({ subagents, persona })).flatMap((row) => row.insert ?? []).map((row) => row.id)
  const rows = YAML.parse(teamChildPatch({ subagents, persona }))
  for (const id of added.filter((entry) => entry.startsWith('agent-desk-subagent-'))) {
    assert.ok(rows.some((row) => row.id === id && row.disabled), id)
  }
  // The persona without the "Subagents on a fixed model" guidance.
  assert.deepEqual(rows.find((row) => row.id === 'system-prompt'), { id: 'system-prompt', config: persona })
})

test('team children run in runtimes of their own, which load the layer', () => {
  assert.equal(runtimeKey({ permissionMode: 'danger-full-access' }), 'danger-full-access')
  assert.equal(runtimeKey({ permissionMode: 'danger-full-access', team: { id: 't', role: 'leader' } }), 'danger-full-access')
  assert.equal(runtimeKey({ permissionMode: 'danger-full-access', team: { id: 't', childId: 'c' } }), 'team:danger-full-access')
  const pool = new RuntimePool({ paths: { teamChildPatch: 'C:\\home\\team-child.patch.yml' }, onUpdate: () => {}, onPermission: async () => ({}) })
  assert.deepEqual(pool.runtimes.get('danger-full-access').patches, [])
  const child = pool.runtimes.get('team:danger-full-access')
  assert.equal(child.mode, 'danger-full-access')
  assert.deepEqual(child.patches, ['C:\\home\\team-child.patch.yml'])
  // Settings show the users' runtimes only.
  assert.deepEqual(Object.keys(pool.status()), ['read-only', 'workspace-write', 'danger-full-access'])
})
