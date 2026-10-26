import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch, TEAM_CHILD_PLUGIN, teamChildPatch } from '../server/dsh-config.js'
import { apply, SECTION_NAME, READ_ONLY_SECTION_NAME, READ_ONLY_PROMPT } from '../server/team-child-plugin.js'
import { childPrompt } from '../server/teams-prompts.js'
import { RuntimePool, runtimeKey } from '../server/runtime.js'

test('the team children\'s layer turns every subagent tool off and gives the child instructions', () => {
  const rows = YAML.parse(teamChildPatch())
  assert.deepEqual(rows.slice(0, -1), ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents'].map((id) => ({ id, disabled: true })))
  assert.deepEqual(rows.at(-1), { insert: [{ id: 'agent-desk-team-child', name: TEAM_CHILD_PLUGIN, config: { text: childPrompt() } }] })
  assert.match(childPrompt(), /^# Agent Desk team: you are a child agent\n/)
  assert.ok(TEAM_CHILD_PLUGIN.endsWith('/server/team-child-plugin.js'))
})

test('the child plugin adds its text as one literal section after the persona', () => {
  const sections = []
  const systemPrompt = { getSectionOrder: (name) => ({ DEPLOYMENT_PERSONA_SUFFIX: 10200 })[name], section: (section) => sections.push(section) }
  apply({ systemPrompt }, { text: ' ' })
  assert.equal(sections.length, 0)
  apply({ systemPrompt }, { text: childPrompt() })
  assert.deepEqual(sections, [{ name: SECTION_NAME, order: 10250, text: childPrompt(), interpolate: false }])
})

test('read-only child guidance comes from its own runtime, not leader messages', () => {
  const previous = process.env.DSH_PERMISSION_MODE
  try {
    for (const mode of ['read-only', 'danger-full-access']) {
      process.env.DSH_PERMISSION_MODE = mode
      const sections = []
      apply({ systemPrompt: { getSectionOrder: () => 10200, section: (section) => sections.push(section) } }, { text: childPrompt() })
      const readOnly = sections.find((section) => section.name === READ_ONLY_SECTION_NAME)
      if (mode === 'read-only') {
        assert.deepEqual(readOnly, { name: READ_ONLY_SECTION_NAME, order: 10251, text: READ_ONLY_PROMPT, interpolate: false })
        assert.match(readOnly.text, /independently of the leader's permissions/)
        assert.match(readOnly.text, /Omit sandbox_permissions and justification on run_code/)
        assert.match(readOnly.text, /do not retry escalation or work around the denial/)
        assert.match(readOnly.text, /separate mode: write child/)
      } else assert.equal(readOnly, undefined)
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_PERMISSION_MODE
    else process.env.DSH_PERMISSION_MODE = previous
  }
  assert.match(childPrompt(), /if this session permits file writes/)
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
