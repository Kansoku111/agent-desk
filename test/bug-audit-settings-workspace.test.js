import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import { selectedWorkspace } from '../web/src/workspace-choice.ts'

// Bug audit (調査04 C2): ClaudeWorkspace seeded its select from the choices present at
// mount. Choices that arrive later left the value empty, so the first option showed
// as selected while 設定 stayed disabled, and a single choice could not be picked.

const A = { id: 'wrkspc_a', name: 'A' }
const B = { id: 'wrkspc_b', name: 'B' }
const C = { id: 'wrkspc_c', name: 'C' }

test('choices that arrive after mounting select the first one', () => {
  // Mounted before the verify check answered: no choices, nothing saved.
  assert.equal(selectedWorkspace(null, null, null), '')
  // The check answered needs-workspace with a list.
  assert.equal(selectedWorkspace(null, null, [A, B]), 'wrkspc_a')
})

test('a single choice is selected, so 設定 can be used without picking again', () => {
  assert.equal(selectedWorkspace(null, null, [A]), 'wrkspc_a')
})

test('a choice the user already made survives later updates of the list', () => {
  assert.equal(selectedWorkspace('wrkspc_b', null, [A, B]), 'wrkspc_b')
  assert.equal(selectedWorkspace('wrkspc_b', null, [A, B, C]), 'wrkspc_b')
})

test('a saved workspace is kept when the list has it, and not shown when it does not', () => {
  assert.equal(selectedWorkspace(null, 'wrkspc_b', [A, B]), 'wrkspc_b')
  assert.equal(selectedWorkspace(null, 'wrkspc_x', [A, B]), 'wrkspc_a')
  assert.equal(selectedWorkspace('wrkspc_x', null, [A, B]), 'wrkspc_a')
})

test('the free-text field keeps what is typed, with or without an empty list', () => {
  assert.equal(selectedWorkspace('wrkspc_typed', null, null), 'wrkspc_typed')
  assert.equal(selectedWorkspace('wrkspc_typed', 'wrkspc_saved', []), 'wrkspc_typed')
  assert.equal(selectedWorkspace('', null, null), '')
  assert.equal(selectedWorkspace(null, 'wrkspc_saved', null), 'wrkspc_saved')
})

test('the workspace field derives its value from the helper instead of seeding state at mount', async () => {
  const code = await fs.readFile(new URL('../web/src/components/settings/AccountsSettings.tsx', import.meta.url), 'utf8')
  assert.match(code, /import \{ selectedWorkspace \} from '\.\.\/\.\.\/workspace-choice'/)
  assert.doesNotMatch(code, /useState\(current \?\? choices/)
  assert.match(code, /const value = selectedWorkspace\(picked, current, choices\)/)
})
