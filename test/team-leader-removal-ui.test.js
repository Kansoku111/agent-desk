import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

const read = (file) => fs.readFile(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8')

// Deleting a leader deletes the whole team. A Claude Code leader always asked first; a dsh leader
// was deleted at once, from the menu and from the Delete key.
test('every way to delete a team leader asks before it deletes the team', async () => {
  for (const [file, call] of [
    ['Sidebar.tsx', "act('thread.remove', { threadId: thread.id })"],
    ['ThreadView.tsx', "act('thread.remove', { threadId: thread.id })"],
    ['Sidebar.tsx', "act('terminal.remove', { terminalId: terminal.id })"],
    ['TerminalView.tsx', "act('terminal.remove', { terminalId: terminal.id })"],
  ]) {
    const source = await read(file)
    const direct = source.split(`void ${call}`).length - 1
    const guarded = source.split(`else void ${call}`).length - 1
    const confirmed = source.split(`onConfirm={() => void ${call}}`).length - 1
    assert.equal(guarded, 1, `${file}: the menu item deletes a task that leads no team`)
    assert.equal(confirmed, 1, `${file}: a team is deleted from the confirmation`)
    assert.equal(direct, 2, `${file}: no other path deletes without asking`)
  }
})
