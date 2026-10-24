import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

const read = (file) => fs.readFile(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8')

test('a dialog takes focus once when it opens, not again on every re-render', async () => {
  const code = await read('Modal.tsx')
  const modal = code.split('export function Modal(')[1].split('export function ConfirmDialog(')[0]
  const effect = modal.slice(modal.indexOf('useEffect('), modal.indexOf('return (\n    <div className="modal-backdrop"'))
  // Callers hand over a new onClose on each render. As an effect dependency it re-focused the
  // panel after every server update, which closed open menus and cut off typing.
  assert.doesNotMatch(effect, /\[onClose\]/)
  assert.match(effect, /\}, \[\]\)/)
  assert.match(modal, /close\.current = onClose/)
  assert.match(effect, /close\.current\(\)/)
  // `panel.current?.focus()` on open and `previous?.focus?.()` on close, nowhere else.
  assert.equal(effect.match(/focus\??\.?\(\)/g)?.length, 2)
})

test('the AB model fields use the app menu with plain model names, never a native select or a company suffix', async () => {
  const code = await read('Ab.tsx')
  assert.doesNotMatch(code, /<select|<option/)
  assert.match(code, /<Dropdown/)
  assert.match(code, /CLAUDE_CODE = \[\{ value: 'claude:opus', name: 'Opus' \}, \{ value: 'claude:sonnet', name: 'Sonnet' \}, \{ value: 'claude:haiku', name: 'Haiku' \}\]/)
  // The model's own name goes into the menu as it is; the heading says where it runs.
  assert.match(code, /<MenuItem key=\{model\.value\} label=\{model\.name\}/)
  assert.doesNotMatch(code, /\$\{model\.name\} ·/)
  assert.doesNotMatch(code, /Claude Code · /)
})
