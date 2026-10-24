import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

test('TM startup exposes the shared tool switch outside advanced settings and sends its draft', async () => {
  const code = await fs.readFile(new URL('../web/src/components/TeamSettings.tsx', import.meta.url), 'utf8')
  const dialog = code.split('export function TeamStartDialog(')[1].split('export function TeamConfigDialog(')[0]
  assert.match(dialog, /fullConfig\(server\.settings\.agentTeams\)/)
  assert.match(dialog, /<ChildCount config=\{draft\} onChange=\{change\} \/>\s*<LeanChildrenSwitch config=\{draft\} onChange=\{change\} \/>/)
  assert.ok(dialog.indexOf('<LeanChildrenSwitch') < dialog.indexOf('{details &&'))
  assert.match(dialog, /startTeam\(workspace, draft,/)
  const toggle = code.split('function LeanChildrenSwitch(')[1].split('function Switch(')[0]
  assert.match(toggle, /checked=\{config\.leanChildren === true\}/)
  assert.match(toggle, /onChange=\{\(value\) => onChange\(\{ leanChildren: value \}\)\}/)
  const settings = code.split('export function TeamSettings(')[1]
  assert.match(settings, /<LeanChildrenSwitch config=\{config\} onChange=\{save\} \/>/)
})
