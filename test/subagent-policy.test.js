import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch, gptSubagentPatch, writeGptSubagentPatch } from '../server/dsh-config.js'
import { apply, subagentsAllowed } from '../server/subagent-policy-plugin.js'
import { DEFAULT_SETTINGS, migrateSettings, planSettingsUpdate, createSettingsService } from '../server/settings.js'

const subagents = [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'openai-codex', model: 'gpt-6.1-sol' }]

test('OFF removes all base delegation plugins, pinned tools and generated guidance, preserving other tools', () => {
  const options = { subagents, persona: { personaPrefix: 'Agent', personaSuffix: 'Workspace' }, webSearch: { plugin: 'search', credentials: 'keys' }, instructions: 'Keep this instruction' }
  const enabled = YAML.parse(homePatch(options))
  assert.ok(enabled.flatMap(row => row.insert ?? []).some(row => row.config?.toolName === 'subagent_gpt'))
  assert.match(homePatch(options), /Subagents on a fixed model/)
  const off = homePatch({ ...options, subagentsEnabled: false })
  const rows = YAML.parse(off)
  for (const id of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow']) {
    assert.ok(rows.some(row => row.id === id && row.disabled), id)
  }
  assert.equal(rows.flatMap(row => row.insert ?? []).some(row => row.config?.toolName?.startsWith('subagent')), false)
  assert.equal(rows.some(row => row.id === 'system-prompt'), false)
  assert.doesNotMatch(off, /Subagents on a fixed model|Delegate with your own/)
  assert.ok(rows.some(row => row.id === 'web'))
  assert.ok(rows.flatMap(row => row.insert ?? []).some(row => row.config?.text === 'Keep this instruction'))
  assert.equal(gptSubagentPatch({ subagents, subagentsEnabled: false }), null)
  // Turning it back on restores the saved model routes, not an empty picker.
  assert.deepEqual(YAML.parse(homePatch({ ...options, subagentsEnabled: true })), enabled)
})

test('setting defaults ON, validates booleans, preserves model choices and applies the home patch before restarting', async () => {
  assert.equal(migrateSettings({}).subagentsEnabled, true)
  assert.equal(migrateSettings({ subagentsEnabled: false }).subagentsEnabled, false)
  const current = { ...structuredClone(DEFAULT_SETTINGS), subagentModels: { anthropic: 'claude-sonnet-5-5', 'openai-codex': 'gpt-6.1-sol' } }
  for (const value of [null, 0, 'false', {}, []]) {
    assert.throws(() => planSettingsUpdate(current, { subagentsEnabled: value }, Date.now()), /boolean/)
  }
  const plan = planSettingsUpdate(current, { subagentsEnabled: false }, Date.now())
  assert.equal(plan.settings.subagentsEnabled, false)
  assert.deepEqual(plan.settings.subagentModels, current.subagentModels)
  assert.equal(plan.effects.homePatch, true)
  let live = current
  const events = []
  const service = createSettingsService({
    getSettings: () => live,
    saveSettings: async next => { events.push('save'); return next },
    publishSettings: next => { live = next; events.push('publish') },
    applyHomePatch: () => { events.push(`patch:${live.subagentsEnabled}`); return true },
    restartRuntimesWhenIdle: () => events.push('restart'),
  })
  await service.update({ subagentsEnabled: false })
  assert.deepEqual(events, ['save', 'publish', 'patch:false', 'restart'])
})

test('live gate rejects fresh starts after OFF but keeps running-child controls and ordinary tools usable', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-subagent-policy-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const settingsFile = path.join(dir, 'settings.json')
  let guard
  apply({ tools: { guard: fn => { guard = fn } } }, { settingsFile })
  assert.equal(subagentsAllowed(settingsFile), true)
  await fs.writeFile(settingsFile, JSON.stringify({ subagentsEnabled: false }))
  for (const name of ['subagent', 'subagent_fork', 'subagent_gpt', 'subagent_claude', 'workflow']) {
    assert.match(guard({ name }), /disabled/)
  }
  for (const name of ['read', 'list_agents', 'send_message', 'interrupt_agent']) assert.equal(guard({ name }), undefined)
  await fs.writeFile(settingsFile, JSON.stringify({ subagentsEnabled: true }))
  assert.equal(guard({ name: 'subagent' }), undefined)
  await fs.writeFile(settingsFile, 'broken JSON')
  assert.equal(subagentsAllowed(settingsFile), false)
})

test('OFF removes the Claude Code GPT subagent layer so an already launched MCP cannot start it', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-gpt-policy-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'gpt-subagent.patch.yml')
  assert.equal(await writeGptSubagentPatch(file, { subagents }), true)
  assert.equal(await writeGptSubagentPatch(file, { subagents, subagentsEnabled: false }), true)
  await assert.rejects(fs.stat(file), { code: 'ENOENT' })
})
