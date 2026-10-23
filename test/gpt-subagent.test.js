import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { gptSubagentPatch, homePatch } from '../server/dsh-config.js'

test('the GPT subagent\'s layer runs the chosen GPT model, without subagent tools or their guidance', () => {
  const subagents = [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'openai-codex', model: 'gpt-6.1-sol' }]
  const persona = { personaPrefix: 'You are a coding agent.', personaSuffix: 'Your working directory is {{cwd}}.' }
  const rows = YAML.parse(gptSubagentPatch({ subagents, persona }))
  assert.deepEqual(rows[0], { id: 'agent-default-model', config: { provider: 'openai-codex', model: 'gpt-6.1-sol' } })
  const added = YAML.parse(homePatch({ subagents, persona })).flatMap((row) => row.insert ?? []).map((row) => row.id)
  for (const id of ['tool-subagent', 'tool-subagent-fork', ...added.filter((entry) => entry.startsWith('agent-desk-subagent-'))]) {
    assert.ok(rows.some((row) => row.id === id && row.disabled), id)
  }
  assert.deepEqual(rows.find((row) => row.id === 'system-prompt'), { id: 'system-prompt', config: persona })
})

test('no GPT subagent model, no layer', () => {
  assert.equal(gptSubagentPatch({ subagents: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }] }), null)
  assert.equal(gptSubagentPatch(), null)
})
