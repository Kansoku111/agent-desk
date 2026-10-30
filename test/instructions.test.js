import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { INSTRUCTIONS_PLUGIN, homePatch } from '../server/dsh-config.js'
import { SECTION_NAME, apply, instructionsSection } from '../server/instructions-plugin.js'
import { effectiveCustomInstructions } from '../server/settings.js'

test('the home patch loads the instructions plugin only when there is text', () => {
  const plain = YAML.parse(homePatch({ instructions: '  \n ' }))
  assert.ok(!plain.some((row) => row.insert?.some((entry) => entry.id === 'agent-desk-instructions')))

  const text = '日本語で答えて。\nkey: value\n- {{cwd}} はそのまま'
  const rows = YAML.parse(homePatch({ instructions: `\n${text}\n` }))
  assert.deepEqual(rows.at(-1).insert, [{ id: 'agent-desk-instructions', name: INSTRUCTIONS_PLUGIN, config: { text } }])
  assert.ok(INSTRUCTIONS_PLUGIN.startsWith('file:') && INSTRUCTIONS_PLUGIN.endsWith('/server/instructions-plugin.js'))
})

test('disabling saved instructions removes them from the home patch without deleting them', () => {
  const settings = { customInstructions: 'saved instructions', customInstructionsEnabled: false }
  const rows = YAML.parse(homePatch({ instructions: effectiveCustomInstructions(settings) }))
  assert.ok(!rows.some((row) => row.insert?.some((entry) => entry.id === 'agent-desk-instructions')))
  assert.equal(settings.customInstructions, 'saved instructions')
  settings.customInstructionsEnabled = true
  const enabled = YAML.parse(homePatch({ instructions: effectiveCustomInstructions(settings) }))
  assert.equal(enabled.at(-1).insert[0].config.text, 'saved instructions')
})

test('the plugin adds one literal section after the deployment persona', () => {
  const sections = []
  const systemPrompt = {
    getSectionOrder: (name) => ({ DEPLOYMENT_PERSONA_SUFFIX: 10200 })[name],
    section: (section) => sections.push(section),
  }
  apply({ systemPrompt }, { text: '' })
  assert.equal(sections.length, 0)

  apply({ systemPrompt }, { text: '回答は {{model}} を名乗らずに' })
  assert.equal(sections.length, 1)
  const [section] = sections
  assert.equal(section.name, SECTION_NAME)
  assert.ok(section.order > 10200)
  assert.equal(section.interpolate, false)
  assert.match(section.text, /<user_instructions>\n回答は \{\{model\}\} を名乗らずに\n<\/user_instructions>/)
})

test('the section is empty for blank or missing text', () => {
  assert.equal(instructionsSection(undefined), '')
  assert.equal(instructionsSection('   '), '')
})

test('the home patch turns the workflow tool off', () => {
  const rows = YAML.parse(homePatch())
  assert.ok(rows.some((row) => row.id === 'tool-workflow' && row.disabled === true))
})
