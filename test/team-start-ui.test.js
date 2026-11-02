import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

test('TM startup and running-team dialogs expose both model modes and the saved default', async () => {
  const code = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
  assert.match(code, /defaultModelMode.*free.*tiers/)
  assert.match(code, /モデルを選択/)
  assert.ok(code.includes('models.length >= MAX_CHILDREN'))
  assert.match(code, /checkable selected=/)
  assert.ok(code.includes('Array.isArray(value)'))
  assert.match(code, /<ModelField label=/)
  assert.match(code, /const groups = teamModelGroups\(server\)/)
  assert.match(code, /<TeamGuides .*modelGroups=\{teamModelGroups\(server\)\}/)
  assert.ok(code.includes('if (next === value) return'))
  assert.match(code, /modelMode: draft.modelMode, freeModels: draft.freeModels/)
  assert.ok(code.includes('<ChildModels server={server} config={draft} onChange={change} />'))
})

test('TM startup exposes the shared tool switch outside advanced settings and sends its draft', async () => {
  const code = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
  const dialog = code.split('export function TeamStartDialog(')[1].split('export function TeamConfigDialog(')[0]
  assert.match(dialog, /fullConfig\(server\.settings\.agentTeams\)/)
  assert.match(dialog, /<ChildCount config=\{draft\} onChange=\{change\} \/>\s*<LeanChildrenSwitch config=\{draft\} onChange=\{change\} \/>/)
  assert.ok(dialog.indexOf('<LeanChildrenSwitch') < dialog.indexOf('{details &&'))
  assert.match(dialog, /startTeam\(workspace, draft,/)
  assert.match(dialog, /<FallbackSummary server=\{server\}/)
  assert.doesNotMatch(dialog, /<LeaderFallback/)
  const toggle = code.split('function LeanChildrenSwitch(')[1].split('function Switch(')[0]
  assert.match(toggle, /checked=\{config\.leanChildren === true\}/)
  assert.match(toggle, /onChange=\{\(value\) => onChange\(\{ leanChildren: value \}\)\}/)
  const settings = code.split('export function TeamSettings(')[1]
  assert.match(settings, /<LeanChildrenSwitch config=\{config\} onChange=\{save\} \/>/)
})

test('設定 → エージェントチーム lists TM, AB and eco as closed sections', async () => {
  const settings = (await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')).split('export function TeamSettings(')[1]
  for (const mark of ['TM', 'AB', 'eco']) assert.match(settings, new RegExp(`<ModeSection mark="${mark}"`))
  const sections = await fs.readFile(new URL('../web/src/components/ModeSections.tsx', import.meta.url), 'utf8')
  assert.match(sections, /useState\(false\)/)
  assert.match(sections, /\{open && /)
})
